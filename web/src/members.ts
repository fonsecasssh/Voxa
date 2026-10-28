// How a server member is shown: nickname, role color and permissions.

import { can, permissionsOf, topPosition, Permission } from "../../shared/permissions.ts";
import type { Role, ServerDetails, User } from "./api.ts";

export { Permission, can };

/** The member's roles, highest first (without @everyone). */
export function memberRoles(d: ServerDetails, userId: string): Role[] {
  const ids = new Set(d.memberData[userId]?.roleIds ?? []);
  return d.roles.filter((r) => ids.has(r.id));
}

/** Nickname in this server, else the display name. */
export function memberName(d: ServerDetails | undefined, user: User): string {
  return d?.memberData[user.id]?.nickname || user.displayName;
}

/** Color of the member's highest colored role, or undefined for the default text color. */
export function memberColor(d: ServerDetails | undefined, userId: string): string | undefined {
  if (!d) return undefined;
  return memberRoles(d, userId).find((r) => r.color)?.color ?? undefined;
}

export function myPermissions(d: ServerDetails, userId: string): number {
  return permissionsOf(d.server, d.roles, userId, d.memberData[userId]?.roleIds ?? []);
}

export function myTop(d: ServerDetails, userId: string): number {
  return topPosition(d.server, d.roles, userId, d.memberData[userId]?.roleIds ?? []);
}

/** Whether `actor` outranks `target` (needed to manage them). */
export function outranks(d: ServerDetails, actor: string, target: string): boolean {
  if (target === d.server.ownerId || actor === target) return false;
  return myTop(d, actor) > myTop(d, target);
}

/** Whether the user can open server settings at all. */
export function canOpenSettings(d: ServerDetails, userId: string): boolean {
  const p = myPermissions(d, userId);
  return can(p, Permission.MANAGE_SERVER) || can(p, Permission.MANAGE_ROLES) || can(p, Permission.KICK_MEMBERS) || can(p, Permission.MANAGE_NICKNAMES);
}
