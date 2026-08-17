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
  const message = await service.send({ roomId: room.id, author: "alice", text: "ship it" });
  assert.equal(calls.length, 1); assert.equal(calls[0][1], "bob"); assert.match(calls[0][2], /ship it/);
  assert.equal(message.deliveries[0].status, "delivered"); assert.equal((await service.messages(room.id))[0].text, "ship it");
});

test("adding a remote room member explicitly trusts its Weave ticket", async () => {
  const trusted = [];
  const ctx = { dshWeave: { trust(ticket) { trusted.push(ticket); } } };
  const service = new DshChatService(ctx, { path: join(await mkdtemp(join(tmpdir(), "dsh-chat-")), "rooms.json") });
  const room = await service.createRoom({ name: "Remote" });
  await service.addMember(room.id, { kind: "weave", sessionId: "remote-session", ticket: "ticket-data" });
  assert.deepEqual(trusted, ["ticket-data"]);
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
