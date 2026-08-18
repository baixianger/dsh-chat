import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DshChatService } from "../lib/index.js";

test("room messages fan out through Bridge and persist", async () => {
  const calls = [];
  const ctx = { get(name) { return name === "dshBridge" ? { deliverExternal(...args) { calls.push(args); } } : undefined; } };
  const service = new DshChatService(ctx, { path: join(await mkdtemp(join(tmpdir(), "dsh-chat-")), "rooms.json") });
  const room = await service.createRoom({ name: "Build", members: [{ kind: "session", sessionId: "alice" }, { kind: "session", sessionId: "bob" }] });
  const message = await service.send({ roomId: room.id, author: "alice", text: "ship it", mentions: ["all"] });
  assert.equal(calls.length, 1); assert.equal(calls[0][1], "bob"); assert.match(calls[0][2], /ship it/);
  assert.match(calls[0][2], /normal assistant reply stays only in this session/);
  assert.match(calls[0][2], /call chat_send/);
  assert.match(calls[0][2], /mentions \["alice"\]/);
  assert.equal(message.deliveries[0].status, "delivered"); assert.equal((await service.messages(room.id))[0].text, "ship it");
});

test("an agent replies to a human in the room without waking another agent", async () => {
  const calls = [];
  const ctx = { dshBridge: { deliverExternal(...args) { calls.push(args); } } };
  const service = new DshChatService(ctx, { path: join(await mkdtemp(join(tmpdir(), "dsh-chat-human-reply-")), "rooms.json") });
  const room = await service.createRoom({ name: "Support", members: [{ kind: "session", sessionId: "agent", alias: "Helper" }] });
  await service.send({ roomId: room.id, author: "human-browser", authorAlias: "You", text: "Can you help?", mentions: ["Helper"] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], "agent");
  assert.match(calls[0][2], /sent by a human room participant/);
  assert.match(calls[0][2], /omit mentions/);
  assert.doesNotMatch(calls[0][2], /mentions \["You"\]/);
});

test("session aliases are presentation metadata while delivery uses stable ids", async () => {
  const calls = [];
  const ctx = { dshBridge: { deliverExternal(...args) { calls.push(args); } } };
  const service = new DshChatService(ctx, { path: join(await mkdtemp(join(tmpdir(), "dsh-chat-alias-")), "rooms.json") });
  const room = await service.createRoom({ name: "Design", members: [
    { kind: "session", sessionId: "session-a1", alias: "Planner" },
    { kind: "session", sessionId: "session-b2", alias: "Builder" }
  ] });
  const quiet = await service.send({ roomId: room.id, author: "session-a1", authorAlias: "Planner", text: "The literal @Builder remains human-readable." });
  assert.deepEqual(quiet.mentions, []);
  assert.equal(calls.length, 0);
  const targeted = await service.send({ roomId: room.id, author: "session-a1", authorAlias: "Planner", text: "@Builder please review", mentions: ["Builder"] });
  assert.equal(targeted.author, "session-a1");
  assert.equal(targeted.authorAlias, "Planner");
  assert.deepEqual(targeted.mentions, ["session-b2"]);
  assert.equal(calls[0][1], "session-b2");
});

test("legacy members expose a live session title without changing their stable id", async () => {
  const session = { id: "session-old" };
  const ctx = {
    sessions: { get(id) { return id === session.id ? session : undefined; } },
    sessionTitle: { get(value) { return value === session ? { title: "Recovered alias" } : undefined; } }
  };
  const service = new DshChatService(ctx, { path: join(await mkdtemp(join(tmpdir(), "dsh-chat-title-")), "rooms.json") });
  const room = await service.createRoom({ name: "Legacy", members: [{ kind: "session", sessionId: session.id }] });
  const listed = await service.listRooms();
  assert.equal(listed[0].members[0].sessionId, session.id);
  assert.equal(listed[0].members[0].alias, "Recovered alias");
  assert.equal(room.members[0].sessionId, session.id);
});

test("Weave backfills aliases for existing remote members without blocking room reads", async () => {
  const service = new DshChatService({ dshWeave: { async remoteSessions() { return [{ hostId: "peer", hostName: "studio-mini", workspaces: [{ id: "work", title: "Release", sessions: [{ id: "session-old-remote", title: "Remote Builder" }] }] }]; } } }, { path: join(await mkdtemp(join(tmpdir(), "dsh-chat-alias-refresh-")), "rooms.json") });
  await service.createRoom({ name: "Existing", members: [{ kind: "remote", hostId: "peer", sessionId: "session-old-remote" }] });
  assert.equal((await service.listRooms())[0].members[0].alias, undefined);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const member = (await service.listRooms())[0].members[0];
  assert.equal(member.sessionId, "session-old-remote");
  assert.equal(member.alias, "Remote Builder");
  assert.equal(member.workspaceTitle, "Release");
  assert.equal(member.hostName, "studio-mini");
  assert.equal("capability" in member, false);
});

test("rooms materialize as visible titled sessions in the Chatrooms workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-chat-sessions-"));
  const sessions = new Map();
  const attached = [];
  const detached = [];
  const renamed = [];
  const flushed = [];
  const workspace = { async attachSession(id) { attached.push(id); }, async detachSession(id) { detached.push(id); } };
  const ctx = {
    get(name) {
      if (name === "sessions") return {
        get(id) { return sessions.get(id); },
        create(id, options) {
          const events = [...(options.seed ?? [])];
          const session = { id, header: options.meta, events, append(type, data) { const event = { type, data, seq: events.length }; events.push(event); return event; } };
          sessions.set(id, session); return session;
        },
        async flush(session) { flushed.push(session.id); }
      };
      if (name === "workspaceRegistry") return { async create(path, title) { assert.equal(path, join(root, "Chatrooms")); assert.equal(title, "Chatrooms"); return workspace; } };
      if (name === "sessionTitle") return { rename(session, title) { renamed.push([session.id, title]); } };
    }
  };
  const service = new DshChatService(ctx, { path: join(root, "rooms.json") });
  const room = await service.createRoom({ name: "Release", members: [{ kind: "session", sessionId: "alice" }] });
  assert.match(room.sessionId, /^dsh-chat-room-v3-/);
  const session = sessions.get(room.sessionId);
  assert.equal(session.header.cwd, join(root, "Chatrooms"));
  assert.deepEqual(session.events.map((event) => event.type), ["turn/start", "chat/room-link", "turn/end"]);
  assert.deepEqual(session.events[0].data, { turn: 1 });
  assert.equal(session.events[1].ignorable, true);
  assert.deepEqual(session.events[2].data, { turn: 1, reason: { kind: "completed" } });
  assert.equal(session.events[1].data.roomId, room.id);
  assert.deepEqual(renamed, [[room.sessionId, "Release"]]);
  assert.deepEqual(attached, [room.sessionId]);
  assert.deepEqual(flushed, [room.sessionId]);
  assert.deepEqual(detached, []);
  assert.equal((await service.listRooms())[0].sessionId, room.sessionId);
});

test("remote session selection consumes Weave's workspace catalog", async () => {
  const weave = { async remoteSessions() { return [{ hostId: "peer-one", hostName: "studio-mini", workspaces: [{ id: "workspace-1", title: "Release", sessions: [{ id: "session-remote", title: "Remote build", running: true, updatedAt: 20 }, { id: "dsh-chat-room-v3-hidden", title: "Room", running: false, updatedAt: 1 }] }] }]; } };
  const service = new DshChatService({ dshWeave: weave }, { path: join(await mkdtemp(join(tmpdir(), "dsh-chat-catalog-")), "rooms.json") });
  assert.deepEqual(await service.remoteSessions(), [{ hostId: "peer-one", hostName: "studio-mini", workspaces: [{ id: "workspace-1", title: "Release", sessions: [{ id: "session-remote", title: "Remote build", running: true, updatedAt: 20 }] }] }]);
});

test("adding a remote room member sends by host id without changing Weave trust", async () => {
  const sent = [];
  const ctx = { dshWeave: { async sendTo(frame) { sent.push(frame); return { delivered: true }; } } };
  const service = new DshChatService(ctx, { path: join(await mkdtemp(join(tmpdir(), "dsh-chat-")), "rooms.json") });
  const room = await service.createRoom({ name: "Remote" });
  const member = await service.addMember(room.id, { kind: "remote", hostId: "host-two", sessionId: "remote-session" });
  assert.equal(member.hostId, "host-two"); assert.equal("ticket" in member, false);
  assert.equal(sent[0].hostId, "host-two"); assert.equal(JSON.parse(sent[0].text).kind, "room.invite");
});

test("room references resolve by name and mentions target only the named members", async () => {
  const calls = [];
  const ctx = { dshBridge: { deliverExternal(...args) { calls.push(args); } } };
  const service = new DshChatService(ctx, { path: join(await mkdtemp(join(tmpdir(), "dsh-chat-")), "rooms.json") });
  const room = await service.createRoom({ name: "Release", members: [{ kind: "session", sessionId: "alice" }, { kind: "session", sessionId: "bob" }, { kind: "session", sessionId: "carol" }] });
  assert.equal((await service.resolveRoom("Release")).id, room.id);
  const message = await service.send({ roomId: room.id, author: "alice", text: "@bob please review", mentions: ["bob"] });
  assert.deepEqual(message.mentions, ["bob"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], "bob");
});

test("authoritative host exposes cursor reads and only delivers explicit remote mentions", async () => {
  const listeners = { host: new Set(), guest: new Set() }; const deliveries = [];
  const makeWeave = (side) => ({
    subscribe(listener) { listeners[side].add(listener); return () => listeners[side].delete(listener); },
    async sendTo(frame) {
      const target = frame.hostId; let result;
      for (const listener of listeners[target]) { const outcome = await listener({ ...frame, peerId: side, receivedAt: Date.now() }); if (outcome?.result !== undefined) result = outcome.result; }
      return { delivered: true, result };
    }
  });
  const host = new DshChatService({ dshWeave: makeWeave("host"), dshBridge: { deliverExternal() {} } }, { path: join(await mkdtemp(join(tmpdir(), "dsh-chat-")), "host.json") });
  const guest = new DshChatService({ dshWeave: makeWeave("guest"), dshBridge: { deliverExternal(...args) { deliveries.push(args); } } }, { path: join(await mkdtemp(join(tmpdir(), "dsh-chat-")), "guest.json") });
  host.attachWeave(); guest.attachWeave();
  const room = await host.createRoom({ name: "Owner", members: [{ kind: "session", sessionId: "host-session", alias: "Host Planner" }] });
  await host.addMember(room.id, { kind: "remote", hostId: "guest", sessionId: "guest-session", alias: "Guest Builder", hostName: "studio-mini" });
  const link = await guest.resolveRoom(room.id); assert.equal(link.hostId, "host"); assert.equal(link.linkedSessionId, "guest-session");
  assert.equal(link.members.find((member) => member.sessionId === "guest-session").alias, "Guest Builder");
  assert.equal("capability" in link.members.find((member) => member.sessionId === "guest-session"), false);
  const capability = (await host.resolveRoom(room.id)).members.find((member) => member.kind === "remote").capability;
  delete guest.state.rooms[0].linkedSessionId; delete guest.state.rooms[0].capability;
  const existing = await host.addMember(room.id, { kind: "remote", hostId: "guest", sessionId: "guest-session" });
  assert.equal(existing.capability, capability);
  const repaired = await guest.resolveRoom(room.id); assert.equal(repaired.linkedSessionId, "guest-session"); assert.equal(repaired.capability, capability);
  await host.send({ roomId: room.id, author: "host-session", text: "visible to humans" });
  assert.equal((await guest.messages(room.id))[0].text, "visible to humans");
  assert.equal(deliveries.length, 0);
  const longRead = guest.messages(room.id, 100, 1_000);
  await new Promise((resolve) => setTimeout(resolve, 10));
  await host.send({ roomId: room.id, author: "host-session", text: "appears through cursor long-poll" });
  assert.equal((await longRead)[0].text, "appears through cursor long-poll");
  await host.send({ roomId: room.id, author: "host-session", text: "please inspect", mentions: ["guest-session"] });
  assert.equal(deliveries.length, 1); assert.equal(deliveries[0][1], "guest-session");
  const forged = { to: "dsh-chat/2", peerId: "host", text: JSON.stringify({ protocol: "dsh-chat/2", kind: "room.delivery", roomId: room.id, roomName: room.name, recipient: "guest-session", capability: "wrong", message: { id: "forged", author: "attacker", text: "inject" } }) };
  await assert.rejects(async () => { for (const listener of listeners.guest) await listener(forged); }, /capability denied/);
  assert.equal(deliveries.length, 1);
  await guest.send({ roomId: room.id, author: "guest-session", authorAlias: "Spoofed name", text: "acknowledged" });
  const acknowledged = (await host.messages(room.id)).at(-1);
  assert.equal(acknowledged.text, "acknowledged");
  assert.equal(acknowledged.authorAlias, "Guest Builder");
});

test("failed remote mentions stay durable until a later acknowledgement", async () => {
  let online = false;
  const weave = {
    async sendTo(frame) {
      if (JSON.parse(frame.text).kind === "room.invite" || online) return { delivered: true };
      throw new Error("peer offline");
    }
  };
  const path = join(await mkdtemp(join(tmpdir(), "dsh-chat-")), "host.json");
  const host = new DshChatService({ dshWeave: weave }, { path });
  const room = await host.createRoom({ name: "Durable", members: [{ kind: "session", sessionId: "host" }] });
  await host.addMember(room.id, { kind: "remote", hostId: "guest-host", sessionId: "guest" });
  const message = await host.send({ roomId: room.id, author: "host", text: "retry me", mentions: ["guest"] });
  assert.equal(message.deliveries[0].status, "failed");
  const first = JSON.parse(await (await import("node:fs/promises")).readFile(path, "utf8"));
  assert.equal(first.rooms[0].pendingDeliveries.length, 1);
  online = true;
  await host.retryPendingDeliveries();
  const second = JSON.parse(await (await import("node:fs/promises")).readFile(path, "utf8"));
  assert.equal(second.rooms[0].pendingDeliveries.length, 0);
});

test("legacy room tickets migrate once to stable host ids without trusting them", async () => {
  const { writeFile, readFile } = await import("node:fs/promises");
  const path = join(await mkdtemp(join(tmpdir(), "dsh-chat-migrate-")), "rooms.json");
  await writeFile(path, JSON.stringify({ version: 1, rooms: [{ id: "legacy", name: "Legacy", members: [{ kind: "weave", sessionId: "remote", ticket: "remote-ticket" }], messages: [], pendingDeliveries: [], hostTicket: "host-ticket", cursor: 0 }] }));
  const service = new DshChatService({ dshWeave: { subscribe() { return () => {}; }, identify(ticket) { return ticket === "host-ticket" ? "host-id" : "remote-id"; } } }, { path });
  service.attachWeave(); await new Promise((resolve) => setTimeout(resolve, 10));
  const saved = JSON.parse(await readFile(path, "utf8"));
  assert.equal(saved.rooms[0].hostId, "host-id"); assert.equal("hostTicket" in saved.rooms[0], false);
  assert.deepEqual(saved.rooms[0].members[0], { kind: "remote", sessionId: "remote", hostId: "remote-id" });
});
