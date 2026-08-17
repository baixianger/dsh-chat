import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const EMPTY = Object.freeze({ version: 1, rooms: [] });
const MAX_MESSAGES_PER_ROOM = 2_000;
const WEAVE_TARGET = "dsh-chat";
const WEAVE_FRAME = "dsh-chat/1";

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

  /** Attach the optional Weave protocol consumer once the transport is available. */
  attachWeave() {
    if (this.unsubscribeWeave) return;
    const weave = this.#weave();
    if (weave) this.unsubscribeWeave = weave.subscribe((frame) => this.#receiveWeave(frame));
  }

  async listRooms() { await this.ready; return copy(this.state.rooms.map(({ messages, ...room }) => ({ ...room, messageCount: messages.length }))); }
  async messages(roomId, limit = 100) {
    await this.ready; const room = this.#room(roomId);
    return copy(room.messages.slice(-Math.max(1, Math.min(500, limit))));
  }

  async createRoom({ name, members = [] }) {
    await this.ready;
    const room = { id: crypto.randomUUID(), name: ensureText(name, "room name"), createdAt: Date.now(), members: [], messages: [] };
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
      const weave = this.#weave();
      if (!weave) throw new Error("dsh-weave is not installed");
      await weave.trust(normalized.ticket);
    }
    if (!room.members.some((item) => item.kind === normalized.kind && item.sessionId === normalized.sessionId && item.ticket === normalized.ticket)) room.members.push(normalized);
    await this.#save(); this.#emit({ kind: "member-added", roomId, member: normalized });
    if (normalized.kind === "weave") await this.#inviteRemote(room, normalized);
    return copy(normalized);
  }

  async send({ roomId, author, text, mentions }) {
    await this.ready;
    const room = this.#room(roomId); const message = { id: crypto.randomUUID(), roomId, author: ensureText(author, "author"), text: ensureText(text, "message"), mentions: this.#mentions(mentions), sentAt: Date.now(), deliveries: [] };
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
    if (member.kind === "weave") normalized.ticket = ensureText(member.ticket, "weave ticket");
    return normalized;
  }

  async #deliver(room, message) {
    const bridge = this.ctx?.dshBridge ?? this.ctx?.get?.("dshBridge"); const weave = this.#weave();
    // Public room posts still synchronize to every remote room timeline, but
    // only an explicit @mention wakes an agent.
    const localRecipients = message.mentions.includes("all")
      ? room.members.filter((member) => member.kind === "session")
      : room.members.filter((member) => member.kind === "session" && message.mentions.includes(member.sessionId));
    const remoteRecipients = room.members.filter((member) => member.kind === "weave");
    for (const member of localRecipients) {
      if (member.sessionId === message.author) continue;
      try {
        if (!bridge) throw new Error("dsh-bridge is not installed");
        bridge.deliverExternal(`chat:${room.id}:${message.author}`, member.sessionId, `[${room.name}] ${message.text}`, { id: message.id, transport: "chat" });
        message.deliveries.push({ member: member.sessionId, kind: member.kind, status: "delivered" });
      } catch (error) { message.deliveries.push({ member: member.sessionId, kind: member.kind, status: "failed", error: String(error.message ?? error) }); }
    }
    for (const member of remoteRecipients) {
      try {
        if (!weave) throw new Error("dsh-weave is not installed");
        await weave.send({ ticket: member.ticket, from: `chat:${room.id}:${message.author}`, to: WEAVE_TARGET, text: JSON.stringify({ protocol: WEAVE_FRAME, kind: "message", room: { id: room.id, name: room.name }, message }), id: message.id });
        message.deliveries.push({ member: member.sessionId, kind: member.kind, status: "delivered" });
      } catch (error) { message.deliveries.push({ member: member.sessionId, kind: member.kind, status: "failed", error: String(error.message ?? error) }); }
    }
  }

  async #inviteRemote(room, member) {
    const weave = this.#weave();
    if (!weave) throw new Error("dsh-weave is not installed");
    const ticket = await weave.ticket();
    const localMembers = room.members.filter((item) => item.kind === "session").map((item) => ({ kind: "session", sessionId: item.sessionId }));
    await weave.send({ ticket: member.ticket, from: `chat:${room.id}:invite`, to: WEAVE_TARGET, text: JSON.stringify({ protocol: WEAVE_FRAME, kind: "invite", room: { id: room.id, name: room.name }, recipient: member.sessionId, sender: { ticket, members: localMembers } }) });
  }

  async #receiveWeave(frame) {
    if (frame.to !== WEAVE_TARGET) return false;
    let payload;
    try { payload = JSON.parse(frame.text); } catch { return false; }
    if (payload?.protocol !== WEAVE_FRAME || !["invite", "message"].includes(payload.kind)) return false;
    await this.ready;
    if (payload.kind === "invite") await this.#acceptInvite(payload);
    else await this.#acceptMessage(payload);
    return true;
  }

  async #acceptInvite(payload) {
    const roomId = ensureText(payload?.room?.id, "remote room id"); const roomName = ensureText(payload?.room?.name, "remote room name");
    const recipient = ensureText(payload?.recipient, "remote recipient"); const ticket = ensureText(payload?.sender?.ticket, "sender ticket");
    const senderMembers = Array.isArray(payload?.sender?.members) ? payload.sender.members.map((member) => this.#member(member)) : [];
    let room = this.state.rooms.find((item) => item.id === roomId);
    if (!room) { room = { id: roomId, name: roomName, createdAt: Date.now(), members: [], messages: [] }; this.state.rooms.push(room); }
    const mirrored = [...senderMembers.map((member) => ({ kind: "weave", sessionId: member.sessionId, ticket })), { kind: "session", sessionId: recipient }];
    for (const member of mirrored) if (!room.members.some((item) => item.kind === member.kind && item.sessionId === member.sessionId && item.ticket === member.ticket)) room.members.push(member);
    await this.#save(); this.#emit({ kind: "remote-room-invited", room: copy({ ...room, messages: [] }) });
  }

  async #acceptMessage(payload) {
    const roomId = ensureText(payload?.room?.id, "remote room id"); const room = this.#room(roomId); const incoming = payload?.message;
    if (!incoming || typeof incoming !== "object") throw new TypeError("remote message is invalid");
    if (room.messages.some((message) => message.id === incoming.id)) return;
    const message = { id: ensureText(incoming.id, "message id"), roomId, author: ensureText(incoming.author, "author"), text: ensureText(incoming.text, "message"), mentions: this.#mentions(incoming.mentions), sentAt: Number(incoming.sentAt) || Date.now(), deliveries: [] };
    room.messages.push(message); if (room.messages.length > MAX_MESSAGES_PER_ROOM) room.messages.splice(0, room.messages.length - MAX_MESSAGES_PER_ROOM);
    // Only explicitly mentioned local members are delivered into agent context.
    const bridge = this.ctx?.dshBridge ?? this.ctx?.get?.("dshBridge");
    const recipients = message.mentions.includes("all") ? room.members.filter((member) => member.kind === "session") : room.members.filter((member) => member.kind === "session" && message.mentions.includes(member.sessionId));
    for (const member of recipients) if (member.sessionId !== message.author) {
      try { if (!bridge) throw new Error("dsh-bridge is not installed"); bridge.deliverExternal(`chat:${room.id}:${message.author}`, member.sessionId, `[${room.name}] ${message.text}`, { id: message.id, transport: "chat" }); message.deliveries.push({ member: member.sessionId, kind: member.kind, status: "delivered" }); }
      catch (error) { message.deliveries.push({ member: member.sessionId, kind: member.kind, status: "failed", error: String(error.message ?? error) }); }
    }
    await this.#save(); this.#emit({ kind: "remote-message", message: copy(message) });
  }
}
