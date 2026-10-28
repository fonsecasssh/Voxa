// Profile, server, member, role and channel management — the "names and roles" part of Voxa.
// Every action checks the permissions in shared/permissions.ts, including the role hierarchy.

import express, { type Express, type NextFunction, type Request, type Response } from "express";
import type { Server as IOServer } from "socket.io";
import { Permission, can, permissionsOf, topPosition } from "../../shared/permissions.ts";
import { hashPassword, verifyPassword } from "./auth.ts";
import { HttpError, str } from "./http.ts";
import type { registerRealtime } from "./realtime.ts";
import type { ChannelType, Role, Server, Store } from "./store.ts";
import { MAX_IMAGE_BYTES, SERVER_IMAGE_KINDS, USER_IMAGE_KINDS, detectImageType, type MediaStore } from "./media.ts";

interface Deps {
  app: Express;
  io: IOServer;
  store: Store;
  realtime: ReturnType<typeof registerRealtime>;
  media: MediaStore;
  requireAuth: (req: Request, res: Response, next: NextFunction) => void;
  requireMember: (req: Request, serverId: string) => Server;
}

const COLOR_RE = /^#[0-9a-f]{6}$/i;

function color(value: unknown): string | null {
  if (value === null || value === "") return null;
  if (typeof value !== "string" || !COLOR_RE.test(value)) throw new HttpError(400, "Cor inválida (use #rrggbb).");
  return value.toLowerCase();
}

function permissionBits(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new HttpError(400, "Permissões inválidas.");
  return value & Object.values(Permission).reduce((a, b) => a | b, 0);
}

const channelName = (type: ChannelType, raw: unknown) => {
  const name = str(raw, "nome", 1, 100);
  // Text channels are slugs ("jogos-online"); voice channels keep spaces and case.
  return type === "text" ? name.toLowerCase().replace(/\s+/g, "-") : name;
};

export function registerAdminRoutes({ app, io, store, realtime, media, requireAuth, requireMember }: Deps) {
  /** The requesting member's standing in a server: permissions and highest role position. */
  const standing = (req: Request, serverId: string) => {
    const server = requireMember(req, serverId);
    const roles = store.roles(server.id);
    const me = req.user!.id;
    const roleIds = store.memberInfo(server.id, me)?.roleIds ?? [];
    return {
      server,
      roles,
      perms: permissionsOf(server, roles, me, roleIds),
      top: topPosition(server, roles, me, roleIds),
      /** Position of another member's highest role (the owner is above everyone). */
      topOf: (userId: string) => topPosition(server, roles, userId, store.memberInfo(server.id, userId)?.roleIds ?? []),
    };
  };

  const need = (perms: number, flag: number, message: string) => {
    if (!can(perms, flag)) throw new HttpError(403, message);
  };

  const emitRoles = (serverId: string) => io.to(`server:${serverId}`).emit("roles:update", { serverId, roles: store.roles(serverId) });

  const emitMember = (serverId: string, userId: string) => {
    const info = store.memberInfo(serverId, userId);
    if (info) io.to(`server:${serverId}`).emit("member:update", { serverId, userId, ...info });
  };

  const roleIn = (serverId: string, roleId: string): Role => {
    const role = store.roleById(roleId);
    if (!role || role.serverId !== serverId) throw new HttpError(404, "Cargo não encontrado.");
    return role;
  };

  // --- profile --------------------------------------------------------------
  app.patch("/api/me", requireAuth, (req, res) => {
    const displayName = str(req.body?.displayName, "nome de exibição", 1, 32);
    store.setDisplayName(req.user!.id, displayName);
    const user = { ...req.user!, displayName };
    realtime.updateUser(user);
    res.json({ user });
  });

  // Profile picture and banner: PUT /api/me/avatar|banner with the cropped image as the body, DELETE to remove.
  for (const kind of USER_IMAGE_KINDS) {
    const route = kind === "avatar" ? "/api/me/avatar" : "/api/me/banner";
    const publish = (userId: string, res: Response) => {
      const user = store.userById(userId)!;
      realtime.updateUser(user);
      res.json({ user });
    };

    app.put(route, requireAuth, express.raw({ type: () => true, limit: MAX_IMAGE_BYTES }), (req, res) => {
      const me = req.user!.id;
      const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const type = detectImageType(data);
      if (!type) throw new HttpError(400, "Envie uma imagem PNG, JPEG, WebP ou GIF.");
      const file = media.save(kind, me, data, type);
      const previous = store.setUserImage(kind, me, file);
      if (previous !== file) media.remove(kind, previous);
      publish(me, res);
    });

    app.delete(route, requireAuth, (req, res) => {
      const me = req.user!.id;
      media.remove(kind, store.setUserImage(kind, me, null));
      publish(me, res);
    });
  }

  app.post("/api/me/password", requireAuth, async (req, res) => {
    const current = str(req.body?.currentPassword, "senha atual", 1, 200);
    const next = str(req.body?.newPassword, "nova senha", 8, 200);
    const hash = store.passwordHash(req.user!.id);
    if (!hash || !(await verifyPassword(current, hash))) throw new HttpError(400, "A senha atual está incorreta.");
    store.setPassword(req.user!.id, await hashPassword(next), req.token!);
    res.status(204).end();
  });

  // --- server ---------------------------------------------------------------
  app.patch("/api/servers/:id", requireAuth, (req, res) => {
    const { server, perms } = standing(req, req.params.id as string);
    need(perms, Permission.MANAGE_SERVER, "Você não tem permissão para gerenciar este servidor.");
    const updated = { ...server, name: str(req.body?.name, "nome", 1, 100) };
    store.renameServer(server.id, updated.name);
    io.to(`server:${server.id}`).emit("server:update", updated);
    res.json({ server: updated });
  });

  // Banner and icon: PUT /api/servers/:id/banner|icon with the image as the raw request
  // body (the browser sends it already cropped), DELETE to remove it.
  for (const kind of SERVER_IMAGE_KINDS) {
    const publish = (serverId: string, res: Response) => {
      const updated = store.serverById(serverId)!;
      io.to(`server:${serverId}`).emit("server:update", updated);
      res.json({ server: updated });
    };

    app.put(`/api/servers/:id/${kind}`, requireAuth, express.raw({ type: () => true, limit: MAX_IMAGE_BYTES }), (req, res) => {
      const { server, perms } = standing(req, req.params.id as string);
      need(perms, Permission.MANAGE_SERVER, "Você não tem permissão para gerenciar este servidor.");
      const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const type = detectImageType(data);
      if (!type) throw new HttpError(400, "Envie uma imagem PNG, JPEG, WebP ou GIF.");
      const file = media.save(kind, server.id, data, type);
      const previous = store.setServerImage(kind, server.id, file);
      if (previous !== file) media.remove(kind, previous);
      publish(server.id, res);
    });

    app.delete(`/api/servers/:id/${kind}`, requireAuth, (req, res) => {
      const { server, perms } = standing(req, req.params.id as string);
      need(perms, Permission.MANAGE_SERVER, "Você não tem permissão para gerenciar este servidor.");
      media.remove(kind, store.setServerImage(kind, server.id, null));
      publish(server.id, res);
    });
  }

  app.delete("/api/servers/:id", requireAuth, (req, res) => {
    const server = requireMember(req, req.params.id as string);
    if (server.ownerId !== req.user!.id) throw new HttpError(403, "Só o dono pode excluir o servidor.");
    for (const kind of SERVER_IMAGE_KINDS) media.remove(kind, store.setServerImage(kind, server.id, null));
    for (const c of store.channels(server.id)) if (c.type === "voice") realtime.evictVoiceChannel(c.id);
    io.to(`server:${server.id}`).emit("server:removed", { serverId: server.id, reason: `O servidor "${server.name}" foi excluído.` });
    io.in(`server:${server.id}`).socketsLeave(`server:${server.id}`);
    store.deleteServer(server.id);
    res.status(204).end();
  });

  app.post("/api/servers/:id/leave", requireAuth, (req, res) => {
    const server = requireMember(req, req.params.id as string);
    const me = req.user!.id;
    if (server.ownerId === me) throw new HttpError(400, "O dono não pode sair do servidor. Exclua-o ou continue nele.");
    store.removeMember(server.id, me);
    realtime.removeFromServer(server.id, me, "Você saiu do servidor.");
    io.to(`server:${server.id}`).emit("member:leave", { serverId: server.id, userId: me });
    io.to(`user:${me}`).emit("server:removed", { serverId: server.id, reason: null });
    res.status(204).end();
  });

  // --- members --------------------------------------------------------------
  app.patch("/api/servers/:id/members/:userId", requireAuth, (req, res) => {
    const { server, perms, top, topOf } = standing(req, req.params.id as string);
    const target = req.params.userId as string;
    if (!store.isMember(server.id, target)) throw new HttpError(404, "Membro não encontrado.");
    const raw = req.body?.nickname;
    const nickname = raw === null || (typeof raw === "string" && raw.trim() === "") ? null : str(raw, "apelido", 1, 32);

    if (target === req.user!.id) {
      if (!can(perms, Permission.CHANGE_NICKNAME) && !can(perms, Permission.MANAGE_NICKNAMES)) {
        throw new HttpError(403, "Você não tem permissão para mudar seu apelido.");
      }
    } else {
      need(perms, Permission.MANAGE_NICKNAMES, "Você não tem permissão para mudar apelidos.");
      if (target === server.ownerId || topOf(target) >= top) {
        throw new HttpError(403, "Você só pode mudar o apelido de membros com cargos abaixo do seu.");
      }
    }
    store.setNickname(server.id, target, nickname);
    emitMember(server.id, target);
    res.json(store.memberInfo(server.id, target));
  });

  const changeMemberRole = (add: boolean) => (req: Request, res: Response) => {
    const { server, perms, top } = standing(req, req.params.id as string);
    need(perms, Permission.MANAGE_ROLES, "Você não tem permissão para gerenciar cargos.");
    const target = req.params.userId as string;
    if (!store.isMember(server.id, target)) throw new HttpError(404, "Membro não encontrado.");
    const role = roleIn(server.id, req.params.roleId as string);
    if (role.isDefault) throw new HttpError(400, "Todos os membros têm o cargo @everyone.");
    if (role.position >= top) throw new HttpError(403, "Você só pode atribuir cargos abaixo do seu cargo mais alto.");
    if (add) store.addMemberRole(server.id, target, role.id);
    else store.removeMemberRole(server.id, target, role.id);
    emitMember(server.id, target);
    res.json(store.memberInfo(server.id, target));
  };
  app.put("/api/servers/:id/members/:userId/roles/:roleId", requireAuth, changeMemberRole(true));
  app.delete("/api/servers/:id/members/:userId/roles/:roleId", requireAuth, changeMemberRole(false));

  app.delete("/api/servers/:id/members/:userId", requireAuth, (req, res) => {
    const { server, perms, top, topOf } = standing(req, req.params.id as string);
    need(perms, Permission.KICK_MEMBERS, "Você não tem permissão para expulsar membros.");
    const target = req.params.userId as string;
    if (target === req.user!.id) throw new HttpError(400, "Para sair do servidor, use \"Sair do servidor\".");
    if (!store.isMember(server.id, target)) throw new HttpError(404, "Membro não encontrado.");
    if (target === server.ownerId || topOf(target) >= top) {
      throw new HttpError(403, "Você só pode expulsar membros com cargos abaixo do seu.");
    }
    store.removeMember(server.id, target);
    realtime.removeFromServer(server.id, target, "Você foi removido do servidor.");
    io.to(`server:${server.id}`).emit("member:leave", { serverId: server.id, userId: target });
    io.to(`user:${target}`).emit("server:removed", { serverId: server.id, reason: `Você foi removido do servidor "${server.name}".` });
    res.status(204).end();
  });

  // --- roles ----------------------------------------------------------------
  app.post("/api/servers/:id/roles", requireAuth, (req, res) => {
    const { server, perms } = standing(req, req.params.id as string);
    need(perms, Permission.MANAGE_ROLES, "Você não tem permissão para gerenciar cargos.");
    const permissions = req.body?.permissions === undefined ? 0 : permissionBits(req.body.permissions);
    if (permissions & ~perms) throw new HttpError(403, "Você não pode dar permissões que você não tem.");
    const role = store.createRole(server.id, {
      name: req.body?.name === undefined ? "novo cargo" : str(req.body.name, "nome do cargo", 1, 32),
      color: req.body?.color === undefined ? null : color(req.body.color),
      permissions,
      hoist: req.body?.hoist === true,
    });
    emitRoles(server.id);
    res.status(201).json({ role });
  });

  app.patch("/api/servers/:id/roles/:roleId", requireAuth, (req, res) => {
    const { server, perms, top } = standing(req, req.params.id as string);
    need(perms, Permission.MANAGE_ROLES, "Você não tem permissão para gerenciar cargos.");
    const role = roleIn(server.id, req.params.roleId as string);
    if (role.position >= top) throw new HttpError(403, "Você só pode editar cargos abaixo do seu cargo mais alto.");

    const patch: Parameters<Store["updateRole"]>[1] = {};
    const b = req.body ?? {};
    if (role.isDefault && (b.name !== undefined || b.color !== undefined || b.hoist !== undefined)) {
      throw new HttpError(400, "No @everyone só dá para mudar as permissões.");
    }
    if (b.name !== undefined) patch.name = str(b.name, "nome do cargo", 1, 32);
    if (b.color !== undefined) patch.color = color(b.color);
    if (b.hoist !== undefined) patch.hoist = b.hoist === true;
    if (b.permissions !== undefined) {
      patch.permissions = permissionBits(b.permissions);
      const added = patch.permissions & ~role.permissions;
      if (added & ~perms) throw new HttpError(403, "Você não pode dar permissões que você não tem.");
    }
    store.updateRole(role.id, patch);
    emitRoles(server.id);
    res.json({ role: store.roleById(role.id) });
  });

  app.delete("/api/servers/:id/roles/:roleId", requireAuth, (req, res) => {
    const { server, perms, top } = standing(req, req.params.id as string);
    need(perms, Permission.MANAGE_ROLES, "Você não tem permissão para gerenciar cargos.");
    const role = roleIn(server.id, req.params.roleId as string);
    if (role.isDefault) throw new HttpError(400, "O cargo @everyone não pode ser excluído.");
    if (role.position >= top) throw new HttpError(403, "Você só pode excluir cargos abaixo do seu cargo mais alto.");
    store.deleteRole(role.id);
    emitRoles(server.id);
    res.status(204).end();
  });

  app.post("/api/servers/:id/roles/:roleId/move", requireAuth, (req, res) => {
    const { server, perms, top, roles } = standing(req, req.params.id as string);
    need(perms, Permission.MANAGE_ROLES, "Você não tem permissão para gerenciar cargos.");
    const role = roleIn(server.id, req.params.roleId as string);
    const direction = req.body?.direction;
    if (direction !== "up" && direction !== "down") throw new HttpError(400, "Direção inválida.");
    if (role.isDefault) throw new HttpError(400, "O @everyone fica sempre por último.");
    // roles come highest first; the neighbor is the next role above or below (never @everyone).
    const ordered = roles.filter((r) => !r.isDefault);
    const i = ordered.findIndex((r) => r.id === role.id);
    const neighbor = ordered[direction === "up" ? i - 1 : i + 1];
    if (!neighbor) throw new HttpError(400, "O cargo já está no limite.");
    if (role.position >= top || neighbor.position >= top) {
      throw new HttpError(403, "Você só pode reordenar cargos abaixo do seu cargo mais alto.");
    }
    store.swapRolePositions(role, neighbor);
    emitRoles(server.id);
    res.json({ roles: store.roles(server.id) });
  });

  // --- channels ---------------------------------------------------------------
  app.post("/api/servers/:id/channels", requireAuth, (req, res) => {
    const { server, perms } = standing(req, req.params.id as string);
    need(perms, Permission.MANAGE_CHANNELS, "Você não tem permissão para criar canais.");
    const type: ChannelType = req.body?.type === "voice" ? "voice" : "text";
    const channel = store.insertChannel(server.id, channelName(type, req.body?.name), type);
    io.to(`server:${server.id}`).emit("channel:new", channel);
    res.status(201).json({ channel });
  });

  const channelForManage = (req: Request) => {
    const channel = store.channelById(req.params.id as string);
    if (!channel?.serverId) throw new HttpError(404, "Canal não encontrado.");
    const { perms } = standing(req, channel.serverId);
    need(perms, Permission.MANAGE_CHANNELS, "Você não tem permissão para gerenciar canais.");
    return { ...channel, serverId: channel.serverId };
  };

  app.patch("/api/channels/:id", requireAuth, (req, res) => {
    const channel = channelForManage(req);
    const updated = { ...channel, name: channelName(channel.type, req.body?.name) };
    store.renameChannel(channel.id, updated.name);
    io.to(`server:${channel.serverId}`).emit("channel:update", updated);
    res.json({ channel: updated });
  });

  app.delete("/api/channels/:id", requireAuth, (req, res) => {
    const channel = channelForManage(req);
    if (channel.type === "voice") realtime.evictVoiceChannel(channel.id);
    store.deleteChannel(channel.id);
    io.to(`server:${channel.serverId}`).emit("channel:delete", { serverId: channel.serverId, channelId: channel.id });
    res.status(204).end();
  });
}
