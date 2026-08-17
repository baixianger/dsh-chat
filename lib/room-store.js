import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const EMPTY = Object.freeze({ version: 1, rooms: [] });
const MAX_MESSAGES_PER_ROOM = 2_000;

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

  async addMember(roomId, member) {
    await this.ready; const room = this.#room(roomId); const normalized = this.#member(member);
    if (normalized.kind === "weave") {
      const weave = this.ctx?.get?.("dshWeave");
      if (!weave) throw new Error("dsh-weave is not installed");
      await weave.trust(normalized.ticket);
    }
    if (!room.members.some((item) => item.kind === normalized.kind && item.sessionId === normalized.sessionId && item.ticket === normalized.ticket)) room.members.push(normalized);
    await this.#save(); this.#emit({ kind: "member-added", roomId, member: normalized }); return copy(normalized);
  }

  async send({ roomId, author, text }) {
    await this.ready;
    const room = this.#room(roomId); const message = { id: crypto.randomUUID(), roomId, author: ensureText(author, "author"), text: ensureText(text, "message"), sentAt: Date.now(), deliveries: [] };
    room.messages.push(message); if (room.messages.length > MAX_MESSAGES_PER_ROOM) room.messages.splice(0, room.messages.length - MAX_MESSAGES_PER_ROOM);
    await this.#deliver(room, message); await this.#save(); this.#emit({ kind: "message", message }); return copy(message);
  }

  #room(roomId) { const room = this.state.rooms.find((item) => item.id === roomId); if (!room) throw new Error(`room ${roomId} does not exist`); return room; }
  #member(member) {
    if (!member || (member.kind !== "session" && member.kind !== "weave")) throw new TypeError("member.kind must be session or weave");
    const normalized = { kind: member.kind, sessionId: ensureText(member.sessionId, "member sessionId") };
    if (member.kind === "weave") normalized.ticket = ensureText(member.ticket, "weave ticket");
    return normalized;
  }

  async #deliver(room, message) {
    const bridge = this.ctx?.get?.("dshBridge"); const weave = this.ctx?.get?.("dshWeave");
    for (const member of room.members) {
      if (member.sessionId === message.author) continue;
      try {
        if (member.kind === "session") {
          if (!bridge) throw new Error("dsh-bridge is not installed");
          bridge.deliverExternal(`chat:${room.id}:${message.author}`, member.sessionId, `[${room.name}] ${message.text}`, { id: message.id, transport: "chat" });
        } else {
          if (!weave) throw new Error("dsh-weave is not installed");
          await weave.send({ ticket: member.ticket, from: `chat:${room.id}:${message.author}`, to: member.sessionId, text: `[${room.name}] ${message.text}`, id: message.id });
        }
        message.deliveries.push({ member: member.sessionId, kind: member.kind, status: "delivered" });
      } catch (error) { message.deliveries.push({ member: member.sessionId, kind: member.kind, status: "failed", error: String(error.message ?? error) }); }
    }
  }
}
