import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const EMPTY = Object.freeze({ version: 1, rooms: [] });
const MAX_MESSAGES_PER_ROOM = 2_000;
const DELIVERY_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_READ_WAIT_MS = 25_000;
const WEAVE_TARGET = "dsh-chat/2";
const WEAVE_PROTOCOL = "dsh-chat/2";
const ROOM_SESSION_PREFIX = "dsh-chat-room-v3-";

function copy(value) { return structuredClone(value); }
function ensureText(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${label} must not be blank`);
  return value.trim();
}

/** Durable room store and delivery coordinator for dsh-chat. */
export class DshChatService {
  constructor(ctx, config = {}) {
    this.ctx = ctx;
    this.path = config.path ?? join(homedir(), ".dsh", "dsh-chat", "rooms.json");
    this.workspacePath = config.workspacePath ?? join(dirname(this.path), "Chatrooms");
    this.state = copy(EMPTY);
    this.ready = this.#load();
    this.listeners = new Set();
    this.unsubscribeWeave = undefined;
    this.pendingRetryTimer = undefined;
    this.roomSessionTail = Promise.resolve();
    this.aliasRefresh = undefined;
    this.aliasRefreshAt = 0;
  }

  async #load() {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8"));
      if (parsed?.version === 1 && Array.isArray(parsed.rooms)) this.state = parsed;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  async #save() {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
    await rename(temporary, this.path);
  }

  #emit(event) { for (const listener of this.listeners) listener(copy(event)); }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  attachWeave(attempt = 0) {
    if (this.unsubscribeWeave) return;
    const weave = this.#weave();
    if (weave) {
      this.unsubscribeWeave = weave.subscribe((frame) => this.#receiveWeave(frame));
      this.ready = this.ready.then(() => this.#migrateLegacyWeave(weave));
      void this.ready.catch((error) => this.ctx?.logger?.warn?.(`dsh-chat could not migrate a legacy Weave room link: ${String(error)}`));
      this.#schedulePendingRetry();
      return;
    }
    // Accessors are installed by independently activated Cordis plugins. Retry
    // briefly instead of making dshWeave a static inject dependency, which is
    // not a declared service in older DSH bundle contracts.
    if (attempt < 100) setTimeout(() => this.attachWeave(attempt + 1), 100);
  }

  async listRooms() {
    await this.ready;
    if (this.state.rooms.some((room) => room.members.some((member) => !member.alias))) this.#scheduleAliasRefresh();
    return copy(this.state.rooms.map(({ messages, pendingDeliveries, ...room }) => ({ ...room, members: room.members.map((member) => this.#memberView(member)), messageCount: messages.length })));
  }
  async messages(roomId, limit = 100, waitMs = 0) {
    await this.ready; const room = this.#room(roomId);
    if (room.hostId || room.hostTicket) return this.#readHost(room, limit, waitMs);
    return copy(room.messages.slice(-Math.max(1, Math.min(500, limit))));
  }

  async createRoom({ name, members = [] }) {
    await this.ready;
    const room = { id: crypto.randomUUID(), name: ensureText(name, "room name"), createdAt: Date.now(), members: [], messages: [], pendingDeliveries: [], cursor: 0, messageOffset: 0 };
    for (const member of members) room.members.push(this.#member(member));
    this.state.rooms.push(room); await this.#save(); this.#emit({ kind: "room-created", room: { ...room, messages: [] } });
    await this.ensureRoomSessions();
    return copy({ ...room, messages: [] });
  }

  /** Consume Weave's paired-host session directory without handling endpoint tickets. */
  async remoteSessions() {
    const weave = this.#weave();
    if (!weave?.remoteSessions) return [];
    return (await weave.remoteSessions()).map((host) => ({
      ...host,
      workspaces: host.workspaces.filter((workspace) => workspace.title !== "Chatrooms").map((workspace) => ({
        ...workspace,
        sessions: workspace.sessions.filter((session) => !String(session.id).startsWith(ROOM_SESSION_PREFIX) && !String(session.id).startsWith("dsh-chat-room-"))
      })).filter((workspace) => workspace.sessions.length > 0)
    })).filter((host) => host.workspaces.length > 0);
  }

  /** Materialize one visible DSH session per durable room under Chatrooms. */
  ensureRoomSessions() {
    const operation = this.roomSessionTail.then(async () => {
      await this.ready;
      const sessions = this.ctx?.get?.("sessions") ?? this.ctx?.sessions;
      const registry = this.ctx?.get?.("workspaceRegistry") ?? this.ctx?.workspaceRegistry;
      if (!sessions || !registry) return;
      await mkdir(this.workspacePath, { recursive: true });
      const workspace = await registry.create(this.workspacePath, "Chatrooms");
      let changed = false;
      for (const room of this.state.rooms) {
        if (room.sessionId && !room.sessionId.startsWith(ROOM_SESSION_PREFIX)) {
          await workspace.detachSession?.(room.sessionId);
          delete room.sessionId;
          changed = true;
        }
        const sessionId = room.sessionId ?? `${ROOM_SESSION_PREFIX}${room.id}`;
        let session = sessions.get(sessionId);
        if (!room.sessionId) {
          if (!session) {
            const time = Date.now();
            session = sessions.create(sessionId, {
              meta: { cwd: this.workspacePath },
              seed: [
                { type: "turn/start", seq: 0, time, data: { turn: 1 } },
                { type: "chat/room-link", seq: 1, time: time + 1, data: { roomId: room.id, name: room.name, remote: Boolean(room.hostId || room.hostTicket) }, ignorable: true },
                { type: "turn/end", seq: 2, time: time + 2, data: { turn: 1, reason: { kind: "completed" } } }
              ]
            });
          }
          const existingLink = session.events?.find?.((event) => event.type === "chat/room-link");
          if (existingLink && existingLink.data?.roomId !== room.id) throw new Error(`room session ${sessionId} is already linked to another room`);
          if (!existingLink) throw new Error(`room session ${sessionId} is missing its room link`);
          const titles = this.ctx?.get?.("sessionTitle") ?? this.ctx?.sessionTitle;
          titles?.rename?.(session, room.name);
          room.sessionId = sessionId;
          changed = true;
          await sessions.flush?.(session);
        }
        await workspace.attachSession(sessionId);
      }
      if (changed) await this.#save();
    });
    this.roomSessionTail = operation.catch(() => {});
    return operation;
  }

  /** Resolve a room by durable id or by its unique human-readable name. */
  async resolveRoom(reference) {
    await this.ready;
    const needle = ensureText(reference, "room reference");
    const matches = this.state.rooms.filter((room) => room.id === needle || room.name === needle);
    if (matches.length === 0) throw new Error(`room "${needle}" does not exist`);
    if (matches.length > 1) throw new Error(`room reference "${needle}" is ambiguous; use its id`);
    return copy({ ...matches[0], messages: [] });
  }

  async addMember(roomId, member) {
    await this.ready; const room = this.#room(roomId); const normalized = this.#member(member);
    if (normalized.kind === "remote" && !this.#weave()) throw new Error("dsh-weave is not installed");
    const existing = room.members.find((item) => item.kind === normalized.kind && item.sessionId === normalized.sessionId && item.hostId === normalized.hostId);
    if (existing) {
      for (const field of ["alias", "workspaceTitle", "hostName"]) if (normalized[field]) existing[field] = normalized[field];
      await this.#save();
      if (existing.kind === "remote") await this.#invite(room, existing);
      return copy(existing);
    }
    if (normalized.kind === "remote" && !normalized.capability) normalized.capability = crypto.randomUUID();
    room.members.push(normalized);
    await this.#save(); this.#emit({ kind: "member-added", roomId, member: normalized });
    if (normalized.kind === "remote") await this.#invite(room, normalized);
    return copy(normalized);
  }

  async send({ roomId, author, authorAlias, text, mentions }) {
    await this.ready;
    const room = this.#room(roomId);
    if (room.hostId || room.hostTicket) return this.#postToHost(room, { author, authorAlias, text, mentions });
    const authorId = ensureText(author, "author");
    const member = room.members.find((item) => item.sessionId === authorId);
    if (member && !member.alias && authorAlias) { member.alias = ensureText(authorAlias, "author alias"); await this.#save(); }
    const message = { id: crypto.randomUUID(), roomId, author: authorId, authorAlias: member?.alias ?? (authorAlias ? ensureText(authorAlias, "author alias") : undefined), text: ensureText(text, "message"), mentions: this.#mentions(room, mentions), sentAt: Date.now(), deliveries: [] };
    room.messages.push(message);
    if (room.messages.length > MAX_MESSAGES_PER_ROOM) {
      const removed = room.messages.length - MAX_MESSAGES_PER_ROOM;
      room.messages.splice(0, removed);
      room.messageOffset = (room.messageOffset ?? 0) + removed;
    }
    await this.#deliver(room, message); await this.#save(); this.#emit({ kind: "message", message }); return copy(message);
  }
  /** Retry unacknowledged remote mention deliveries retained by this host. */
  async retryPendingDeliveries() { return this.#retryPendingDeliveries(); }

  #room(roomId) {
    const room = this.state.rooms.find((item) => item.id === roomId);
    if (!room) throw new Error(`room ${roomId} does not exist`);
    if (!Array.isArray(room.pendingDeliveries)) room.pendingDeliveries = [];
    if (!Array.isArray(room.messages)) room.messages = [];
    if (!Number.isSafeInteger(room.messageOffset) || room.messageOffset < 0) room.messageOffset = 0;
    return room;
  }
  #weave() { return this.ctx?.dshWeave ?? this.ctx?.get?.("dshWeave"); }
  #scheduleAliasRefresh() {
    if (this.aliasRefresh || Date.now() < this.aliasRefreshAt) return;
    this.aliasRefreshAt = Date.now() + 30_000;
    this.aliasRefresh = this.#refreshAliases().catch((error) => this.ctx?.logger?.debug?.(`dsh-chat could not refresh member aliases: ${String(error)}`)).finally(() => { this.aliasRefresh = undefined; });
  }
  async #refreshAliases() {
    const weave = this.#weave();
    if (!weave?.remoteSessions) return;
    const hosts = await weave.remoteSessions();
    const catalog = new Map();
    for (const host of hosts) for (const workspace of host.workspaces ?? []) for (const session of workspace.sessions ?? []) {
      catalog.set(String(session.id), { alias: session.displayTitle ?? session.title, workspaceTitle: workspace.title, hostName: host.hostName });
    }
    let changed = false;
    for (const room of this.state.rooms) for (const member of room.members) {
      if (member.alias) continue;
      const entry = catalog.get(member.sessionId);
      if (!entry?.alias) continue;
      member.alias = ensureText(entry.alias, "member alias");
      if (entry.workspaceTitle) member.workspaceTitle = entry.workspaceTitle;
      if (entry.hostName) member.hostName = entry.hostName;
      changed = true;
    }
    if (changed) { await this.#save(); this.#emit({ kind: "member-aliases-refreshed" }); }
  }
  async #migrateLegacyWeave(weave) {
    let changed = false;
    for (const room of this.state.rooms) {
      if (room.hostTicket && !room.hostId) { room.hostId = weave.identify(room.hostTicket); delete room.hostTicket; changed = true; }
      for (const member of room.members ?? []) {
        if (member.kind !== "weave") continue;
        member.hostId = member.hostId || weave.identify(member.ticket);
        member.kind = "remote"; delete member.ticket; changed = true;
      }
    }
    if (changed) await this.#save();
  }
  #mentions(room, mentions) {
    if (mentions === undefined) return [];
    if (!Array.isArray(mentions)) throw new TypeError("mentions must be an array");
    const resolved = mentions.map((item) => {
      const reference = ensureText(item, "mention").replace(/^@/, "");
      if (reference === "all") return reference;
      const byId = room.members.find((member) => member.sessionId === reference);
      if (byId) return byId.sessionId;
      const matches = room.members.filter((member) => member.alias?.localeCompare(reference, undefined, { sensitivity: "accent" }) === 0);
      if (matches.length === 0) throw new Error(`session mention "${reference}" does not match a room member`);
      if (matches.length > 1) throw new Error(`session mention "${reference}" is ambiguous; choose it from the member list`);
      return matches[0].sessionId;
    });
    return [...new Set(resolved)];
  }
  #member(member) {
    if (!member || (member.kind !== "session" && member.kind !== "remote")) throw new TypeError("member.kind must be session or remote");
    const normalized = { kind: member.kind, sessionId: ensureText(member.sessionId, "member sessionId") };
    for (const field of ["alias", "workspaceTitle", "hostName"]) if (member[field]) normalized[field] = ensureText(member[field], `member ${field}`);
    if (member.kind === "session" && !normalized.alias) {
      const session = (this.ctx?.get?.("sessions") ?? this.ctx?.sessions)?.get?.(normalized.sessionId);
      const title = session && (this.ctx?.get?.("sessionTitle") ?? this.ctx?.sessionTitle)?.get?.(session)?.title;
      if (title) normalized.alias = ensureText(title, "member alias");
    }
    if (member.kind === "remote") { normalized.hostId = ensureText(member.hostId, "remote hostId"); if (member.capability) normalized.capability = ensureText(member.capability, "room capability"); }
    return normalized;
  }
  #memberView(member) {
    const { capability, ...view } = member;
    if (!view.alias) {
      const session = (this.ctx?.get?.("sessions") ?? this.ctx?.sessions)?.get?.(view.sessionId);
      const title = session && (this.ctx?.get?.("sessionTitle") ?? this.ctx?.sessionTitle)?.get?.(session)?.title;
      if (title) view.alias = title;
    }
    return view;
  }

  async #deliver(room, message) {
    const bridge = this.ctx?.dshBridge ?? this.ctx?.get?.("dshBridge"); const weave = this.#weave();
    const recipients = message.mentions.includes("all")
      ? room.members
      : room.members.filter((member) => message.mentions.includes(member.sessionId));
    for (const member of recipients) {
      if (member.sessionId === message.author) continue;
      try {
        if (member.kind === "session") {
          if (!bridge) throw new Error("dsh-bridge is not installed");
          bridge.deliverExternal(`chat:${room.id}:${message.author}`, member.sessionId, this.#agentDeliveryText(room, message), { id: message.id, transport: "chat" });
        } else {
          if (!weave) throw new Error("dsh-weave is not installed");
          await this.#deliverRemote(room, member, message);
        }
        message.deliveries.push({ member: member.sessionId, kind: member.kind, status: "delivered" });
      } catch (error) { message.deliveries.push({ member: member.sessionId, kind: member.kind, status: "failed", error: String(error.message ?? error) }); }
    }
  }

  #agentDeliveryText(room, message) {
    const sender = room.members.find((member) => member.sessionId === message.author);
    if (sender) {
      const alias = sender.alias ?? message.authorAlias ?? message.author;
      return `[${room.name}] ${message.text}\n\n[DSH Chat delivery: a normal assistant reply stays only in this session and is not posted to the room. To answer ${alias} in the room, call chat_send with room "${room.name}" and mentions ["${alias}"].]`;
    }
    return `[${room.name}] ${message.text}\n\n[DSH Chat delivery: this message was sent by a human room participant. A normal assistant reply stays only in this session and is not posted to the room. To reply visibly to the human, call chat_send with room "${room.name}" and omit mentions. This posts to the room timeline without waking another agent.]`;
  }

  async #invite(room, member) {
    const weave = this.#weave();
    await weave.sendTo({ hostId: member.hostId, from: `chat:${room.id}:invite`, to: WEAVE_TARGET, text: JSON.stringify({ protocol: WEAVE_PROTOCOL, kind: "room.invite", room: { id: room.id, name: room.name, members: room.members.map((item) => this.#memberView(item)) }, recipient: member.sessionId, recipientAlias: member.alias, capability: member.capability }) });
  }
  async #deliverRemote(room, member, message, pending) {
    const weave = this.#weave();
    const record = pending ?? { id: message.id, recipient: member.sessionId, message, createdAt: Date.now(), expiresAt: Date.now() + DELIVERY_TTL_MS, attempts: 0 };
    if (!pending) { room.pendingDeliveries.push(record); await this.#save(); }
    try {
      record.attempts += 1;
      await weave.sendTo({ hostId: member.hostId, from: `chat:${room.id}:${message.author}`, to: WEAVE_TARGET, text: JSON.stringify({ protocol: WEAVE_PROTOCOL, kind: "room.delivery", roomId: room.id, roomName: room.name, message, recipient: member.sessionId, capability: member.capability }), id: message.id });
      room.pendingDeliveries = room.pendingDeliveries.filter((item) => item !== record);
      await this.#save();
    } catch (error) {
      await this.#save();
      throw error;
    }
  }
  #schedulePendingRetry() {
    if (this.pendingRetryTimer) return;
    this.pendingRetryTimer = setTimeout(async () => {
      this.pendingRetryTimer = undefined;
      try { await this.#retryPendingDeliveries(); } finally { this.#schedulePendingRetry(); }
    }, 30_000);
    this.pendingRetryTimer.unref?.();
  }
  async #retryPendingDeliveries() {
    await this.ready;
    for (const room of this.state.rooms) {
      if (room.hostId || room.hostTicket || !Array.isArray(room.pendingDeliveries)) continue;
      const now = Date.now(); let changed = false;
      for (const pending of [...room.pendingDeliveries]) {
        if (pending.expiresAt <= now) { room.pendingDeliveries = room.pendingDeliveries.filter((item) => item !== pending); changed = true; continue; }
        const member = room.members.find((item) => item.kind === "remote" && item.sessionId === pending.recipient);
        if (!member) { room.pendingDeliveries = room.pendingDeliveries.filter((item) => item !== pending); changed = true; continue; }
        try { await this.#deliverRemote(room, member, pending.message, pending); } catch {}
      }
      if (changed) await this.#save();
    }
  }
  async #readHost(room, limit, waitMs) {
    // Older linked rooms persisted only the remote cursor, so a reload could
    // resume after the entire history while having no local timeline to show.
    // Rewind those rooms once, then retain a bounded read-only cache.
    if (room.messages.length === 0 && (room.cursor ?? 0) > 0) room.cursor = 0;
    const reply = await this.#request(room.hostId, { kind: "room.read", roomId: room.id, capability: room.capability, cursor: room.cursor ?? 0, limit: Math.max(1, Math.min(500, Number(limit) || 100)), waitMs: Math.max(0, Math.min(MAX_READ_WAIT_MS, Number(waitMs) || 0)) });
    const known = new Set(room.messages.map((message) => message.id));
    for (const message of reply.events ?? []) if (!known.has(message.id)) { room.messages.push(message); known.add(message.id); }
    if (room.messages.length > MAX_MESSAGES_PER_ROOM) room.messages.splice(0, room.messages.length - MAX_MESSAGES_PER_ROOM);
    room.cursor = reply.cursor;
    if (Array.isArray(reply.members)) room.members = reply.members.map((member) => this.#member(member));
    await this.#save();
    return copy(room.messages.slice(-Math.max(1, Math.min(500, Number(limit) || 100))));
  }
  async #postToHost(room, request) {
    return this.#request(room.hostId, { kind: "room.post", roomId: room.id, capability: room.capability, sender: room.linkedSessionId, ...request });
  }
  async #request(hostId, payload) { const weave = this.#weave(); if (!weave) throw new Error("dsh-weave is not installed"); const sent = await weave.sendTo({ hostId, from: "chat-client", to: WEAVE_TARGET, text: JSON.stringify({ protocol: WEAVE_PROTOCOL, ...payload }) }); return sent.result; }
  async #receiveWeave(frame) {
    if (frame.to !== WEAVE_TARGET) return false; let payload; try { payload = JSON.parse(frame.text); } catch { return false; }
    if (payload.protocol !== WEAVE_PROTOCOL) return false; await this.ready;
    if (payload.kind === "room.invite") { await this.#acceptInvite(payload, frame.peerId); return true; }
    if (payload.kind === "room.read") {
      const room = this.#room(payload.roomId); this.#authorize(room, payload.capability, undefined, frame.peerId);
      const offset = room.messageOffset ?? 0;
      const cursor = Math.max(offset, Number(payload.cursor) || 0); const limit = Math.min(500, payload.limit ?? 100);
      const read = () => room.messages.slice(Math.max(0, cursor - offset), Math.max(0, cursor - offset) + limit);
      let events = read();
      if (events.length === 0 && payload.waitMs) { await this.#waitForMessages(room.id, cursor, payload.waitMs); events = read(); }
      return { claimed: true, result: { cursor: cursor + events.length, events: copy(events), members: room.members.map((member) => this.#memberView(member)) } };
    }
    if (payload.kind === "room.post") {
      const room = this.#room(payload.roomId);
      const member = this.#authorize(room, payload.capability, payload.sender ?? payload.author, frame.peerId);
      const roomViewAuthor = `${ROOM_SESSION_PREFIX}${room.id}`;
      if (payload.author !== member.sessionId && payload.author !== roomViewAuthor) throw new Error("room post author denied");
      const author = payload.author === roomViewAuthor ? `dsh-chat-human:${frame.peerId}:${room.id}` : member.sessionId;
      const message = await this.send({ roomId: payload.roomId, author, authorAlias: payload.authorAlias, text: payload.text, mentions: payload.mentions });
      return { claimed: true, result: message };
    }
    if (payload.kind === "room.delivery") {
      const room = this.#room(payload.roomId);
      if (room.hostId !== frame.peerId || room.capability !== payload.capability || room.linkedSessionId !== payload.recipient) throw new Error("room delivery capability denied");
      const bridge = this.ctx?.dshBridge ?? this.ctx?.get?.("dshBridge");
      if (!bridge) throw new Error("dsh-bridge is not installed");
      bridge.deliverExternal(`chat:${payload.roomId}:${payload.message.author}`, payload.recipient, this.#agentDeliveryText(room, payload.message), { id: payload.message.id, transport: "chat" });
      return true;
    }
    return false;
  }
  async #acceptInvite(payload, hostId) {
    const id = ensureText(payload?.room?.id, "room id"); const existing = this.state.rooms.find((room) => room.id === id);
    if (existing) {
      if (existing.hostId !== hostId) throw new Error("room invite host mismatch");
      existing.name = ensureText(payload.room.name, "room name");
      existing.linkedSessionId = ensureText(payload.recipient, "linked session id");
      if (payload.recipientAlias) existing.linkedSessionAlias = ensureText(payload.recipientAlias, "linked session alias");
      if (Array.isArray(payload.room.members)) existing.members = payload.room.members.map((member) => this.#member(member));
      existing.capability = ensureText(payload.capability, "room capability");
      await this.#save(); await this.ensureRoomSessions(); this.#emit({ kind: "room-linked", roomId: id }); return;
    }
    this.state.rooms.push({ id, name: ensureText(payload.room.name, "room name"), createdAt: Date.now(), members: Array.isArray(payload.room.members) ? payload.room.members.map((member) => this.#member(member)) : [], messages: [], pendingDeliveries: [], hostId: ensureText(hostId, "host id"), linkedSessionId: ensureText(payload.recipient, "linked session id"), linkedSessionAlias: payload.recipientAlias ? ensureText(payload.recipientAlias, "linked session alias") : undefined, capability: ensureText(payload.capability, "room capability"), cursor: 0, messageOffset: 0 }); await this.#save(); await this.ensureRoomSessions(); this.#emit({ kind: "room-linked", roomId: id });
  }
  #waitForMessages(roomId, cursor, waitMs) {
    return new Promise((resolve) => {
      let unsubscribe; const done = () => { clearTimeout(timer); unsubscribe?.(); resolve(); };
      const timer = setTimeout(done, Math.max(0, Math.min(MAX_READ_WAIT_MS, Number(waitMs) || 0)));
      timer.unref?.();
      unsubscribe = this.subscribe((event) => {
        const room = this.#room(roomId);
        if (event.kind === "message" && event.message.roomId === roomId && (room.messageOffset ?? 0) + room.messages.length > cursor) done();
      });
    });
  }
  #authorize(room, capability, author, hostId) {
    const member = room.members.find((item) => item.kind === "remote" && item.hostId === hostId && item.capability === capability);
    if (!member || (author && member.sessionId !== author)) throw new Error("room capability denied");
    return member;
  }
}
