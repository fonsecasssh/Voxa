import express, { type NextFunction, type Request, type Response } from "express";
import { createServer as createHttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { Server as IOServer } from "socket.io";
import { hashPassword, verifyPassword } from "./auth.ts";
import type { DB } from "./db.ts";
import { FILE_URL_PREFIX, MAX_GROUP_DM, createStore, toFileAttachment, type Channel, type CustomStatus, type DmSummary, type FileKind, type PublicUser, type Store, type UserStatus } from "./store.ts";
import { registerRealtime } from "./realtime.ts";
import { createIceProvider, type IceProvider } from "./ice.ts";
import { failureLimiter, rateLimit } from "./rateLimit.ts";
import { HttpError, str } from "./http.ts";
import { registerAdminRoutes } from "./admin.ts";
import { Permission, can, permissionsOf } from "../../shared/permissions.ts";
import { findMentions } from "../../shared/markdown.ts";
import type { Gif, GifProvider } from "./gifs.ts";
import { actionMail, type Mailer } from "./mail.ts";
import type { Sfu } from "./livekit.ts";
import type { PushSender } from "./push.ts";
import type { Unfurler } from "./unfurl.ts";
import { createNotifier, type Notifier } from "./notify.ts";
import { CLIP_MIME, CLIP_URL_PREFIX, IMAGE_KINDS, IMAGE_MIME, createClipStore, createMediaStore, detectImageType, imageUrlPrefix } from "./media.ts";
import { tmpdir } from "node:os";

// Express's Request carries the authenticated user after `requireAuth`.
declare module "express-serve-static-core" {
  interface Request {
    user?: PublicUser;
    token?: string;
  }
}

const USERNAME_RE = /^[a-zA-Z0-9_.]{3,32}$/;
const STATUSES: UserStatus[] = ["online", "idle", "dnd", "invisible"];

function bearer(req: Request): string | null {
  const h = req.headers.authorization;
  return h?.startsWith("Bearer ") ? h.slice(7) : null;
}

/** Largest chat attachment, and how many go with one message. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_FILES_PER_MESSAGE = 10;
export const MAX_REACTION_KINDS = 20;

/** One emoji (with its modifiers and joiners): a picture, a flag or a keycap, never plain text. */
/** A server's emoji in a message or reaction: <:name:id>, or <a:name:id> when animated. */
export const CUSTOM_EMOJI = /^<a?:([a-zA-Z0-9_]{2,32}):([0-9a-f-]{36})>$/;

export function isEmoji(s: string): boolean {
  return s.length > 0 && s.length <= 32 && !/[\s<>]/.test(s) && /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[#*0-9]\uFE0F?\u20E3)/u.test(s) && !/[\p{L}\p{N}]{2}/u.test(s);
}

/** A file name safe to show and to put in a download header: no folders, no control characters. */
function fileName(raw: unknown): string {
  const name = (typeof raw === "string" ? raw : "")
    .replace(/[\u0000-\u001f\u007f/\\]/g, "")
    .trim()
    .slice(0, 120);
  return name && name !== "." && name !== ".." ? name : "arquivo";
}

export interface AppOptions {
  db: DB;
  /** Directory with the built web app, served in production. */
  webDist?: string;
  ice?: IceProvider;
  /** Number of reverse proxies in front of the app, so req.ip is the client's address. */
  trustProxy?: number;
  /** Signups allowed per IP per hour; 0 turns the limit off. Defaults to 20 when trustProxy is set. */
  signupsPerHour?: number;
  /** Where uploaded images and clips are stored (a temporary directory when not given, e.g. in tests). */
  mediaDir?: string;
  /** Total size the clips may take on disk; the oldest are deleted beyond it. */
  clipsMaxBytes?: number;
  /** Largest single clip accepted. */
  maxClipBytes?: number;
  /** Total size chat attachments may take on disk; the oldest are deleted beyond it. */
  filesMaxBytes?: number;
  /** GIF search for the chat (GIPHY); null turns the GIF tab off. */
  gifs?: GifProvider | null;
  /** Fetches link previews; null turns them off. */
  unfurler?: Unfurler | null;
  /** Push notifications to devices where Voxa is closed; null turns them off. */
  push?: PushSender | null | ((store: Store) => PushSender | null);
  /** Media server for calls (LiveKit); null = peer-to-peer mesh. */
  sfu?: Sfu | null;
  /** Sends e-mail (confirming addresses, password resets); null turns those off. */
  mailer?: Mailer | null;
  /** The site's public address, for links in e-mails (never taken from the request: it could be forged). */
  appUrl?: string | null;
}

export function createApp({ db, webDist, ice = createIceProvider(), trustProxy = 0, signupsPerHour, mediaDir, clipsMaxBytes, maxClipBytes, filesMaxBytes, gifs = null, mailer = null, appUrl = null, sfu = null, push: pushOption = null, unfurler = null }: AppOptions) {
  /** E-mail works only with both a way to send it and an address to link back to. */
  const mail = mailer && appUrl ? { mailer, url: appUrl.replace(/\/+$/, "") } : null;
  const mediaRoot = mediaDir ?? path.join(tmpdir(), `voxa-media-${process.pid}`);
  const media = createMediaStore(mediaRoot);
  const clips = createClipStore(path.join(mediaRoot, "clips"), clipsMaxBytes ?? 400 * 1024 * 1024, maxClipBytes);
  const files = createClipStore(path.join(mediaRoot, "files"), filesMaxBytes ?? 300 * 1024 * 1024, MAX_FILE_BYTES, "O arquivo");
  const store: Store = createStore(db);
  const app = express();
  const http = createHttpServer(app);
  // The site, its API and the socket share one origin (the desktop app loads that same site), so no CORS.
  const io = new IOServer(http);
  const push = typeof pushOption === "function" ? pushOption(store) : pushOption;
  // Created right below: the ring hook only runs once people are connected.
  let notifier: Notifier;
  const realtime = registerRealtime(io, store, sfu, (channelId, from, userIds) => notifier.ring(channelId, from, userIds));
  notifier = createNotifier(store, realtime.isOnline, push);

  app.set("trust proxy", trustProxy);
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Permissions-Policy", "camera=(self), microphone=(self), display-capture=(self), geolocation=()");
    if (req.secure) res.setHeader("Strict-Transport-Security", "max-age=31536000");
    next();
  });
  app.use(express.json({ limit: "100kb" }));

  // Uploaded images. File names contain a content hash, so they can be cached forever.
  for (const kind of IMAGE_KINDS) {
    app.use(
      imageUrlPrefix(kind).slice(0, -1),
      express.static(media.dirs[kind], { immutable: true, maxAge: "1y", index: false, dotfiles: "deny", fallthrough: false }),
    );
  }
  // Chat attachments, at /media/files/<id>/<name>. Only images and videos (recognized by their
  // bytes) display inline; anything else is a download, and none of it can run as a page.
  app.get(`${FILE_URL_PREFIX}:id/:name`, (req, res) => {
    const u = store.uploadById(req.params.id as string);
    if (!u || u.expired) throw new HttpError(404, "Arquivo não encontrado.");
    const inline = u.kind === "image" || u.kind === "video";
    res.setHeader("Content-Type", inline ? u.mime : "application/octet-stream");
    res.setHeader("Content-Disposition", `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(u.name)}`);
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.sendFile(path.join(files.dir, u.id), { dotfiles: "deny", headers: { "Content-Type": inline ? u.mime : "application/octet-stream" } }, (err) => {
      if (err && !res.headersSent) res.status(404).end();
    });
  });

  // Clips are named after their message, so they never change either (static supports Range, for seeking).
  app.use(
    CLIP_URL_PREFIX.slice(0, -1),
    express.static(clips.dir, { immutable: true, maxAge: "1y", index: false, dotfiles: "deny", fallthrough: false }),
  );

  app.get("/api/health", (req, res) => {
    db.prepare("SELECT 1").get();
    // `ip` is the caller's own address as the server sees it: compare it with your real IP to
    // check that TRUST_PROXY matches the number of proxies in front of the app.
    res.json({ ok: true, ip: req.ip });
  });

  // Password guessing: failures are counted per account, which works no matter how many
  // proxies sit in front of the app. Signup spam is limited per IP, but only when the
  // proxy count is configured — otherwise every user would share the proxy's address.
  const loginFailures = failureLimiter({ windowMs: 15 * 60_000, max: 10 });
  const maxSignups = signupsPerHour ?? (trustProxy > 0 ? 20 : 0);
  const signupLimit =
    maxSignups > 0
      ? rateLimit({ windowMs: 60 * 60_000, max: maxSignups, message: "Muitos cadastros a partir da sua rede. Tente mais tarde." })
      : (_req: Request, _res: Response, next: NextFunction) => next();

  const requireAuth = (req: Request, _res: Response, next: NextFunction) => {
    const token = bearer(req);
    const user = token ? store.userForToken(token) : null;
    if (!user) throw new HttpError(401, "Sessão inválida. Entre novamente.");
    req.user = user;
    req.token = token!;
    next();
  };

  const requireMember = (req: Request, serverId: string) => {
    const server = store.serverById(serverId);
    if (!server || !store.isMember(server.id, req.user!.id)) throw new HttpError(404, "Servidor não encontrado.");
    return server;
  };

  const requireChannelAccess = (req: Request, channelId: string) => {
    const channel = store.channelById(channelId);
    if (!channel || !realtime.canAccess(channel, req.user!.id)) throw new HttpError(404, "Canal não encontrado.");
    return channel;
  };

  /** Tells both users how their relationship now looks from their own side. */
  const emitFriendUpdate = (a: PublicUser, b: PublicUser) => {
    for (const [me, other] of [
      [a, b],
      [b, a],
    ]) {
      const f = store.friendship(me.id, other.id);
      const state = !f ? null : f.status === "accepted" ? "accepted" : f.requesterId === me.id ? "outgoing" : "incoming";
      io.to(`user:${me.id}`).emit("friend:update", {
        user: other,
        state,
        presence: state === "accepted" ? realtime.presenceOf(other.id) : null,
      });
    }
  };

  const dmFor = (summary: { channel: DmSummary["channel"] }, viewer: string): DmSummary => store.dmFor(summary.channel.id, viewer)!;

  /** A group DM the user is in (404 otherwise, like a channel they can't see). */
  const requireGroup = (req: Request) => {
    const channel = requireChannelAccess(req, req.params.id as string);
    const group = store.groupDm(channel.id);
    if (!group) throw new HttpError(404, "Grupo não encontrado.");
    return { channel, group, people: store.dmParticipants(channel.id)! };
  };

  /** Everyone in a group DM gets the conversation as they see it. */
  const emitDmUpdate = (channelId: string) => {
    for (const id of store.dmParticipants(channelId) ?? []) io.to(`user:${id}`).emit("dm:update", dmFor({ channel: { id: channelId } as DmSummary["channel"] }, id));
  };

  const groupName = (v: unknown): string | null => {
    if (v === undefined || v === null || v === "") return null;
    if (typeof v !== "string" || v.trim().length > 100) throw new HttpError(400, "O nome do grupo pode ter até 100 caracteres.");
    return v.trim() || null;
  };

  // --- auth -----------------------------------------------------------------
  app.post("/api/auth/register", signupLimit, async (req, res) => {
    const username = str(req.body?.username, "usuário", 3, 32);
    if (!USERNAME_RE.test(username)) throw new HttpError(400, "Usuário pode ter só letras, números, _ e ponto.");
    const password = str(req.body?.password, "senha", 8, 200);
    const displayName = req.body?.displayName ? str(req.body.displayName, "nome", 1, 32) : username;
    if (store.usernameTaken(username)) throw new HttpError(409, "Esse usuário já existe.");
    const user = store.createUser(username, displayName, await hashPassword(password));
    res.status(201).json({ token: store.createSession(user.id), user });
  });

  app.post("/api/auth/login", async (req, res) => {
    const username = str(req.body?.username, "usuário", 1, 32);
    const password = str(req.body?.password, "senha", 1, 200);
    const key = username.toLowerCase();
    const wait = loginFailures.blockedFor(key);
    if (wait) {
      res.setHeader("Retry-After", wait);
      throw new HttpError(429, `Muitas tentativas erradas. Tente de novo em ${Math.ceil(wait / 60)} min.`);
    }
    const found = store.findUserForLogin(username);
    if (!found || !(await verifyPassword(password, found.passwordHash))) {
      loginFailures.fail(key);
      throw new HttpError(401, "Usuário ou senha incorretos.");
    }
    loginFailures.succeed(key);
    const { passwordHash: _, ...user } = found;
    res.json({ token: store.createSession(user.id), user });
  });

  // --- e-mail and forgotten passwords ------------------------------------------
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const VERIFY_TTL = 24 * 3_600_000;
  const RESET_TTL = 3_600_000;
  const forgotLimit = rateLimit({ windowMs: 15 * 60_000, max: 5, message: "Muitos pedidos. Tente de novo em alguns minutos." });
  const tokenLimit = rateLimit({ windowMs: 15 * 60_000, max: 30, message: "Muitas tentativas. Tente de novo em alguns minutos." });
  const requireMail = () => {
    if (!mail) throw new HttpError(503, "O envio de e-mails não está configurado neste servidor.");
    return mail;
  };

  // Public: whether "Esqueci minha senha" can work here.
  app.get("/api/auth/options", (_req, res) => {
    res.json({ passwordReset: !!mail });
  });

  // Asks for a reset link. The answer is the same whether or not the account exists.
  app.post("/api/auth/forgot", forgotLimit, async (req, res) => {
    const { mailer: m, url } = requireMail();
    const login = str(req.body?.login, "usuário ou e-mail", 1, 254);
    const user = store.userByLogin(login);
    if (user?.email) {
      const token = store.createEmailToken(user.id, "reset", user.email, RESET_TTL);
      await m
        .send(
          actionMail(
            user.email,
            "Redefinir sua senha do Voxa",
            `Alguém (talvez você) pediu para redefinir a senha da conta @${user.username}.`,
            "Escolher uma nova senha",
            `${url}/reset/${token}`,
            "O link vale por 1 hora. Se não foi você, ignore este e-mail: sua senha continua a mesma.",
          ),
        )
        .catch((err) => console.error("falha ao enviar e-mail:", err));
    }
    res.json({ ok: true });
  });

  app.post("/api/auth/reset", tokenLimit, async (req, res) => {
    const token = str(req.body?.token, "link", 1, 200);
    const password = str(req.body?.password, "senha", 8, 200);
    const found = store.consumeEmailToken(token, "reset");
    const user = found && store.userById(found.userId);
    if (!user) throw new HttpError(400, "Este link expirou ou já foi usado. Peça um novo.");
    // Signs out everywhere (whoever knew the old password is out) and in here.
    res.json({ token: store.resetPassword(user.id, await hashPassword(password)), user });
  });

  app.put("/api/me/email", requireAuth, async (req, res) => {
    const { mailer: m, url } = requireMail();
    const email = str(req.body?.email, "e-mail", 3, 254).trim();
    if (!EMAIL_RE.test(email)) throw new HttpError(400, "E-mail inválido.");
    const hash = store.passwordHash(req.user!.id);
    if (!hash || !(await verifyPassword(str(req.body?.password, "senha", 1, 200), hash))) throw new HttpError(400, "Senha incorreta.");
    const token = store.createEmailToken(req.user!.id, "verify", email, VERIFY_TTL);
    try {
      await m.send(
        actionMail(
          email,
          "Confirme seu e-mail no Voxa",
          `Confirme este endereço para poder recuperar a senha da conta @${req.user!.username} se esquecê-la.`,
          "Confirmar e-mail",
          `${url}/verify-email/${token}`,
          "O link vale por 24 horas. Se você não pediu isso, ignore este e-mail.",
        ),
      );
    } catch (err) {
      console.error("falha ao enviar e-mail:", err);
      throw new HttpError(502, "Não foi possível enviar o e-mail. Tente mais tarde.");
    }
    res.json({ pending: email });
  });

  app.delete("/api/me/email", requireAuth, (req, res) => {
    store.setEmail(req.user!.id, null);
    res.status(204).end();
  });

  // The link in the confirmation e-mail (no login needed: the token proves it).
  app.post("/api/auth/verify-email", tokenLimit, (req, res) => {
    const found = store.consumeEmailToken(str(req.body?.token, "link", 1, 200), "verify");
    if (!found) throw new HttpError(400, "Este link expirou ou já foi usado.");
    if (!store.setEmail(found.userId, found.email)) throw new HttpError(409, "Esse e-mail já está em outra conta.");
    res.json({ email: found.email });
  });

  // --- notification settings -----------------------------------------------------
  // For a server, a channel or a DM: level (all / mentions / none, null = default) and mute.
  app.put("/api/notify/:targetId", requireAuth, (req, res) => {
    const me = req.user!.id;
    const target = req.params.targetId as string;
    const channel = store.channelById(target);
    const ok = channel ? store.canViewChannel(channel, me) : !!store.serverById(target) && store.isMember(target, me);
    if (!ok) throw new HttpError(404, "Não encontrado.");
    const level = req.body?.level ?? null;
    if (level !== null && !["all", "mentions", "none"].includes(level)) throw new HttpError(400, "Nível de notificação inválido.");
    const mutedUntil = req.body?.mutedUntil ?? null;
    if (mutedUntil !== null && (typeof mutedUntil !== "number" || mutedUntil < 0)) throw new HttpError(400, "Duração inválida.");
    store.setNotify(me, target, level, mutedUntil);
    const notify = store.notifySettings(me);
    io.to(`user:${me}`).emit("notify:update", notify);
    res.json({ notify });
  });

  // --- blocking ----------------------------------------------------------------------
  app.get("/api/blocks", requireAuth, (req, res) => {
    res.json({ users: store.blockedUsers(req.user!.id) });
  });

  // Blocking ends a friendship (or request) and stops DMs, requests and calls between you.
  app.put("/api/blocks/:userId", requireAuth, (req, res) => {
    const me = req.user!;
    const other = store.userById(req.params.userId as string);
    if (!other || other.id === me.id) throw new HttpError(404, "Usuário não encontrado.");
    store.block(me.id, other.id);
    if (store.removeFriendship(me.id, other.id)) emitFriendUpdate(me, other);
    io.to(`user:${me.id}`).emit("blocks:update", { blocked: store.blockedIds(me.id) });
    res.status(204).end();
  });

  app.delete("/api/blocks/:userId", requireAuth, (req, res) => {
    const me = req.user!.id;
    store.unblock(me, req.params.userId as string);
    io.to(`user:${me}`).emit("blocks:update", { blocked: store.blockedIds(me) });
    res.status(204).end();
  });

  // --- push notifications --------------------------------------------------------------
  app.get("/api/push/key", requireAuth, (_req, res) => {
    if (!push) throw new HttpError(404, "Notificações push não estão ativadas neste servidor.");
    res.json({ publicKey: push.publicKey });
  });

  app.post("/api/push/subscribe", requireAuth, (req, res) => {
    if (!push) throw new HttpError(404, "Notificações push não estão ativadas neste servidor.");
    const endpoint = str(req.body?.endpoint, "endereço", 10, 1000);
    if (!/^https:\/\//.test(endpoint)) throw new HttpError(400, "Endereço de notificação inválido.");
    const p256dh = str(req.body?.keys?.p256dh, "chave", 10, 200);
    const auth = str(req.body?.keys?.auth, "chave", 10, 100);
    store.addPushSubscription(req.user!.id, { endpoint, p256dh, auth });
    res.status(204).end();
  });

  app.delete("/api/push/subscribe", requireAuth, (req, res) => {
    store.removePushSubscription(str(req.body?.endpoint, "endereço", 1, 1000), req.user!.id);
    res.status(204).end();
  });

  app.post("/api/auth/logout", requireAuth, (req, res) => {
    store.deleteSession(req.token!);
    res.status(204).end();
  });

  app.get("/api/me", requireAuth, (req, res) => {
    const me = req.user!.id;
    res.json({
      user: req.user,
      email: store.emailOf(me),
      servers: store.serversForUser(me),
      status: store.getStatus(me),
      activity: store.getActivity(me),
      customStatus: store.getCustomStatus(me),
      // What this server has turned on, so the app can show or hide it.
      features: { gifs: !!gifs, email: !!mail, push: !!push },
      unread: store.unreadFor(me, [
        ...store.serversForUser(me).flatMap((s) => store.visibleChannels(s.id, me)),
        ...store.dmsForUser(me).map((d) => d.channel),
      ]),
      notify: store.notifySettings(me),
      blocked: store.blockedIds(me),
    });
  });

  // GIF search (trending when there's no query). Results are cached briefly: the picker asks often.
  const gifLimit = rateLimit({ windowMs: 60_000, max: 60, message: "Muitas buscas de GIF. Espere um pouco." });
  const gifCache = new Map<string, { at: number; gifs: Gif[] }>();
  app.get("/api/gifs", requireAuth, gifLimit, async (req, res) => {
    if (!gifs) throw new HttpError(404, "A busca de GIFs não está ativada neste servidor.");
    const query = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 50) : "";
    const offset = Math.min(Math.max(Math.floor(Number(req.query.offset) || 0), 0), 480);
    const key = `${query.toLowerCase()}|${offset}`;
    const hit = gifCache.get(key);
    if (hit && Date.now() - hit.at < 5 * 60_000) return void res.json({ gifs: hit.gifs });
    let list: Gif[];
    try {
      list = query ? await gifs.search(query, offset) : await gifs.trending(offset);
    } catch {
      throw new HttpError(502, "Não foi possível buscar GIFs agora.");
    }
    if (gifCache.size > 500) gifCache.clear();
    gifCache.set(key, { at: Date.now(), gifs: list });
    res.json({ gifs: list });
  });

  app.patch("/api/me/presence", requireAuth, (req, res) => {
    const me = req.user!.id;
    const { status, activity, custom } = req.body ?? {};
    if (status !== undefined) {
      if (!STATUSES.includes(status)) throw new HttpError(400, "Status inválido.");
      store.setStatus(me, status);
    }
    // Checked before anything changes, so a bad one changes nothing.
    const customStatus = custom === undefined ? undefined : parseCustomStatus(me, custom);
    if (activity !== undefined) realtime.setActivity(me, activity === null || activity === "" ? null : str(activity, "atividade", 1, 128));
    if (customStatus !== undefined) realtime.setCustomStatus(me, customStatus);
    if (activity === undefined && customStatus === undefined) realtime.broadcastPresence(me);
    res.json({ status: store.getStatus(me), presence: realtime.presenceOf(me), customStatus: store.getCustomStatus(me) });
  });

  /** A custom status from the request: text and/or an emoji (one of the user's custom ones, or unicode). */
  function parseCustomStatus(userId: string, body: unknown): CustomStatus | null {
    if (body === null) return null;
    if (typeof body !== "object") throw new HttpError(400, "Status personalizado inválido.");
    const { text, emoji, expiresAt } = body as Record<string, unknown>;
    const t = text === undefined || text === null || (typeof text === "string" && !text.trim()) ? null : str(text, "status", 1, 128);
    let e: string | null = null;
    if (emoji !== undefined && emoji !== null && emoji !== "") {
      if (typeof emoji !== "string") throw new HttpError(400, "Emoji inválido.");
      const m = CUSTOM_EMOJI.exec(emoji);
      if (m) {
        if (!store.emojisForUser(userId).some((x) => x.id === m[2])) throw new HttpError(400, "Emoji desconhecido.");
      } else if (!isEmoji(emoji)) {
        throw new HttpError(400, "Emoji inválido.");
      }
      e = emoji;
    }
    if (expiresAt !== undefined && expiresAt !== null && (typeof expiresAt !== "number" || !Number.isFinite(expiresAt) || expiresAt <= Date.now())) {
      throw new HttpError(400, "Data de expiração inválida.");
    }
    if (!t && !e) return null;
    return { text: t, emoji: e, expiresAt: (expiresAt as number | null | undefined) ?? null };
  }

  // --- friends ----------------------------------------------------------------
  app.get("/api/friends", requireAuth, (req, res) => {
    const friends = store.friendsOf(req.user!.id);
    res.json({
      friends,
      presence: realtime.presenceMap(friends.filter((f) => f.state === "accepted").map((f) => f.user.id)),
    });
  });

  app.post("/api/friends", requireAuth, (req, res) => {
    const me = req.user!;
    const target = store.userByUsername(str(req.body?.username, "usuário", 1, 32).replace(/^@/, ""));
    if (!target) throw new HttpError(404, "Não encontramos ninguém com esse usuário.");
    if (target.id === me.id) throw new HttpError(400, "Você não pode adicionar a si mesmo.");
    if (store.blockedBetween(me.id, target.id)) throw new HttpError(403, "Não foi possível enviar o pedido de amizade.");
    const f = store.friendship(me.id, target.id);
    if (f?.status === "accepted") throw new HttpError(409, "Vocês já são amigos.");
    if (f?.requesterId === me.id) throw new HttpError(409, "Você já enviou um pedido para essa pessoa.");
    // They had already asked us: sending one back simply accepts it.
    if (f) store.acceptFriend(me.id, target.id);
    else store.requestFriend(me.id, target.id);
    emitFriendUpdate(me, target);
    res.status(201).json({ state: f ? "accepted" : "outgoing", user: target });
  });

  app.post("/api/friends/:userId/accept", requireAuth, (req, res) => {
    const me = req.user!;
    const other = store.userById(req.params.userId as string);
    const f = other && store.friendship(me.id, other.id);
    if (!other || !f || f.status !== "pending" || f.requesterId !== other.id) {
      throw new HttpError(404, "Pedido de amizade não encontrado.");
    }
    store.acceptFriend(me.id, other.id);
    emitFriendUpdate(me, other);
    res.json({ state: "accepted" });
  });

  app.delete("/api/friends/:userId", requireAuth, (req, res) => {
    const me = req.user!;
    const other = store.userById(req.params.userId as string);
    if (!other || !store.removeFriendship(me.id, other.id)) throw new HttpError(404, "Amizade não encontrada.");
    emitFriendUpdate(me, other);
    res.status(204).end();
  });

  // --- direct messages ----------------------------------------------------------
  app.get("/api/dms", requireAuth, (req, res) => {
    const dms = store.dmsForUser(req.user!.id);
    res.json({
      dms,
      presence: realtime.presenceMap([...new Set(dms.flatMap((d) => d.members.map((u) => u.id)))]),
      calls: realtime.dmCalls(dms.map((d) => d.channel.id)),
    });
  });

  // Group DMs: you can start one with (and add) your friends, up to 10 people in all.
  app.post("/api/dms/group", requireAuth, (req, res) => {
    const me = req.user!;
    const raw: unknown = req.body?.userIds;
    if (!Array.isArray(raw) || raw.length === 0 || !raw.every((x) => typeof x === "string")) throw new HttpError(400, "Escolha quem vai participar.");
    const ids = [...new Set(raw as string[])].filter((id) => id !== me.id);
    if (ids.length === 0) throw new HttpError(400, "Escolha quem vai participar.");
    if (ids.length + 1 > MAX_GROUP_DM) throw new HttpError(400, `Um grupo pode ter até ${MAX_GROUP_DM} pessoas.`);
    for (const id of ids) {
      if (store.friendship(me.id, id)?.status !== "accepted") throw new HttpError(403, "Só dá para adicionar amigos ao grupo.");
    }
    const channel = store.createGroupDm(me.id, ids, groupName(req.body?.name));
    for (const id of [me.id, ...ids]) io.to(`user:${id}`).emit("dm:new", dmFor({ channel }, id));
    res.status(201).json({ dm: dmFor({ channel }, me.id) });
  });

  app.patch("/api/dms/:id", requireAuth, (req, res) => {
    const { channel } = requireGroup(req);
    store.renameGroupDm(channel.id, groupName(req.body?.name));
    emitDmUpdate(channel.id);
    res.json({ dm: dmFor({ channel }, req.user!.id) });
  });

  app.post("/api/dms/:id/members", requireAuth, (req, res) => {
    const me = req.user!;
    const { channel, people } = requireGroup(req);
    const other = typeof req.body?.userId === "string" ? store.userById(req.body.userId) : null;
    if (!other || store.friendship(me.id, other.id)?.status !== "accepted") throw new HttpError(403, "Só dá para adicionar amigos ao grupo.");
    if (people.some((id) => store.blockedBetween(id, other.id))) throw new HttpError(403, "Não foi possível adicionar essa pessoa ao grupo.");
    if (people.includes(other.id)) return void res.json({ dm: dmFor({ channel }, me.id) });
    if (people.length >= MAX_GROUP_DM) throw new HttpError(400, `Um grupo pode ter até ${MAX_GROUP_DM} pessoas.`);
    store.addDmMember(channel.id, other.id);
    io.to(`user:${other.id}`).emit("dm:new", dmFor({ channel }, other.id));
    emitDmUpdate(channel.id);
    realtime.refreshCall(channel.id);
    res.json({ dm: dmFor({ channel }, me.id) });
  });

  // Leave (yourself) or, for the owner, remove someone.
  app.delete("/api/dms/:id/members/:userId", requireAuth, (req, res) => {
    const me = req.user!;
    const { channel, group, people } = requireGroup(req);
    const target = req.params.userId as string;
    if (!people.includes(target)) throw new HttpError(404, "Essa pessoa não está no grupo.");
    if (target !== me.id && group.ownerId !== me.id) throw new HttpError(403, "Só o dono do grupo pode remover pessoas.");
    realtime.evictFromCall(target, channel.id, target === me.id ? "Você saiu do grupo." : "Você foi removido do grupo.");
    const result = store.removeDmMember(channel.id, target);
    io.to(`user:${target}`).emit("dm:remove", { channelId: channel.id });
    if (result === "removed") {
      emitDmUpdate(channel.id);
      realtime.refreshCall(channel.id);
    }
    res.status(204).end();
  });

  app.post("/api/dms", requireAuth, (req, res) => {
    const me = req.user!;
    const other = typeof req.body?.userId === "string" ? store.userById(req.body.userId) : null;
    if (!other || other.id === me.id) throw new HttpError(404, "Usuário não encontrado.");
    if (store.blockedBetween(me.id, other.id)) throw new HttpError(403, "Não é possível conversar com essa pessoa.");
    // Like Discord: you can message friends and people you share a server with.
    if (store.friendship(me.id, other.id)?.status !== "accepted" && !store.sharesServer(me.id, other.id)) {
      throw new HttpError(403, "Vocês precisam ser amigos ou estar no mesmo servidor.");
    }
    const { channel, created } = store.openDm(me.id, other.id);
    if (created) {
      for (const id of [me.id, other.id]) io.to(`user:${id}`).emit("dm:new", dmFor({ channel }, id));
    }
    res.status(created ? 201 : 200).json({ dm: dmFor({ channel }, me.id) });
  });

  // --- servers --------------------------------------------------------------
  app.post("/api/servers", requireAuth, (req, res) => {
    const name = str(req.body?.name, "nome", 1, 100);
    const { server, channels, categories, roles, inviteCode } = store.createServer(req.user!.id, name);
    io.in(`user:${req.user!.id}`).socketsJoin(`server:${server.id}`);
    res.status(201).json({ server, channels, categories, roles, inviteCode });
  });

  // A custom emoji's picture, by id (public: emojis show wherever they're used).
  app.get("/api/emojis/:id/image", (req, res) => {
    const emoji = store.emojiById(req.params.id as string);
    if (!emoji) throw new HttpError(404, "Emoji não encontrado.");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.redirect(302, imageUrlPrefix("emoji") + emoji.file);
  });

  app.get("/api/me/emojis", requireAuth, (req, res) => {
    res.json({ emojis: store.emojisForUser(req.user!.id) });
  });

  app.get("/api/servers/:id", requireAuth, (req, res) => {
    const server = requireMember(req, req.params.id as string);
    res.json({
      server,
      channels: store.visibleChannels(server.id, req.user!.id),
      categories: store.categories(server.id),
      members: store.members(server.id),
      presence: realtime.presenceMap(store.members(server.id).map((m) => m.id)),
      voice: realtime.voiceState(server.id, req.user!.id),
      roles: store.roles(server.id),
      memberData: store.memberData(server.id),
    });
  });

  // ICE servers for WebRTC. STUN finds a public address; TURN relays media when a direct
  // connection is impossible (strict NATs, corporate networks) — set TURN_* in production.
  app.get("/api/rtc-config", requireAuth, async (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ iceServers: await ice.getIceServers() });
  });

  app.get("/api/invites/:code", (req, res) => {
    const found = store.serverForInvite(req.params.code as string);
    if (!found) throw new HttpError(404, "Convite inválido ou expirado.");
    const { server, invite } = found;
    res.json({
      server: { id: server.id, name: server.name, banner: server.banner, icon: server.icon },
      memberCount: store.members(server.id).length,
      expiresAt: invite?.expiresAt ?? null,
    });
  });

  app.post("/api/invites/:code", requireAuth, (req, res) => {
    const found = store.serverForInvite(req.params.code as string);
    if (!found) throw new HttpError(404, "Convite inválido ou expirado.");
    const { server, invite } = found;
    const me = req.user!.id;
    if (store.isMember(server.id, me)) return void res.json({ server });
    if (store.isBanned(server.id, me)) throw new HttpError(403, "Você foi banido deste servidor.");
    // Counted only for someone actually joining; fails if the last use went meanwhile.
    if (invite && !store.useInvite(invite.code)) throw new HttpError(404, "Convite inválido ou expirado.");
    if (store.addMember(server.id, me)) {
      io.in(`user:${req.user!.id}`).socketsJoin(`server:${server.id}`);
      io.to(`server:${server.id}`).emit("member:join", {
        serverId: server.id,
        user: req.user,
        presence: realtime.presenceOf(req.user!.id),
      });
    }
    res.json({ server });
  });

  // --- channels -------------------------------------------------------------

  // --- messages -------------------------------------------------------------
  app.get("/api/channels/:id/messages", requireAuth, (req, res) => {
    const channel = requireChannelAccess(req, req.params.id as string);
    const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
    // With the latest page: where you stopped reading, for the "Novas mensagens" line.
    const lastReadAt = req.query.before ? undefined : store.lastReadAt(req.user!.id, channel.id);
    res.json({ messages: store.messages(channel.id, before, limit), lastReadAt });
  });

  // --- threads ---------------------------------------------------------------
  // Anyone who can read a server's text channel can start a thread there, from a message or not.
  app.post("/api/channels/:id/threads", requireAuth, (req, res) => {
    const parent = requireChannelAccess(req, req.params.id as string);
    if (parent.type !== "text" || !parent.serverId) throw new HttpError(400, "Tópicos só podem ser criados em canais de texto de servidores.");
    const messageId = req.body?.messageId ?? null;
    let starter = null;
    if (messageId !== null) {
      starter = typeof messageId === "string" ? store.messageById(messageId) : null;
      if (!starter || starter.channelId !== parent.id) throw new HttpError(404, "Mensagem não encontrada.");
      if (store.threadOf(starter.id)) throw new HttpError(409, "Essa mensagem já tem um tópico.");
    }
    const fallback = starter?.content.replace(/\s+/g, " ").trim().slice(0, 40) || "Novo tópico";
    const name = req.body?.name === undefined || req.body?.name === "" ? fallback : str(req.body.name, "nome", 1, 100);
    const thread = store.createThread(parent, name, starter?.id ?? null, req.user!.id);
    realtime.emitChannels(parent.serverId);
    if (starter) io.to(realtime.channelRooms(parent)).emit("message:update", store.messageById(starter.id)!);
    res.status(201).json({ channel: thread });
  });

  // --- pins ------------------------------------------------------------------
  const MAX_PINS = 50;
  app.get("/api/channels/:id/pins", requireAuth, (req, res) => {
    const channel = requireChannelAccess(req, req.params.id as string);
    res.json({ messages: store.pinnedMessages(channel.id) });
  });

  // In a server it takes "Gerenciar mensagens"; in a DM anyone in it can pin.
  const setPin = (pinned: boolean) => (req: Request, res: Response) => {
    const channel = requireChannelAccess(req, req.params.id as string);
    const id = req.params.messageId as string;
    const info = store.messageInfo(id);
    if (!info || info.channelId !== channel.id) throw new HttpError(404, "Mensagem não encontrada.");
    if (channel.serverId) {
      const server = store.serverById(channel.serverId)!;
      const me = req.user!.id;
      const perms = permissionsOf(server, store.roles(server.id), me, store.memberInfo(server.id, me)?.roleIds ?? []);
      if (!can(perms, Permission.MANAGE_MESSAGES)) throw new HttpError(403, "Você não tem permissão para fixar mensagens.");
    }
    if (!store.setPinned(id, pinned, MAX_PINS)) throw new HttpError(400, `Um canal pode ter até ${MAX_PINS} mensagens fixadas. Desafixe alguma antes.`);
    const message = store.messageById(id)!;
    io.to(realtime.channelRooms(channel)).emit("message:update", message);
    res.json({ message });
  };
  app.put("/api/channels/:id/pins/:messageId", requireAuth, setPin(true));
  app.delete("/api/channels/:id/pins/:messageId", requireAuth, setPin(false));

  // A page around one message (jumping to a search result or a quoted reply).
  app.get("/api/channels/:id/messages/around/:messageId", requireAuth, (req, res) => {
    const channel = requireChannelAccess(req, req.params.id as string);
    const found = store.messagesAround(channel.id, req.params.messageId as string, 25);
    if (!found) throw new HttpError(404, "Essa mensagem não existe mais.");
    res.json(found);
  });

  // Search a server (the channels you see) or one DM. Besides words, the query takes
  // de:usuario, em:canal and tem:arquivo|imagem|video|link|replay.
  const searchLimit = rateLimit({ windowMs: 60_000, max: 60, message: "Muitas buscas. Espere um pouco." });
  app.get("/api/search", requireAuth, searchLimit, (req, res) => {
    const me = req.user!.id;
    const scope = typeof req.query.scope === "string" ? req.query.scope : "";
    const raw = typeof req.query.q === "string" ? req.query.q.slice(0, 200) : "";
    const offset = Math.min(Math.max(Math.floor(Number(req.query.offset) || 0), 0), 5000);
    const server = store.serverById(scope);
    let channels: Channel[];
    if (server) {
      if (!store.isMember(server.id, me)) throw new HttpError(404, "Servidor não encontrado.");
      channels = store.visibleChannels(server.id, me).filter((c) => c.type === "text" || c.type === "thread");
    } else {
      const channel = store.channelById(scope);
      if (!channel || channel.serverId || !store.canViewChannel(channel, me)) throw new HttpError(404, "Conversa não encontrada.");
      channels = [channel];
    }
    const words: string[] = [];
    let authorId: string | undefined;
    let has: "file" | "image" | "video" | "link" | "clip" | undefined;
    const HAS: Record<string, typeof has> = { arquivo: "file", arquivos: "file", imagem: "image", imagens: "image", video: "video", vídeo: "video", link: "link", links: "link", replay: "clip", clipe: "clip" };
    for (const token of raw.split(/\s+/).filter(Boolean)) {
      const [key, ...rest] = token.split(":");
      const value = rest.join(":").replace(/^[@#]/, "");
      if (rest.length && key === "de" && value) {
        // Someone who doesn't exist matches nothing (not everything).
        authorId = store.userByUsername(value)?.id ?? "-";
      } else if (rest.length && key === "em" && value) {
        channels = channels.filter((c) => c.name.toLowerCase() === value.toLowerCase());
      } else if (rest.length && key === "tem" && HAS[value.toLowerCase()]) {
        has = HAS[value.toLowerCase()];
      } else {
        // Only letters and digits reach the index (no FTS syntax from the query).
        words.push(...token.normalize("NFC").split(/[^\p{L}\p{N}]+/u).filter(Boolean));
      }
    }
    if (!words.length && !authorId && !has) return void res.json({ messages: [], total: 0 });
    const { messages, total } = store.searchMessages(me, channels.map((c) => c.id), { words: words.slice(0, 10), authorId, has, offset, limit: 25 });
    res.json({ messages, total });
  });

  // Read up to `at` (the newest message you saw); your other devices clear it too.
  app.post("/api/channels/:id/read", requireAuth, (req, res) => {
    const channel = requireChannelAccess(req, req.params.id as string);
    const at = Math.min(Number(req.body?.at) || Date.now(), Date.now());
    const lastReadAt = store.markRead(req.user!.id, channel.id, at);
    io.to(`user:${req.user!.id}`).emit("channel:read", { channelId: channel.id, at: lastReadAt });
    res.json({ lastReadAt });
  });

  app.post("/api/channels/:id/messages", requireAuth, (req, res) => {
    const channel = requireChannelAccess(req, req.params.id as string);
    if (channel.type === "voice") throw new HttpError(400, "Esse canal não aceita mensagens.");
    const uploads: unknown = req.body?.uploads ?? [];
    if (!Array.isArray(uploads) || uploads.length > MAX_FILES_PER_MESSAGE || !uploads.every((u) => typeof u === "string")) {
      throw new HttpError(400, `Envie no máximo ${MAX_FILES_PER_MESSAGE} arquivos por mensagem.`);
    }
    // A message may be only files; otherwise it needs text.
    const content = str(req.body?.content ?? "", "mensagem", uploads.length ? 0 : 1, 4000);
    // A 1:1 DM with someone who blocked you (or whom you blocked) doesn't take messages.
    if (!channel.serverId && !store.groupDm(channel.id)) {
      const other = store.dmParticipants(channel.id)?.find((id) => id !== req.user!.id);
      if (other && store.blockedBetween(req.user!.id, other)) throw new HttpError(403, "Sua mensagem não pôde ser entregue.");
    }
    const replyTo = req.body?.replyTo ?? null;
    if (replyTo !== null && (typeof replyTo !== "string" || store.messageInfo(replyTo)?.channelId !== channel.id)) {
      throw new HttpError(400, "A mensagem que você está respondendo não existe mais.");
    }
    const id = randomUUID();
    db.exec("BEGIN");
    try {
      store.insertMessage(channel.id, req.user!, content, undefined, id, replyTo);
      if (!store.attachUploads(id, req.user!.id, uploads as string[])) throw new HttpError(400, "Um dos arquivos não está mais disponível. Envie de novo.");
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    recordMentions(channel, id, content, replyTo, req);
    const message = store.messageById(id)!;
    io.to(realtime.channelRooms(channel)).emit("message:new", { ...message, serverId: channel.serverId });
    store.markRead(req.user!.id, channel.id, message.createdAt);
    notifier.message(channel, message);
    // The message a thread started from shows its new count.
    if (channel.type === "thread" && channel.starterMessageId) {
      const starter = store.messageById(channel.starterMessageId);
      if (starter) io.to(realtime.channelRooms(channel)).emit("message:update", starter);
    }
    refreshPreviews(channel, message.id, message.content);
    res.status(201).json({ message });
  });

  // Link previews: fetched after a message is sent or edited (a few at a time, each URL
  // once a day), then everyone gets the message again with its previews.
  const previewsInFlight = new Map<string, Promise<void>>();
  let previewSlots = 4;
  const waiting: (() => void)[] = [];
  const slot = async () => {
    if (previewSlots > 0) previewSlots--;
    else await new Promise<void>((r) => waiting.push(r));
  };
  const release = () => (waiting.length ? waiting.shift()!() : previewSlots++);
  function refreshPreviews(channel: Channel, messageId: string, content: string) {
    if (!unfurler) return;
    const stale = store.stalePreviews(content, 24 * 3_600_000);
    if (!stale.length) return;
    const jobs = stale.map((url) => {
      let job = previewsInFlight.get(url);
      if (!job) {
        job = slot()
          .then(() => unfurler.preview(url))
          .then((embed) => store.savePreview(url, embed))
          .finally(() => {
            release();
            previewsInFlight.delete(url);
          });
        previewsInFlight.set(url, job);
      }
      return job;
    });
    Promise.allSettled(jobs).then(() => {
      const m = store.messageById(messageId);
      if (m?.embeds.length) io.to(realtime.channelRooms(channel)).emit("message:update", m);
    });
  }

  /**
   * Who a message pings: the @names who can read the channel, the author of the message it
   * replies to, and @everyone when the author may use it (servers only). Never the author.
   */
  function recordMentions(channel: Channel, messageId: string, content: string, replyTo: string | null, req: Request) {
    const me = req.user!.id;
    const found = findMentions(content);
    const ids = new Set(store.audienceByUsernames(channel, found.usernames));
    if (replyTo) {
      const original = store.messageInfo(replyTo);
      if (original) ids.add(original.authorId);
    }
    ids.delete(me);
    let everyone = false;
    if (found.everyone && channel.serverId) {
      const server = store.serverById(channel.serverId);
      everyone = !!server && can(permissionsOf(server, store.roles(server.id), me, store.memberInfo(server.id, me)?.roleIds ?? []), Permission.MENTION_EVERYONE);
    }
    store.setMentions(messageId, [...ids], everyone);
  }

  // A file for a message, sent before the message itself: the body is the file, its
  // name (and, for images and videos, its size in pixels) in the query string.
  const uploadLimit = rateLimit({ windowMs: 10 * 60_000, max: 120, message: "Muitos arquivos enviados. Espere um pouco." });
  app.post("/api/uploads", requireAuth, uploadLimit, async (req, res) => {
    const q = req.query as Record<string, unknown>;
    if (Number(req.headers["content-length"]) > MAX_FILE_BYTES) throw new HttpError(413, `O arquivo passa de ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
    const name = fileName(q.name);
    const dim = (v: unknown) => {
      const n = Math.round(Number(v));
      return Number.isFinite(n) && n >= 1 && n <= 20000 ? n : null;
    };
    const upload = await files.receive(req);
    if (upload.size === 0) {
      files.discard(upload.tmp);
      throw new HttpError(400, "O arquivo está vazio.");
    }
    const image = detectImageType(upload.head);
    const kind: FileKind = image ? "image" : upload.type ? "video" : "file";
    const mime = image ? IMAGE_MIME[image] : upload.type ? CLIP_MIME[upload.type] : "application/octet-stream";
    const id = randomUUID();
    files.commitAs(upload.tmp, id);
    const row = store.insertUpload({
      id,
      ownerId: req.user!.id,
      name,
      kind,
      mime,
      size: upload.size,
      width: kind === "file" ? null : dim(q.width),
      height: kind === "file" ? null : dim(q.height),
    });
    // Over the disk budget: the oldest attachments go, and their messages are updated.
    for (const m of store.expireFiles(files.evict(id))) {
      const c = store.channelById(m.channelId);
      if (c) io.to(realtime.channelRooms(c)).emit("message:update", m);
    }
    res.status(201).json({ upload: toFileAttachment(row) });
  });

  /** Removes a file picked by mistake, before it was sent. */
  app.delete("/api/uploads/:id", requireAuth, (req, res) => {
    const u = store.uploadById(req.params.id as string);
    if (!u || u.ownerId !== req.user!.id || u.messageId) throw new HttpError(404, "Arquivo não encontrado.");
    store.deleteUpload(u.id);
    files.remove(u.id);
    res.status(204).end();
  });

  // Files picked but never sent are cleared after a couple of hours.
  const sweep = setInterval(() => {
    for (const id of store.staleUploads(Date.now() - 2 * 60 * 60_000)) {
      store.deleteUpload(id);
      files.remove(id);
    }
  }, 30 * 60_000);
  sweep.unref();

  // Deleting a message: its author always can; in a server, so can members with "Gerenciar mensagens".
  app.delete("/api/channels/:id/messages/:messageId", requireAuth, (req, res) => {
    const channel = requireChannelAccess(req, req.params.id as string);
    const info = store.messageInfo(req.params.messageId as string);
    if (!info || info.channelId !== channel.id) throw new HttpError(404, "Mensagem não encontrada.");
    const me = req.user!.id;
    if (info.authorId !== me) {
      const server = channel.serverId ? store.serverById(channel.serverId) : null;
      const perms = server ? permissionsOf(server, store.roles(server.id), me, store.memberInfo(server.id, me)?.roleIds ?? []) : 0;
      if (!can(perms, Permission.MANAGE_MESSAGES)) throw new HttpError(403, "Você só pode apagar as suas mensagens.");
    }
    const fileIds = store.fileIdsOf(req.params.messageId as string);
    store.deleteMessage(req.params.messageId as string);
    if (info.clipFile) clips.remove(info.clipFile);
    for (const f of fileIds) files.remove(f);
    io.to(realtime.channelRooms(channel)).emit("message:delete", { channelId: channel.id, id: req.params.messageId as string });
    res.status(204).end();
  });

  // Editing: only the author, and the text may only be emptied when files remain.
  app.patch("/api/channels/:id/messages/:messageId", requireAuth, (req, res) => {
    const channel = requireChannelAccess(req, req.params.id as string);
    const id = req.params.messageId as string;
    const info = store.messageInfo(id);
    if (!info || info.channelId !== channel.id) throw new HttpError(404, "Mensagem não encontrada.");
    if (info.authorId !== req.user!.id) throw new HttpError(403, "Você só pode editar as suas mensagens.");
    const content = str(req.body?.content ?? "", "mensagem", store.hasMedia(id) ? 0 : 1, 4000);
    store.editMessage(id, content);
    // Mentions follow the new text (for highlighting; edits don't notify again).
    recordMentions(channel, id, content, store.messageById(id)?.replyTo?.id ?? null, req);
    const message = store.messageById(id)!;
    io.to(realtime.channelRooms(channel)).emit("message:update", message);
    refreshPreviews(channel, req.params.messageId as string, content);
    res.json({ message });
  });

  // Reactions: PUT to add yours, DELETE to take it back. The emoji is the last path segment.
  const reactionTarget = (req: Request) => {
    const channel = requireChannelAccess(req, req.params.id as string);
    const id = req.params.messageId as string;
    if (store.messageInfo(id)?.channelId !== channel.id) throw new HttpError(404, "Mensagem não encontrada.");
    const emoji = String(req.params.emoji ?? "");
    const custom = emoji.match(CUSTOM_EMOJI);
    if (custom ? !store.emojiById(custom[2]) : !isEmoji(emoji)) throw new HttpError(400, "Reação inválida.");
    return { channel, id, emoji };
  };
  const publishReactions = (channel: Channel, id: string) =>
    io.to(realtime.channelRooms(channel)).emit("message:reactions", { channelId: channel.id, messageId: id, reactions: store.reactionsOf(id) });
  app.put("/api/channels/:id/messages/:messageId/reactions/:emoji", requireAuth, (req, res) => {
    const { channel, id, emoji } = reactionTarget(req);
    if (!store.addReaction(id, req.user!.id, emoji, MAX_REACTION_KINDS)) {
      throw new HttpError(400, `Uma mensagem pode ter no máximo ${MAX_REACTION_KINDS} reações diferentes.`);
    }
    publishReactions(channel, id);
    res.status(204).end();
  });
  app.delete("/api/channels/:id/messages/:messageId/reactions/:emoji", requireAuth, (req, res) => {
    const { channel, id, emoji } = reactionTarget(req);
    store.removeReaction(id, req.user!.id, emoji);
    publishReactions(channel, id);
    res.status(204).end();
  });

  // A clip (instant replay) posted as a message. The body is the video itself; the
  // details travel in the query string: ?duration=&width=&height=&content=
  const clipLimit = rateLimit({ windowMs: 10 * 60_000, max: 20, message: "Muitos clipes enviados. Espere um pouco." });
  app.post("/api/channels/:id/clips", requireAuth, clipLimit, async (req, res) => {
    const channel = requireChannelAccess(req, req.params.id as string);
    if (channel.type === "voice") throw new HttpError(400, "Esse canal não aceita mensagens.");
    const q = req.query as Record<string, unknown>;
    const num = (v: unknown, name: string, min: number, max: number) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `Valor inválido para ${name}.`);
      return n;
    };
    const duration = Math.round(num(q.duration, "duração", 0.1, 600) * 10) / 10;
    const width = Math.round(num(q.width, "largura", 16, 7680));
    const height = Math.round(num(q.height, "altura", 16, 4320));
    const content = typeof q.content === "string" ? q.content.trim() : "";
    if (content.length > 2000) throw new HttpError(400, "A legenda pode ter no máximo 2000 caracteres.");
    if (Number(req.headers["content-length"]) > clips.maxClipBytes) {
      throw new HttpError(413, `O clipe passa de ${Math.round(clips.maxClipBytes / 1024 / 1024)} MB.`);
    }

    const upload = await clips.receive(req);
    if (!upload.type || upload.size === 0) {
      clips.discard(upload.tmp);
      throw new HttpError(400, "O arquivo não é um vídeo MP4 ou WebM.");
    }
    const id = randomUUID();
    const file = clips.commit(upload.tmp, id, upload.type);
    const message = store.insertMessage(channel.id, req.user!, content, { kind: "clip", file, type: upload.type, size: upload.size, duration, width, height }, id);
    io.to(realtime.channelRooms(channel)).emit("message:new", { ...message, serverId: channel.serverId });
    notifier.message(channel, message);

    // Over the disk budget: the oldest clips go, and their messages show that they expired.
    for (const m of store.expireClips(clips.evict(file))) {
      const c = store.channelById(m.channelId);
      if (c) io.to(realtime.channelRooms(c)).emit("message:update", m);
    }
    res.status(201).json({ message });
  });

  registerAdminRoutes({ app, io, store, realtime, media, requireAuth, requireMember });

  // Short, shareable link to the latest Windows installer (published by the "Desktop" workflow).
  const downloadUrl = process.env.DOWNLOAD_URL || "https://github.com/fonsecasssh/Voxa/releases/latest/download/Voxa-Setup.exe";
  app.get("/download", (_req, res) => res.redirect(302, downloadUrl));

  app.use("/api", (_req, _res) => {
    throw new HttpError(404, "Rota não encontrada.");
  });

  // --- web app (production) ---------------------------------------------------
  if (webDist && existsSync(webDist)) {
    // Built assets have content hashes in their names, so they can be cached forever;
    // index.html must always be revalidated so a deploy is picked up right away.
    app.use("/assets", express.static(path.join(webDist, "assets"), { immutable: true, maxAge: "1y" }));
    app.use(express.static(webDist, { index: false, maxAge: 0 }));
    app.get(/^(?!\/api\/|\/socket\.io\/).*/, (_req, res) => {
      res.setHeader("Cache-Control", "no-cache");
      res.sendFile(path.join(webDist, "index.html"));
    });
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    if (err instanceof SyntaxError) {
      res.status(400).json({ error: "JSON inválido." });
      return;
    }
    // Errors from Express itself (body too large, static file not found) carry a client status.
    const status = (err as { status?: unknown })?.status;
    if (typeof status === "number" && status >= 400 && status < 500) {
      const tooLarge = (err as { type?: unknown }).type === "entity.too.large";
      res.status(status).json({ error: tooLarge ? "Arquivo grande demais (imagens até 2 MB, GIFs até 8 MB)." : status === 404 ? "Não encontrado." : "Requisição inválida." });
      return;
    }
    console.error(err);
    res.status(500).json({ error: "Erro interno." });
  });


  return { app, http, io, store };
}
