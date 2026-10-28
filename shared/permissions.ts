// Server permissions and role hierarchy, shared by the server (which enforces them)
// and the web app (which uses them to show only the actions a member can take).
//
// Like Discord:
// - Every server has a default role, @everyone, that all members have.
// - A member's permissions are the union of their roles' permissions.
// - The owner and anyone with "Administrador" can do everything.
// - Roles are ordered by position; you can only manage roles (and members whose
//   highest role is) below your own highest role. The owner is above everyone.

export const Permission = {
  ADMINISTRATOR: 1 << 0,
  MANAGE_SERVER: 1 << 1,
  MANAGE_ROLES: 1 << 2,
  MANAGE_CHANNELS: 1 << 3,
  KICK_MEMBERS: 1 << 4,
  MANAGE_NICKNAMES: 1 << 5,
  CHANGE_NICKNAME: 1 << 6,
  MANAGE_MESSAGES: 1 << 7,
  MENTION_EVERYONE: 1 << 8,
} as const;

export type PermissionName = keyof typeof Permission;

export const ALL_PERMISSIONS = Object.values(Permission).reduce((a, b) => a | b, 0);

/** What @everyone can do in a new server. */
export const DEFAULT_PERMISSIONS = Permission.CHANGE_NICKNAME;

/** Labels and descriptions shown in the role editor, in display order. */
export const PERMISSION_INFO: { key: PermissionName; label: string; description: string }[] = [
  { key: "ADMINISTRATOR", label: "Administrador", description: "Todas as permissões. Use com cuidado." },
  { key: "MANAGE_SERVER", label: "Gerenciar servidor", description: "Mudar o nome do servidor." },
  { key: "MANAGE_ROLES", label: "Gerenciar cargos", description: "Criar, editar e atribuir cargos abaixo do seu cargo mais alto." },
  { key: "MANAGE_CHANNELS", label: "Gerenciar canais", description: "Criar, renomear e excluir canais." },
  { key: "KICK_MEMBERS", label: "Expulsar membros", description: "Remover membros com cargos abaixo do seu." },
  { key: "MANAGE_NICKNAMES", label: "Gerenciar apelidos", description: "Mudar o apelido de outros membros." },
  { key: "CHANGE_NICKNAME", label: "Alterar apelido", description: "Mudar o próprio apelido neste servidor." },
  { key: "MANAGE_MESSAGES", label: "Gerenciar mensagens", description: "Apagar mensagens de outros membros." },
  { key: "MENTION_EVERYONE", label: "Mencionar @everyone", description: "Notificar todos do servidor com @everyone." },
];

export interface RoleLike {
  id: string;
  permissions: number;
  position: number;
  isDefault: boolean;
}

interface ServerLike {
  ownerId: string;
}

/** The member's effective permission bits (all of them for the owner and administrators). */
export function permissionsOf(server: ServerLike, roles: RoleLike[], userId: string, roleIds: string[]): number {
  if (server.ownerId === userId) return ALL_PERMISSIONS;
  const mine = new Set(roleIds);
  let perms = 0;
  for (const r of roles) if (r.isDefault || mine.has(r.id)) perms |= r.permissions;
  return perms & Permission.ADMINISTRATOR ? ALL_PERMISSIONS : perms;
}

export function can(perms: number, flag: number): boolean {
  return (perms & Permission.ADMINISTRATOR) !== 0 || (perms & flag) === flag;
}

/** Position of the member's highest role; the owner ranks above every role. */
export function topPosition(server: ServerLike, roles: RoleLike[], userId: string, roleIds: string[]): number {
  if (server.ownerId === userId) return Number.POSITIVE_INFINITY;
  const mine = new Set(roleIds);
  let top = 0;
  for (const r of roles) if (mine.has(r.id) && r.position > top) top = r.position;
  return top;
}
