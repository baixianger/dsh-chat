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

  async listRooms() { await this.ready; return copy(this.state.rooms.map(({ messages, pendingDeliveries, ...room }) => ({ ...room, messageCount: messages.length }))); }
  async messages(roomId, limit = 100, waitMs = 0) {
    await this.ready; const room = this.#room(roomId);
    if (room.hostId || room.hostTicket) return this.#readHost(room, limit, waitMs);
    return copy(room.messages.slice(-Math.max(1, Math.min(500, limit))));
  }

  async createRoom({ name, members = [] }) {
    await this.ready;
    const room = { id: crypto.randomUUID(), name: ensureText(name, "room name"), createdAt: Date.now(), members: [], messages: [], pendingDeliveries: [], cursor: 0 };
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
      if (existing.kind === "remote") await this.#invite(room, existing);
      return copy(existing);
    }
    if (normalized.kind === "remote" && !normalized.capability) normalized.capability = crypto.randomUUID();
    room.members.push(normalized);
    await this.#save(); this.#emit({ kind: "member-added", roomId, member: normalized });
    if (normalized.kind === "remote") await this.#invite(room, normalized);
    return copy(normalized);
  }

  async send({ roomId, author, text, mentions }) {
    await this.ready;
    const room = this.#room(roomId);
    if (room.hostId || room.hostTicket) return this.#postToHost(room, { author, text, mentions });
    const message = { id: crypto.randomUUID(), roomId, author: ensureText(author, "author"), text: ensureText(text, "message"), mentions: this.#mentions(mentions), sentAt: Date.now(), deliveries: [] };
    room.messages.push(message); if (room.messages.length > MAX_MESSAGES_PER_ROOM) room.messages.splice(0, room.messages.length - MAX_MESSAGES_PER_ROOM);
    await this.#deliver(room, message); await this.#save(); this.#emit({ kind: "message", message }); return copy(message);
  }
  /** Retry unacknowledged remote mention deliveries retained by this host. */
  async retryPendingDeliveries() { return this.#retryPendingDeliveries(); }

  #room(roomId) {
    const room = this.state.rooms.find((item) => item.id === roomId);
    if (!room) throw new Error(`room ${roomId} does not exist`);
    if (!Array.isArray(room.pendingDeliveries)) room.pendingDeliveries = [];
    return room;
  }
  #weave() { return this.ctx?.dshWeave ?? this.ctx?.get?.("dshWeave"); }
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
  #mentions(mentions) {
    if (mentions === undefined) return [];
    if (!Array.isArray(mentions)) throw new TypeError("mentions must be an array");
    return [...new Set(mentions.map((item) => ensureText(item, "mention").replace(/^@/, "")))];
  }
  #member(member) {
    if (!member || (member.kind !== "session" && member.kind !== "remote")) throw new TypeError("member.kind must be session or remote");
    const normalized = { kind: member.kind, sessionId: ensureText(member.sessionId, "member sessionId") };
    if (member.kind === "remote") { normalized.hostId = ensureText(member.hostId, "remote hostId"); if (member.capability) normalized.capability = ensureText(member.capability, "room capability"); }
    return normalized;
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
          bridge.deliverExternal(`chat:${room.id}:${message.author}`, member.sessionId, `[${room.name}] ${message.text}`, { id: message.id, transport: "chat" });
        } else {
          if (!weave) throw new Error("dsh-weave is not installed");
          await this.#deliverRemote(room, member, message);
        }
        message.deliveries.push({ member: member.sessionId, kind: member.kind, status: "delivered" });
      } catch (error) { message.deliveries.push({ member: member.sessionId, kind: member.kind, status: "failed", error: String(error.message ?? error) }); }
    }
  }

  async #invite(room, member) {
    const weave = this.#weave();
    await weave.sendTo({ hostId: member.hostId, from: `chat:${room.id}:invite`, to: WEAVE_TARGET, text: JSON.stringify({ protocol: WEAVE_PROTOCOL, kind: "room.invite", room: { id: room.id, name: room.name }, recipient: member.sessionId, capability: member.capability }) });
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
    const reply = await this.#request(room.hostId, { kind: "room.read", roomId: room.id, capability: room.capability, cursor: room.cursor ?? 0, limit, waitMs: Math.max(0, Math.min(MAX_READ_WAIT_MS, Number(waitMs) || 0)) });
    room.cursor = reply.cursor; await this.#save(); return reply.events;
  }
  async #postToHost(room, request) { return this.#request(room.hostId, { kind: "room.post", roomId: room.id, capability: room.capability, ...request }); }
  async #request(hostId, payload) { const weave = this.#weave(); if (!weave) throw new Error("dsh-weave is not installed"); const sent = await weave.sendTo({ hostId, from: "chat-client", to: WEAVE_TARGET, text: JSON.stringify({ protocol: WEAVE_PROTOCOL, ...payload }) }); return sent.result; }
  async #receiveWeave(frame) {
    if (frame.to !== WEAVE_TARGET) return false; let payload; try { payload = JSON.parse(frame.text); } catch { return false; }
    if (payload.protocol !== WEAVE_PROTOCOL) return false; await this.ready;
    if (payload.kind === "room.invite") { await this.#acceptInvite(payload, frame.peerId); return true; }
    if (payload.kind === "room.read") {
      const room = this.#room(payload.roomId); this.#authorize(room, payload.capability, undefined, frame.peerId);
      const cursor = Math.max(0, Number(payload.cursor) || 0); const limit = Math.min(500, payload.limit ?? 100);
      let events = room.messages.slice(cursor, cursor + limit);
      if (events.length === 0 && payload.waitMs) { await this.#waitForMessages(room.id, cursor, payload.waitMs); events = room.messages.slice(cursor, cursor + limit); }
      return { claimed: true, result: { cursor: room.messages.length, events: copy(events) } };
    }
    if (payload.kind === "room.post") { const room = this.#room(payload.roomId); this.#authorize(room, payload.capability, payload.author, frame.peerId); const message = await this.send({ roomId: payload.roomId, author: payload.author, text: payload.text, mentions: payload.mentions }); return { claimed: true, result: message }; }
    if (payload.kind === "room.delivery") {
      const room = this.#room(payload.roomId);
      if (room.hostId !== frame.peerId || room.capability !== payload.capability || room.linkedSessionId !== payload.recipient) throw new Error("room delivery capability denied");
      const bridge = this.ctx?.dshBridge ?? this.ctx?.get?.("dshBridge");
      if (!bridge) throw new Error("dsh-bridge is not installed");
      bridge.deliverExternal(`chat:${payload.roomId}:${payload.message.author}`, payload.recipient, `[${payload.roomName}] ${payload.message.text}`, { id: payload.message.id, transport: "chat" });
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
      existing.capability = ensureText(payload.capability, "room capability");
      await this.#save(); await this.ensureRoomSessions(); this.#emit({ kind: "room-linked", roomId: id }); return;
    }
    this.state.rooms.push({ id, name: ensureText(payload.room.name, "room name"), createdAt: Date.now(), members: [], messages: [], pendingDeliveries: [], hostId: ensureText(hostId, "host id"), linkedSessionId: ensureText(payload.recipient, "linked session id"), capability: ensureText(payload.capability, "room capability"), cursor: 0 }); await this.#save(); await this.ensureRoomSessions(); this.#emit({ kind: "room-linked", roomId: id });
  }
  #waitForMessages(roomId, cursor, waitMs) {
    return new Promise((resolve) => {
      let unsubscribe; const done = () => { clearTimeout(timer); unsubscribe?.(); resolve(); };
      const timer = setTimeout(done, Math.max(0, Math.min(MAX_READ_WAIT_MS, Number(waitMs) || 0)));
      timer.unref?.();
      unsubscribe = this.subscribe((event) => { if (event.kind === "message" && event.message.roomId === roomId && this.#room(roomId).messages.length > cursor) done(); });
    });
  }
  #authorize(room, capability, author, hostId) { const member = room.members.find((item) => item.kind === "remote" && item.hostId === hostId && item.capability === capability); if (!member || (author && member.sessionId !== author)) throw new Error("room capability denied"); }
}
