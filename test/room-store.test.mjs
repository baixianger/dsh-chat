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

test("adding a remote room member explicitly trusts its Weave ticket", async () => {
  const trusted = [];
  const ctx = { dshWeave: { trust(ticket) { trusted.push(ticket); }, async ticket() { return "local-ticket"; }, async send() { return { delivered: true }; } } };
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

test("authoritative host exposes cursor reads and only delivers explicit remote mentions", async () => {
  const listeners = { host: new Set(), guest: new Set() }; const deliveries = [];
  const makeWeave = (side) => ({
    async trust() {}, async ticket() { return `${side}-ticket`; },
    subscribe(listener) { listeners[side].add(listener); return () => listeners[side].delete(listener); },
    async send(frame) {
      const target = frame.ticket === "host-ticket" ? "host" : "guest"; let result;
      for (const listener of listeners[target]) { const outcome = await listener({ ...frame, peerId: side, receivedAt: Date.now() }); if (outcome?.result !== undefined) result = outcome.result; }
      return { delivered: true, result };
    }
  });
  const host = new DshChatService({ dshWeave: makeWeave("host"), dshBridge: { deliverExternal() {} } }, { path: join(await mkdtemp(join(tmpdir(), "dsh-chat-")), "host.json") });
  const guest = new DshChatService({ dshWeave: makeWeave("guest"), dshBridge: { deliverExternal(...args) { deliveries.push(args); } } }, { path: join(await mkdtemp(join(tmpdir(), "dsh-chat-")), "guest.json") });
  host.attachWeave(); guest.attachWeave();
  const room = await host.createRoom({ name: "Owner", members: [{ kind: "session", sessionId: "host-session" }] });
  await host.addMember(room.id, { kind: "weave", sessionId: "guest-session", ticket: "guest-ticket" });
  const link = await guest.resolveRoom(room.id); assert.equal(link.hostTicket, "host-ticket");
  await host.send({ roomId: room.id, author: "host-session", text: "visible to humans" });
  assert.equal((await guest.messages(room.id))[0].text, "visible to humans");
  assert.equal(deliveries.length, 0);
  const longRead = guest.messages(room.id, 100, 1_000);
  await new Promise((resolve) => setTimeout(resolve, 10));
  await host.send({ roomId: room.id, author: "host-session", text: "appears through cursor long-poll" });
  assert.equal((await longRead)[0].text, "appears through cursor long-poll");
  await host.send({ roomId: room.id, author: "host-session", text: "please inspect", mentions: ["guest-session"] });
  assert.equal(deliveries.length, 1); assert.equal(deliveries[0][1], "guest-session");
  await guest.send({ roomId: room.id, author: "guest-session", text: "acknowledged" });
  assert.equal((await host.messages(room.id)).at(-1).text, "acknowledged");
});

test("failed remote mentions stay durable until a later acknowledgement", async () => {
  let online = false;
  const weave = {
    async trust() {}, async ticket() { return "host-ticket"; },
    async send(frame) {
      if (JSON.parse(frame.text).kind === "room.invite" || online) return { delivered: true };
      throw new Error("peer offline");
    }
  };
  const path = join(await mkdtemp(join(tmpdir(), "dsh-chat-")), "host.json");
  const host = new DshChatService({ dshWeave: weave }, { path });
  const room = await host.createRoom({ name: "Durable", members: [{ kind: "session", sessionId: "host" }] });
  await host.addMember(room.id, { kind: "weave", sessionId: "guest", ticket: "guest-ticket" });
  const message = await host.send({ roomId: room.id, author: "host", text: "retry me", mentions: ["guest"] });
  assert.equal(message.deliveries[0].status, "failed");
  const first = JSON.parse(await (await import("node:fs/promises")).readFile(path, "utf8"));
  assert.equal(first.rooms[0].pendingDeliveries.length, 1);
  online = true;
  await host.retryPendingDeliveries();
  const second = JSON.parse(await (await import("node:fs/promises")).readFile(path, "utf8"));
  assert.equal(second.rooms[0].pendingDeliveries.length, 0);
});
