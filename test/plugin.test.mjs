import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import * as plugin from "../lib/index.js";

for (const weaveState of ["absent", "ready", "late"]) {
  test(`Cordis boots chat with Weave ${weaveState}`, { timeout: 5_000 }, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "dsh-chat-plugin-"));
    const root = new Context();
    t.after(async () => {
      await root.fiber.dispose();
      await rm(directory, { recursive: true, force: true });
    });
    const routes = [];
    const deliveries = [];
    const sessions = new Map();
    await root.plugin((ctx) => {
      ctx.provide("connection", { fetch: { register(route) { routes.push(route); return () => {}; } } });
      ctx.provide("tools", { register() {} });
      ctx.provide("dshBridge", { deliverExternal(...args) { deliveries.push(args); } });
      ctx.provide("sessions", {
        get: (id) => sessions.get(id),
        create(id, options) {
          const session = { id, snapshotEvents: () => options.seed, get events() { throw new Error("use the public snapshotEvents interface"); } };
          sessions.set(id, session);
          return session;
        }
      });
      ctx.provide("workspaceRegistry", { create: async () => ({ attachSession() {} }) });
      ctx.provide("sessionTitle", { get() {}, rename() {} });
      ctx.provide("sessionPersistence", { stat: async () => undefined, create: async () => ({ append: async () => {}, flush: async () => {}, close: async () => {} }) });
    });

    const subscribed = Promise.withResolvers();
    let subscriptions = 0;
    let unsubscriptions = 0;
    const catalog = [{ hostId: "peer", hostName: "Peer", workspaces: [{ id: "work", title: "Work", sessions: [{ id: "remote", title: "Remote" }] }] }];
    const provideWeave = () => root.plugin((ctx) => {
      ctx.provide("dshWeave", {
        subscribe() {
          subscriptions += 1;
          subscribed.resolve();
          return () => { unsubscriptions += 1; };
        },
        remoteSessions: async () => catalog
      });
    });
    if (weaveState === "ready") await provideWeave();

    const chatFiber = root.plugin(plugin, { path: join(directory, "rooms.json"), workspacePath: join(directory, "Chatrooms") });
    await chatFiber;
    const chat = root.get("dshChat")?.chat;
    assert.ok(chat, "chat must load even without the optional Weave service");
    // Exercise the real plugin context: undeclared property access throws even
    // when a sibling plugin has already provided the service.
    assert.throws(() => chatFiber.ctx.dshWeave, /without inject/);
    await chat.ready;
    assert.deepEqual(await chat.listRooms(), []);
    if (weaveState !== "ready") assert.deepEqual(await chat.remoteSessions(), []);
    if (weaveState === "late") await provideWeave();
    if (weaveState !== "absent") {
      await subscribed.promise;
      assert.equal(subscriptions, 1);
      assert.deepEqual(await chat.remoteSessions(), catalog);
    }

    const room = await chat.createRoom({ name: "Local", members: [{ kind: "session", sessionId: "agent", alias: "Agent" }] });
    const message = await chat.send({ roomId: room.id, author: "human", text: "hello", mentions: ["agent"] });
    assert.equal(message.deliveries[0].status, "delivered");
    assert.equal(deliveries[0][1], "agent");
    const response = await routes[0].fetch({ json: async () => ({ endpoint: "listRooms", args: {} }) });
    const envelope = await response.json();
    assert.equal(envelope.ok, true);
    assert.equal(envelope.value[0].id, room.id);

    await chatFiber.dispose();
    assert.equal(unsubscriptions, subscriptions);
    assert.equal(chat.attachRetryTimer, undefined);
    assert.equal(chat.pendingRetryTimer, undefined);
  });
}
