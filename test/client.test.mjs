import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("client renders rooms in native Chat and takes over only their composer", async () => {
  let plugin;
  globalThis.window = { __ModuleLoader__: { load(entry) { plugin = entry.factory((id) => {
    assert.equal(id, "react");
    return { createElement() {}, useState() {}, useCallback() {}, useEffect() {} };
  }); } } };
  try {
    await import(`../lib/client.js?test=${Date.now()}`);
  } finally {
    delete globalThis.window;
  }
  assert.equal(plugin.inject.includes("workspaces"), true);
  const registrations = [];
  let definition;
  plugin.apply({
    connection: { rpc: { async call() { return { ok: true, value: [] }; } } },
    conversationEvents: { register(value) { definition = value; } },
    slots: {
      inject(_name, mount) { mount(); },
      register(options, component) { registrations.push({ options, component }); }
    }
  });
  assert.equal(registrations.some(({ options }) => options.name === "conversation.view"), false);
  assert.equal(registrations.some(({ options }) => options.name === "conversation.chat.node" && options.key === "dsh-chat-room"), true);
  const composer = registrations.find(({ options }) => options.name === "conversation.composer");
  assert.ok(composer);
  assert.equal(composer.options.select({ session: { chat: { nodes: { values: () => [] } } } }), null);
  assert.deepEqual(composer.options.select({ session: { chat: { nodes: { values: () => [{ kind: "dsh-chat-room", data: { roomId: "room-1", name: "Release" } }] } } } }), { roomId: "room-1", name: "Release" });
  const event = { type: "chat/room-link", seq: 1, data: { roomId: "room-1", name: "Release", remote: false } };
  const match = { event, location: { kind: "turn", turn: 0 } };
  const state = definition.start({}, match);
  assert.equal(definition.publication(match), "immediate");
  const node = definition.buildViewNode({ key: "dsh-chat-room:room-1", id: "room-1", start: match, state });
  assert.equal(node.kind, "dsh-chat-room");
  assert.equal(node.data.name, "Release");
});

test("room controls follow the DSH Settings token contract", async () => {
  const source = await readFile(new URL("../lib/client.js", import.meta.url), "utf8");
  assert.match(source, /className: "dshChatControl"/);
  assert.match(source, /--dsw-alias-border-l2/);
  assert.match(source, /--dsw-alias-label-primary/);
  assert.match(source, /--dsw-alias-state-business-primary/);
  assert.match(source, /color-mix\(in srgb/);
  assert.doesNotMatch(source, /zGbnIq_|qSYn7G_|At1oFq_/);
});

test("remote rooms render cached history before entering long polling", async () => {
  const source = await readFile(new URL("../lib/client.js", import.meta.url), "utf8");
  assert.match(source, /let firstRead = true/);
  assert.match(source, /room\.remote && !firstRead \? 25_000 : 0/);
  assert.match(source, /firstRead = false/);
});

test("composer delivers only structured mentions selected from the member list", async () => {
  const source = await readFile(new URL("../lib/client.js", import.meta.url), "utf8");
  assert.match(source, /const mentions = \[\.\.\.new Set\(selected\)\]/);
  assert.doesNotMatch(source, /draft\.matchAll/);
  assert.doesNotMatch(source, /lowerDraft\.includes/);
});
