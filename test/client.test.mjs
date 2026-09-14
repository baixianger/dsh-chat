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
  assert.equal(plugin.inject.includes("uiConversation"), true);
  assert.equal(plugin.inject.includes("conversationEvents"), false);
  const registrations = [];
  const disposed = [];
  const effectDisposers = [];
  let definition;
  let chatView;
  let bindingThrows = false;
  plugin.apply({
    connection: {},
    locale: { register: () => () => {}, bind: () => (key) => ({ mention: "Mention", idle: "Idle" })[key] ?? key },
    effect(callback) { const dispose = callback(); effectDisposers.push(dispose); return dispose; },
    uiConversation: {
      events: { register(value) { definition = value; return () => disposed.push("definition"); } },
      binding(sessionId) {
        if (bindingThrows) throw new Error(`uiConversation.binding: unknown session "${sessionId}"`);
        return { target: () => ({ getSnapshot: () => chatView }) };
      }
    },
    slots: {
      inject(name, mount) { mount(); return () => disposed.push(name); },
      register(options, component) { registrations.push({ options, component }); }
    }
  });
  assert.equal(effectDisposers.length, 4, "styles, locale, definition and slots are Fiber-owned");
  effectDisposers[3]();
  assert.deepEqual(disposed, ["conversation.chat.node", "conversation.composer"]);
  assert.equal(registrations.some(({ options }) => options.name === "conversation.view"), false);
  assert.equal(registrations.some(({ options }) => options.name === "conversation.chat.node" && options.key === "dsh-chat-room"), true);
  const composer = registrations.find(({ options }) => options.name === "conversation.composer");
  assert.ok(composer);
  chatView = { nodes: [{ kind: "dsh-chat-room", data: { roomId: "room-2", name: "Native" } }] };
  assert.deepEqual(composer.options.select({ sessionId: "session-native" }), { roomId: "room-2", name: "Native" });
  chatView = { nodes: [] };
  bindingThrows = true;
  assert.deepEqual(
    composer.options.select({ sessionId: "session-legacy", session: { chat: { nodes: { values: () => [{ kind: "dsh-chat-room", data: { roomId: "room-3", name: "Legacy" } }] } } } }),
    { roomId: "room-3", name: "Legacy" }
  );
  bindingThrows = false;
  assert.deepEqual(composer.options.select({ sessionId: "dsh-chat-room-v3-room-before-target" }), { roomId: "room-before-target", name: "roomMessages" }, "a room must claim its composer before the Chat target activates");
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

test("room chat hides ordinary agent nodes injected into its container session", async () => {
  const source = await readFile(new URL("../lib/client.js", import.meta.url), "utf8");
  assert.match(source, /data-dsh-chat-room-timeline/);
  assert.match(source, /\[data-slot="conversation\.chat\.node"\]/);
  assert.match(source, /> \*:not\(:has\(\[data-dsh-chat-room-timeline\]\)\) \{ display: none !important; \}/);
});

test("composer delivers only structured mentions selected from the member list", async () => {
  const source = await readFile(new URL("../lib/client.js", import.meta.url), "utf8");
  assert.match(source, /const mentions = \[\.\.\.new Set\(selected\)\]/);
  assert.doesNotMatch(source, /draft\.matchAll/);
  assert.doesNotMatch(source, /lowerDraft\.includes/);
  assert.match(source, /t\("mention"\)/);
  assert.match(source, /background: stateColor\(state\)/);
  assert.match(source, /runtimeState\(member\) !== "archived"/);
});

/** A React double that runs hook bodies across one render pass. */
function fakeReact() {
  const states = [];
  const cleanups = [];
  let cursor = 0;
  let pending = [];
  return {
    createElement(type, props, ...children) { return { type, props: props ?? {}, children }; },
    useState(initial) {
      const index = cursor++;
      if (!(index in states)) states[index] = typeof initial === "function" ? initial() : initial;
      return [states[index], (next) => { states[index] = typeof next === "function" ? next(states[index]) : next; }];
    },
    useRef(initial) { return this.useState(() => ({ current: initial }))[0]; },
    useCallback(callback) { return callback; },
    useEffect(callback) { pending.push(callback); },
    render(component, props) {
      cursor = 0;
      const tree = component(props);
      const effects = pending;
      pending = [];
      for (const effect of effects) {
        const cleanup = effect();
        if (typeof cleanup === "function") cleanups.push(cleanup);
      }
      return { tree, unmount() { for (const cleanup of cleanups.splice(0)) cleanup(); } };
    }
  };
}

/** Walk a rendered tree for the first element carrying one aria-label. */
function findByAriaLabel(node, label) {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findByAriaLabel(child, label);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (node === null || typeof node !== "object") return undefined;
  if (node.props?.["aria-label"] === label) return node;
  return findByAriaLabel(node.children ?? [], label);
}

test("room calls post an envelope to the host's /api Fetch route", async () => {
  const react = fakeReact();
  let plugin;
  globalThis.window = { __ModuleLoader__: { load(entry) { plugin = entry.factory((id) => {
    assert.equal(id, "react");
    return react;
  }); } } };
  try {
    await import(`../lib/client.js?test=${Date.now()}`);
  } finally {
    delete globalThis.window;
  }

  const registrations = [];
  // The room UI posts to the host's `/api` Fetch route; the test stands in for
  // the browser's fetch and for Connection's fence.
  const previousFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (path, init) => {
    seen.push({ path, init, body: JSON.parse(init.body) });
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, value: [{ id: "room-1", members: [{ kind: "session", sessionId: "session-2", alias: "Peer", state: "idle" }] }] })
    };
  };
  let rendered;
  try {
    plugin.apply({
      connection: {},
    locale: { register: () => () => {}, bind: () => (key) => ({ mention: "Mention", idle: "Idle" })[key] ?? key },
      sessions: { list: { getSnapshot: () => ({ byId: {} }) } },
      effect: (callback) => callback(),
      uiConversation: { events: { register: () => () => {} } },
      slots: {
        inject: (_name, mount) => (mount(), () => {}),
        register(options, component) { registrations.push({ options, component }); }
      }
    });
    const composer = registrations.find(({ options }) => options.name === "conversation.composer");
    assert.ok(composer, "the composer is registered");
    rendered = react.render(composer.component, { matched: { roomId: "room-1", name: "Release" }, sessionId: "session-1" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(seen.length, 1, "the composer reads its member list through the route");
    assert.equal(seen[0].path, "/api/dsh-chat");
    assert.equal(seen[0].init.method, "POST");
    assert.equal(seen[0].init.headers["content-type"], "application/json");
    assert.equal(seen[0].init.credentials, "same-origin");
    assert.deepEqual(seen[0].body, { endpoint: "listRooms", args: {} });

    assert.equal(seen[0].init.signal.aborted, false);
    // The envelope's value — not the envelope — is what `call` hands the UI.
    const next = react.render(composer.component, { matched: { roomId: "room-1", name: "Release" }, sessionId: "session-1" });
    assert.ok(findByAriaLabel(next.tree, "Mention Peer, Idle"), "the unwrapped value reaches the room UI");
  } finally {
    rendered?.unmount();
    assert.equal(seen[0]?.init.signal.aborted, true, "unmount aborts the outstanding room request");
    if (previousFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = previousFetch;
  }
});

test("the room transport is the host's /api Fetch route", async () => {
  const source = await readFile(new URL("../lib/client.js", import.meta.url), "utf8");
  assert.match(source, /const SETTINGS_PATH = "\/api\/dsh-chat"/);
  assert.match(source, /await fetch\(SETTINGS_PATH, \{/);
  assert.match(source, /credentials: "same-origin"/);
  assert.doesNotMatch(source, /rpc\.call\(/, "no call depends on the unmounted channel transport");
});
