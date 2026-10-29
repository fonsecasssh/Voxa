// Who hears about a new message or call on their other devices (push), following their
// notification settings: muted conversations stay quiet, servers notify only mentions
// unless set to "all", nobody hears from someone they blocked, and nothing is pushed
// while the person has Voxa open somewhere (they see it there).

import type { Channel, Message, PublicUser, Store } from "./store.ts";
import type { PushPayload, PushSender } from "./push.ts";

export interface Notifier {
  message(channel: Channel, message: Message): void;
  ring(channelId: string, from: PublicUser, userIds: string[]): void;
}

const preview = (m: Message) =>
  m.content.slice(0, 140) || (m.attachment ? "Enviou um replay 🎬" : m.files.length ? `Enviou ${m.files.length === 1 ? "um arquivo" : `${m.files.length} arquivos`} 📎` : "");

export function createNotifier(store: Store, isOnline: (userId: string) => boolean, push: PushSender | null): Notifier {
  const deliver = (userId: string, payload: PushPayload) => {
    for (const sub of store.pushSubscriptions(userId)) {
      push!.send(sub, payload).then((r) => r === "gone" && store.removePushSubscription(sub.endpoint));
    }
  };
  const where = (channel: Channel) => {
    if (!channel.serverId) {
      const group = store.groupDm(channel.id);
      return group ? ` em ${group.name || "grupo"}` : "";
    }
    return ` em #${channel.name} (${store.serverById(channel.serverId)?.name ?? ""})`;
  };
  const url = (channel: Channel) => `/channels/${channel.serverId ?? "@me"}/${channel.id}`;

  return {
    message(channel, message) {
      if (!push) return;
      const author = message.author.id;
      for (const userId of store.channelViewers(channel)) {
        if (userId === author || isOnline(userId) || store.hasBlocked(userId, author)) continue;
        const { muted, level } = store.notifyFor(userId, channel);
        const mentioned = message.mentions.includes(userId) || message.mentionsEveryone;
        if (muted || (level === "mentions" && !mentioned)) continue;
        deliver(userId, { title: `${message.author.displayName}${where(channel)}`, body: preview(message), url: url(channel), tag: channel.id });
      }
    },
    ring(channelId, from, userIds) {
      const channel = store.channelById(channelId);
      if (!push || !channel) return;
      for (const userId of userIds) {
        if (isOnline(userId) || store.notifyFor(userId, channel).muted) continue;
        deliver(userId, { title: `${from.displayName} está te ligando`, body: "Toque para atender.", url: url(channel), tag: `call:${channelId}`, call: true });
      }
    },
  };
}
