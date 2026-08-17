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
  assert.equal(message.deliveries[0].status, "delivered"); assert.equal((await service.messages(room.id))[0].text, "ship it");
});

test("adding a remote room member explicitly trusts its Weave ticket and sends an invitation", async () => {
  const trusted = [];
  const sent = [];
  const ctx = { dshWeave: { trust(ticket) { trusted.push(ticket); }, async ticket() { return "local-ticket"; }, async send(frame) { sent.push(frame); return { delivered: true }; } } };
  const service = new DshChatService(ctx, { path: join(await mkdtemp(join(tmpdir(), "dsh-chat-")), "rooms.json") });
  const room = await service.createRoom({ name: "Remote" });
  await service.addMember(room.id, { kind: "weave", sessionId: "remote-session", ticket: "ticket-data" });
  assert.deepEqual(trusted, ["ticket-data"]);
  assert.equal(sent.length, 1);
  assert.equal(JSON.parse(sent[0].text).kind, "invite");
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

test("Weave invitations synchronize public messages without waking agents until mentioned", async () => {
  const listeners = { a: new Set(), b: new Set() };
  const bridges = { a: [], b: [] };
  const weave = (side) => ({
    async trust() {}, async ticket() { return `${side}-ticket`; },
    subscribe(listener) { listeners[side].add(listener); return () => listeners[side].delete(listener); },
    async send(frame) { const other = frame.ticket === "a-ticket" ? "a" : "b"; for (const listener of listeners[other]) await listener({ ...frame, peerId: side, receivedAt: Date.now() }); return { delivered: true }; }
  });
  const a = new DshChatService({ dshWeave: weave("a"), dshBridge: { deliverExternal(...args) { bridges.a.push(args); } } }, { path: join(await mkdtemp(join(tmpdir(), "dsh-chat-")), "a.json") });
  const b = new DshChatService({ dshWeave: weave("b"), dshBridge: { deliverExternal(...args) { bridges.b.push(args); } } }, { path: join(await mkdtemp(join(tmpdir(), "dsh-chat-")), "b.json") });
  b.attachWeave();
  const room = await a.createRoom({ name: "Mesh", members: [{ kind: "session", sessionId: "alice" }] });
  await a.addMember(room.id, { kind: "weave", sessionId: "bob", ticket: "b-ticket" });
  await a.send({ roomId: room.id, author: "alice", text: "status for humans" });
  assert.equal((await b.messages(room.id))[0].text, "status for humans");
  assert.equal(bridges.b.length, 0);
  await a.send({ roomId: room.id, author: "alice", text: "@bob please inspect", mentions: ["bob"] });
  assert.equal(bridges.b.length, 1);
  assert.equal(bridges.b[0][1], "bob");
});
