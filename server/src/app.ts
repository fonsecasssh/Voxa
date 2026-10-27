import express, { type NextFunction, type Request, type Response } from "express";
import { createServer as createHttpServer } from "node:http";
import { existsSync } from "node:fs";
import path from "node:path";
import { Server as IOServer } from "socket.io";
import { hashPassword, verifyPassword } from "./auth.ts";
import type { DB } from "./db.ts";
import { createStore, type ChannelType, type PublicUser, type Store } from "./store.ts";
import { registerRealtime } from "./realtime.ts";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// Express's Request carries the authenticated user after `requireAuth`.
declare module "express-serve-static-core" {
  interface Request {
    user?: PublicUser;
    token?: string;
  }
}

const USERNAME_RE = /^[a-zA-Z0-9_.]{3,32}$/;

function str(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== "string") throw new HttpError(400, `Campo "${field}" é obrigatório.`);
  const v = value.trim();
  if (v.length < min || v.length > max) throw new HttpError(400, `"${field}" deve ter entre ${min} e ${max} caracteres.`);
  return v;
}

function bearer(req: Request): string | null {
  const h = req.headers.authorization;
  return h?.startsWith("Bearer ") ? h.slice(7) : null;
}

export interface AppOptions {
  db: DB;
  /** Directory with the built web app, served in production. */
  webDist?: string;
}

export function createApp({ db, webDist }: AppOptions) {
  const store: Store = createStore(db);
  const app = express();
  const http = createHttpServer(app);
  const io = new IOServer(http, { cors: { origin: true } });

  app.use(express.json({ limit: "100kb" }));

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
    if (!channel || !store.isMember(channel.serverId, req.user!.id)) throw new HttpError(404, "Canal não encontrado.");
    return channel;
  };

  // --- auth -----------------------------------------------------------------
  app.post("/api/auth/register", async (req, res) => {
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
    const found = store.findUserForLogin(username);
    if (!found || !(await verifyPassword(password, found.passwordHash))) {
      throw new HttpError(401, "Usuário ou senha incorretos.");
    }
    const { passwordHash: _, ...user } = found;
    res.json({ token: store.createSession(user.id), user });
  });

  app.post("/api/auth/logout", requireAuth, (req, res) => {
    store.deleteSession(req.token!);
    res.status(204).end();
  });

  app.get("/api/me", requireAuth, (req, res) => {
    res.json({ user: req.user, servers: store.serversForUser(req.user!.id) });
  });

  // --- servers --------------------------------------------------------------
  app.post("/api/servers", requireAuth, (req, res) => {
    const name = str(req.body?.name, "nome", 1, 100);
    const { server, channels } = store.createServer(req.user!.id, name);
    io.in(`user:${req.user!.id}`).socketsJoin(`server:${server.id}`);
    res.status(201).json({ server, channels });
  });

  app.get("/api/servers/:id", requireAuth, (req, res) => {
    const server = requireMember(req, req.params.id as string);
    res.json({
      server,
      channels: store.channels(server.id),
      members: store.members(server.id),
      online: realtime.onlineUserIds(store.members(server.id).map((m) => m.id)),
      voice: realtime.voiceState(server.id),
    });
  });

  // ICE servers for WebRTC. STUN finds a public address; TURN relays media when a direct
  // connection is impossible (strict NATs, corporate networks) — set TURN_* in production.
  app.get("/api/rtc-config", requireAuth, (_req, res) => {
    const iceServers: { urls: string | string[]; username?: string; credential?: string }[] = [
      { urls: (process.env.STUN_URLS || "stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302").split(",") },
    ];
    if (process.env.TURN_URLS) {
      iceServers.push({
        urls: process.env.TURN_URLS.split(","),
        username: process.env.TURN_USERNAME,
        credential: process.env.TURN_CREDENTIAL,
      });
    }
    res.json({ iceServers });
  });

  app.get("/api/invites/:code", (req, res) => {
    const server = store.serverByInvite(req.params.code as string);
    if (!server) throw new HttpError(404, "Convite inválido.");
    res.json({ server: { id: server.id, name: server.name }, memberCount: store.members(server.id).length });
  });

  app.post("/api/invites/:code", requireAuth, (req, res) => {
    const server = store.serverByInvite(req.params.code as string);
    if (!server) throw new HttpError(404, "Convite inválido.");
    if (store.addMember(server.id, req.user!.id)) {
      io.in(`user:${req.user!.id}`).socketsJoin(`server:${server.id}`);
      io.to(`server:${server.id}`).emit("member:join", { serverId: server.id, user: req.user });
    }
    res.json({ server });
  });

  // --- channels -------------------------------------------------------------
  app.post("/api/servers/:id/channels", requireAuth, (req, res) => {
    const server = requireMember(req, req.params.id as string);
    if (server.ownerId !== req.user!.id) throw new HttpError(403, "Só o dono do servidor pode criar canais.");
    const type: ChannelType = req.body?.type === "voice" ? "voice" : "text";
    let name = str(req.body?.name, "nome", 1, 100);
    if (type === "text") name = name.toLowerCase().replace(/\s+/g, "-");
    const channel = store.insertChannel(server.id, name, type);
    io.to(`server:${server.id}`).emit("channel:new", channel);
    res.status(201).json({ channel });
  });

  // --- messages -------------------------------------------------------------
  app.get("/api/channels/:id/messages", requireAuth, (req, res) => {
    const channel = requireChannelAccess(req, req.params.id as string);
    const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
    res.json({ messages: store.messages(channel.id, before, limit) });
  });

  app.post("/api/channels/:id/messages", requireAuth, (req, res) => {
    const channel = requireChannelAccess(req, req.params.id as string);
    if (channel.type !== "text") throw new HttpError(400, "Esse canal não aceita mensagens.");
    const content = str(req.body?.content, "mensagem", 1, 4000);
    const message = store.insertMessage(channel.id, req.user!, content);
    io.to(`server:${channel.serverId}`).emit("message:new", message);
    res.status(201).json({ message });
  });

  app.use("/api", (_req, _res) => {
    throw new HttpError(404, "Rota não encontrada.");
  });

  // --- web app (production) ---------------------------------------------------
  if (webDist && existsSync(webDist)) {
    app.use(express.static(webDist));
    app.get(/^(?!\/api\/|\/socket\.io\/).*/, (_req, res) => res.sendFile(path.join(webDist, "index.html")));
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
    console.error(err);
    res.status(500).json({ error: "Erro interno." });
  });

  const realtime = registerRealtime(io, store);

  return { app, http, io, store };
}
