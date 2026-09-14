import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { apply, createRpcHandler, handleChatRequest } from "../lib/index.js";

test("the endpoint handler answers every input with an RpcResult", async () => {
  const handler = createRpcHandler({
    echo: async (args) => ({ echoed: args.value }),
    boom: async () => { throw new Error('room "x" does not exist'); }
  });

  assert.deepEqual(await handler("echo", { args: { value: 7 } }), { ok: true, value: { echoed: 7 } });
  assert.deepEqual(await handler("echo", undefined), { ok: true, value: { echoed: undefined } });
  assert.deepEqual(await handler("missing", { args: {} }), {
    ok: false,
    error: { code: "bad-request", message: "unknown dsh-chat endpoint: missing", details: {} }
  });
  assert.deepEqual(await handler("echo", { args: "nope" }), {
    ok: false,
    error: { code: "bad-request", message: "dsh-chat endpoint echo requires an args object", details: {} }
  });
  assert.deepEqual(await handler("boom", { args: {} }), {
    ok: false,
    error: { code: "internal", message: 'room "x" does not exist', details: {} }
  });
});

test("a protected key on the handler table is not an endpoint", async () => {
  const handler = createRpcHandler({ echo: async () => ({ echoed: true }) });
  const response = await handler("constructor", { args: {} });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "bad-request");
});

test("the room route is published as a Fetch route under /api", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-chat-route-"));
  const calls = { injected: [], routes: [], tools: [] };
  const effects = [];
  const services = {
    connection: { fetch: { register(route) { calls.routes.push(route); return () => {}; } } }
  };
  const ctx = {
    // The Cordis Service base registers `dshChat` through this seam; everything
    // else models only what apply's own callbacks read.
    reflect: { provide() {} },
    get: () => undefined,
    logger: { warn() {} },
    effect(callback) { const dispose = callback(); effects.push(dispose); return dispose; },
    inject(deps, callback) {
      calls.injected.push([...deps]);
      // Model the real contract: a callback reads only the services it declared,
      // while the framework methods every ctx carries (effect, on) stay
      // available. Handing it every service is how the undeclared
      // `ctx.connection` access slipped past this test while the live route
      // never registered.
      callback({ effect: (registration) => registration(), ...Object.fromEntries(deps.map((name) => [name, services[name]])) });
    },
    tools: { register(tool) { calls.tools.push(tool); } },
    sessionTitle: { get: () => undefined },
    dshBridge: { status: async () => ({ state: "idle" }) }
  };
  try {
    apply(ctx, { path: join(directory, "rooms.json"), workspacePath: join(directory, "Chatrooms") });

    const signal = AbortSignal.abort(new Error("stop tool"));
    for (const tool of calls.tools) await assert.rejects(tool.execute({ name: "Cancelled", room: "anything", sessionId: "peer", text: "test" }, { signal, agent: { session: { id: "owner" } } }), /stop tool/);
    assert.equal(calls.tools.length, 4);

    assert.deepEqual(calls.injected, [["connection"]], "the route declares its connection dependency, never reads it as an ambient property");
    // The room UI's transport is a Fetch route under `/api` — the single path
    // this deployment mounts and fences — not a per-plugin RPC channel.
    assert.deepEqual(calls.routes.map((route) => [route.path, route.methods, route.requestBody]), [
      ["/api/dsh-chat", ["POST"], "buffered"]
    ]);

    const response = await calls.routes[0].fetch({ json: async () => ({ endpoint: "missing", args: {} }) });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/json");
    assert.deepEqual(await response.json(), {
      ok: false,
      error: { code: "bad-request", message: "unknown dsh-chat endpoint: missing", details: {} }
    });
  } finally {
    for (const dispose of effects) if (typeof dispose === "function") await dispose();
  }
});

test("the room route answers an RpcResult for every input", async () => {
  const seen = [];
  const handler = async (endpoint, payload) => {
    seen.push({ endpoint, args: payload?.args });
    return { ok: true, value: { endpoint } };
  };

  const answered = await handleChatRequest(handler, { json: async () => ({ endpoint: "listRooms", args: { limit: 5 } }) });
  assert.equal(answered.status, 200);
  assert.equal(answered.headers.get("content-type"), "application/json");
  assert.deepEqual(await answered.json(), { ok: true, value: { endpoint: "listRooms" } });
  assert.deepEqual(seen, [{ endpoint: "listRooms", args: { limit: 5 } }]);

  // A body that is not JSON, one without a usable endpoint, and a throwing
  // handler are all answered as envelopes: a throw here would reach the browser
  // as an opaque transport failure instead of a message a human can act on.
  const notJson = await handleChatRequest(handler, { json: async () => { throw new Error("bad json"); } });
  assert.equal(notJson.status, 200);
  const notJsonEnvelope = await notJson.json();
  assert.equal(notJsonEnvelope.ok, false);
  assert.deepEqual(notJsonEnvelope, { ok: false, error: { code: "bad-request", message: "request body is not JSON", details: {} } });

  const noEndpoint = await handleChatRequest(handler, { json: async () => ({ args: {} }) });
  assert.equal(noEndpoint.status, 200);
  const noEndpointEnvelope = await noEndpoint.json();
  assert.equal(noEndpointEnvelope.ok, false);
  assert.match(noEndpointEnvelope.error.message, /endpoint/);

  const emptyEndpoint = await handleChatRequest(handler, { json: async () => ({ endpoint: "" }) });
  assert.equal(emptyEndpoint.status, 200);
  assert.equal((await emptyEndpoint.json()).ok, false);

  const thrown = await handleChatRequest(async () => { throw new Error('room "x" does not exist'); }, { json: async () => ({ endpoint: "room", args: {} }) });
  assert.equal(thrown.status, 200);
  assert.deepEqual(await thrown.json(), {
    ok: false,
    error: { code: "internal", message: 'room "x" does not exist', details: {} }
  });
});

test("the HTTP request signal reaches the operation and pre-aborted calls do not execute", async () => {
  let executions = 0;
  const controller = new AbortController();
  const handler = createRpcHandler({ probe: async (_args, options) => { executions++; assert.equal(options.signal, controller.signal); return true; } });
  const request = { json: async () => ({ endpoint: "probe", args: {} }), signal: controller.signal };
  assert.equal((await (await handleChatRequest(handler, request)).json()).ok, true);
  controller.abort();
  assert.equal((await (await handleChatRequest(handler, request)).json()).ok, false);
  assert.equal(executions, 1);
  assert.equal((await handler("probe", { args: [] })).error.code, "bad-request");
});
