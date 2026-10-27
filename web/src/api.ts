// REST client + the types shared with the server.

export interface User {
  id: string;
  username: string;
  displayName: string;
}

export interface Server {
  id: string;
  name: string;
  ownerId: string;
  inviteCode: string;
}

export type ChannelType = "text" | "voice";

export interface Channel {
  id: string;
  serverId: string;
  name: string;
  type: ChannelType;
  position: number;
}

export interface Message {
  id: string;
  channelId: string;
  author: User;
  content: string;
  createdAt: number;
}

export interface ServerDetails {
  server: Server;
  channels: Channel[];
  members: User[];
  online: string[];
}

const TOKEN_KEY = "sintonia.token";

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage unavailable (private mode): the session just won't survive a reload.
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = getToken();
  const res = await fetch(path, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? "Algo deu errado.");
  return data as T;
}

type AuthResult = { token: string; user: User };

export const api = {
  register: (username: string, password: string, displayName?: string) =>
    request<AuthResult>("POST", "/api/auth/register", { username, password, displayName }),
  login: (username: string, password: string) => request<AuthResult>("POST", "/api/auth/login", { username, password }),
  logout: () => request<void>("POST", "/api/auth/logout"),
  me: () => request<{ user: User; servers: Server[] }>("GET", "/api/me"),

  createServer: (name: string) => request<{ server: Server; channels: Channel[] }>("POST", "/api/servers", { name }),
  server: (id: string) => request<ServerDetails>("GET", `/api/servers/${id}`),
  createChannel: (serverId: string, name: string, type: ChannelType) =>
    request<{ channel: Channel }>("POST", `/api/servers/${serverId}/channels`, { name, type }),

  invite: (code: string) => request<{ server: { id: string; name: string }; memberCount: number }>("GET", `/api/invites/${code}`),
  joinInvite: (code: string) => request<{ server: Server }>("POST", `/api/invites/${code}`),

  messages: (channelId: string, before?: number) =>
    request<{ messages: Message[] }>("GET", `/api/channels/${channelId}/messages${before ? `?before=${before}` : ""}`),
  sendMessage: (channelId: string, content: string) =>
    request<{ message: Message }>("POST", `/api/channels/${channelId}/messages`, { content }),
};
