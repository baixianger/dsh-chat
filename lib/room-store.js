import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const EMPTY = Object.freeze({ version: 1, rooms: [] });
const MAX_MESSAGES_PER_ROOM = 2_000;
const WEAVE_TARGET = "dsh-chat/2";
const WEAVE_PROTOCOL = "dsh-chat/2";

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
    this.state = copy(EMPTY);
    this.ready = this.#load();
    this.listeners = new Set();
    this.unsubscribeWeave = undefined;
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
    if (weave) { this.unsubscribeWeave = weave.subscribe((frame) => this.#receiveWeave(frame)); return; }
    // Accessors are installed by independently activated Cordis plugins. Retry
    // briefly instead of making dshWeave a static inject dependency, which is
    // not a declared service in older DSH bundle contracts.
    if (attempt < 100) setTimeout(() => this.attachWeave(attempt + 1), 100);
  }

  async listRooms() { await this.ready; return copy(this.state.rooms.map(({ messages, ...room }) => ({ ...room, messageCount: messages.length }))); }
  async messages(roomId, limit = 100) {
    await this.ready; const room = this.#room(roomId);
    if (room.hostTicket) return this.#readHost(room, limit);
    return copy(room.messages.slice(-Math.max(1, Math.min(500, limit))));
  }

  async createRoom({ name, members = [] }) {
    await this.ready;
    const room = { id: crypto.randomUUID(), name: ensureText(name, "room name"), createdAt: Date.now(), members: [], messages: [], cursor: 0 };
    for (const member of members) room.members.push(this.#member(member));
    this.state.rooms.push(room); await this.#save(); this.#emit({ kind: "room-created", room: { ...room, messages: [] } });
    return copy({ ...room, messages: [] });
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
    if (normalized.kind === "weave") {
      const weave = this.ctx?.dshWeave ?? this.ctx?.get?.("dshWeave");
      if (!weave) throw new Error("dsh-weave is not installed");
      await weave.trust(normalized.ticket);
    }
    if (normalized.kind === "weave" && !normalized.capability) normalized.capability = crypto.randomUUID();
    if (!room.members.some((item) => item.kind === normalized.kind && item.sessionId === normalized.sessionId && item.ticket === normalized.ticket)) room.members.push(normalized);
    await this.#save(); this.#emit({ kind: "member-added", roomId, member: normalized });
    if (normalized.kind === "weave") await this.#invite(room, normalized);
    return copy(normalized);
  }

  async send({ roomId, author, text, mentions }) {
    await this.ready;
    const room = this.#room(roomId);
    if (room.hostTicket) return this.#postToHost(room, { author, text, mentions });
    const message = { id: crypto.randomUUID(), roomId, author: ensureText(author, "author"), text: ensureText(text, "message"), mentions: this.#mentions(mentions), sentAt: Date.now(), deliveries: [] };
    room.messages.push(message); if (room.messages.length > MAX_MESSAGES_PER_ROOM) room.messages.splice(0, room.messages.length - MAX_MESSAGES_PER_ROOM);
    await this.#deliver(room, message); await this.#save(); this.#emit({ kind: "message", message }); return copy(message);
  }

  #room(roomId) { const room = this.state.rooms.find((item) => item.id === roomId); if (!room) throw new Error(`room ${roomId} does not exist`); return room; }
  #weave() { return this.ctx?.dshWeave ?? this.ctx?.get?.("dshWeave"); }
  #mentions(mentions) {
    if (mentions === undefined) return [];
    if (!Array.isArray(mentions)) throw new TypeError("mentions must be an array");
    return [...new Set(mentions.map((item) => ensureText(item, "mention").replace(/^@/, "")))];
  }
  #member(member) {
    if (!member || (member.kind !== "session" && member.kind !== "weave")) throw new TypeError("member.kind must be session or weave");
    const normalized = { kind: member.kind, sessionId: ensureText(member.sessionId, "member sessionId") };
    if (member.kind === "weave") { normalized.ticket = ensureText(member.ticket, "weave ticket"); if (member.capability) normalized.capability = ensureText(member.capability, "room capability"); }
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
          await weave.send({ ticket: member.ticket, from: `chat:${room.id}:${message.author}`, to: WEAVE_TARGET, text: JSON.stringify({ protocol: WEAVE_PROTOCOL, kind: "room.delivery", roomId: room.id, roomName: room.name, message, recipient: member.sessionId }), id: message.id });
        }
        message.deliveries.push({ member: member.sessionId, kind: member.kind, status: "delivered" });
      } catch (error) { message.deliveries.push({ member: member.sessionId, kind: member.kind, status: "failed", error: String(error.message ?? error) }); }
    }
  }

  async #invite(room, member) {
    const weave = this.#weave(); const hostTicket = await weave.ticket();
    await weave.send({ ticket: member.ticket, from: `chat:${room.id}:invite`, to: WEAVE_TARGET, text: JSON.stringify({ protocol: WEAVE_PROTOCOL, kind: "room.invite", room: { id: room.id, name: room.name }, hostTicket, capability: member.capability }) });
  }
  async #readHost(room, limit) {
    const reply = await this.#request(room.hostTicket, { kind: "room.read", roomId: room.id, capability: room.capability, cursor: room.cursor ?? 0, limit });
    room.cursor = reply.cursor; await this.#save(); return reply.events;
  }
  async #postToHost(room, request) { return this.#request(room.hostTicket, { kind: "room.post", roomId: room.id, capability: room.capability, ...request }); }
  async #request(ticket, payload) { const weave = this.#weave(); if (!weave) throw new Error("dsh-weave is not installed"); const sent = await weave.send({ ticket, from: "chat-client", to: WEAVE_TARGET, text: JSON.stringify({ protocol: WEAVE_PROTOCOL, ...payload }) }); return sent.result; }
  async #receiveWeave(frame) {
    if (frame.to !== WEAVE_TARGET) return false; let payload; try { payload = JSON.parse(frame.text); } catch { return false; }
    if (payload.protocol !== WEAVE_PROTOCOL) return false; await this.ready;
    if (payload.kind === "room.invite") { await this.#acceptInvite(payload); return true; }
    if (payload.kind === "room.read") { const room = this.#room(payload.roomId); this.#authorize(room, payload.capability); const cursor = Math.max(0, Number(payload.cursor) || 0); return { claimed: true, result: { cursor: room.messages.length, events: copy(room.messages.slice(cursor, cursor + Math.min(500, payload.limit ?? 100))) } }; }
    if (payload.kind === "room.post") { const room = this.#room(payload.roomId); this.#authorize(room, payload.capability, payload.author); const message = await this.send({ roomId: payload.roomId, author: payload.author, text: payload.text, mentions: payload.mentions }); return { claimed: true, result: message }; }
    if (payload.kind === "room.delivery") { const bridge = this.ctx?.dshBridge ?? this.ctx?.get?.("dshBridge"); if (bridge && payload.recipient) bridge.deliverExternal(`chat:${payload.roomId}:${payload.message.author}`, payload.recipient, `[${payload.roomName}] ${payload.message.text}`, { id: payload.message.id, transport: "chat" }); return true; }
    return false;
  }
  async #acceptInvite(payload) {
    const id = ensureText(payload?.room?.id, "room id"); if (this.state.rooms.some((room) => room.id === id)) return;
    const hostTicket = ensureText(payload.hostTicket, "host ticket"); const weave = this.#weave(); await weave.trust(hostTicket);
    this.state.rooms.push({ id, name: ensureText(payload.room.name, "room name"), createdAt: Date.now(), members: [], messages: [], hostTicket, capability: ensureText(payload.capability, "room capability"), cursor: 0 }); await this.#save(); this.#emit({ kind: "room-linked", roomId: id });
  }
  #authorize(room, capability, author) { const member = room.members.find((item) => item.kind === "weave" && item.capability === capability); if (!member || (author && member.sessionId !== author)) throw new Error("room capability denied"); }
}
