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
