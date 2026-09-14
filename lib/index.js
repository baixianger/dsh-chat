import { DshChatService } from "./room-store.js";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { defineTool } from "@deepseek-ai/dsh-tools";
import Schema from "@deepseek-ai/schemastery";
import { homedir } from "node:os";
import { join } from "node:path";

/** The initial public contract version for dsh-chat. */
export const DSH_CHAT_PROTOCOL_VERSION = 1;

/** dsh-chat has a host identity; its interactive client is the next milestone. */
export const DSH_CHAT_STAGE = "room-sessions";

export const name = "dsh-chat";
/** Default state directory: an explicit configured path, then `$DSH_HOME`, then `~/.dsh`. */
const DEFAULT_HOME = process.env.DSH_HOME || join(homedir(), ".dsh");
export const Config = Schema.object({
  path: Schema.string().default(join(DEFAULT_HOME, "dsh-chat", "rooms.json")).description("Durable room state file."),
  workspacePath: Schema.string().default(join(DEFAULT_HOME, "dsh-chat", "Chatrooms")).description("Workspace used for room sessions.")
});
// `dshWeave` is deliberately absent: cross-host rooms are optional, and the store
// attaches to Weave whenever it appears (see DshChatService.attachWeave). Only the
// local delivery layer and the session/workspace services are load prerequisites.
export const inject = ["connection", "tools", "dshBridge", "sessions", "workspaceRegistry", "sessionTitle", "sessionPersistence"];

function exposeRemote(instance, method) {
  Remote(method)(instance[method], {
    private: false,
    static: false,
    name: method,
    addInitializer(initializer) { initializer.call(instance); }
  });
}

/** Failure envelope for one logical RPC endpoint. */
function rpcFailure(code, message) {
  return { ok: false, error: { code, message, details: {} } };
}

/**
 * Build the `/api/dsh-chat` endpoint handler.
 *
 * A non-200 answer reaches the browser as an opaque transport failure, so
 * business failures travel as the RpcResult error branch, and only an unknown
 * endpoint or a malformed `args` envelope is a caller error.
 * @param handlers - endpoint table keyed by the wire endpoint name.
 * @returns an endpoint handler returning an RpcResult for every input.
 */
export function createRpcHandler(handlers) {
  return async (endpoint, payload, options = {}) => {
    const handler = Object.hasOwn(handlers, endpoint) ? handlers[endpoint] : undefined;
    if (handler === undefined) return rpcFailure("bad-request", `unknown dsh-chat endpoint: ${endpoint}`);
    const args = payload?.args;
    if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) {
      return rpcFailure("bad-request", `dsh-chat endpoint ${endpoint} requires an args object`);
    }
    try {
      options.signal?.throwIfAborted();
      return { ok: true, value: await handler(args ?? {}, options) };
    } catch (error) {
      return rpcFailure("internal", error?.message ?? String(error));
    }
  };
}

/** JSON response carrying one RpcResult envelope. */
function envelopeResponse(envelope) {
  return new Response(JSON.stringify(envelope), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

/**
 * Answer one room UI POST on `/api/dsh-chat`.
 *
 * Connection applies the browser fence to everything under `/api`, so this only
 * has to decode the envelope, dispatch the endpoint, and always answer 200 with
 * an RpcResult — a body that is not JSON, a missing endpoint, or a throwing
 * handler would otherwise surface in the browser as an opaque transport
 * failure rather than a message a human can act on.
 * @param handler - the endpoint handler built by `createRpcHandler`.
 * @param request - the incoming request.
 * @returns the response carrying the RpcResult.
 */
export async function handleChatRequest(handler, request) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return envelopeResponse(rpcFailure("bad-request", "request body is not JSON"));
  }
  const endpoint = payload?.endpoint;
  if (typeof endpoint !== "string" || endpoint === "") {
    return envelopeResponse(rpcFailure("bad-request", "endpoint must be a non-empty string"));
  }
  try {
    return envelopeResponse(await handler(endpoint, payload, { signal: request.signal }));
  } catch (error) {
    return envelopeResponse(rpcFailure("internal", error?.message ?? String(error)));
  }
}

/** Host Remote. The source-mode Typert gateway derives JSON request shapes. */
export class DshChatRemote extends TypertRemoteService {
  constructor(ctx, config) {
    super(ctx, "dshChat");
    this.chat = new DshChatService(ctx, config);
    for (const method of ["listRooms", "messages", "remoteSessions", "createRoom", "addMember", "removeMember", "send"]) exposeRemote(this, method);
  }
  async listRooms() { return this.chat.listRooms(); }
  async messages(roomId, limit, waitMs) { return this.chat.messages(roomId, limit, waitMs); }
  async remoteSessions() { return this.chat.remoteSessions(); }
  async createRoom(request) { return this.chat.createRoom(request); }
  async addMember(roomId, member) { return this.chat.addMember(roomId, member); }
  async removeMember(roomId, member) { return this.chat.removeMember(roomId, member); }
  async send(request) { return this.chat.send(request); }
}

/** Host entrypoint. */
export function apply(ctx, config) {
  const remote = new DshChatRemote(ctx, config);
  remote.chat.attachWeave();
  ctx.effect(() => async () => remote.chat.close());
  void remote.chat.ensureRoomSessions().catch((error) => ctx.logger?.warn?.(`dsh-chat room session migration failed: ${String(error)}`));
  const handlers = {
    listRooms: (_args, options) => remote.chat.listRooms(options),
    messages: ({ roomId, limit, waitMs }, options) => remote.chat.messages(roomId, limit, waitMs, options),
    remoteSessions: (_args, options) => remote.chat.remoteSessions(options),
    createRoom: ({ request }, options) => remote.chat.createRoom(request, options),
    addMember: ({ roomId, member }, options) => remote.chat.addMember(roomId, member, options),
    removeMember: ({ roomId, member }, options) => remote.chat.removeMember(roomId, member, options),
    send: ({ request }, options) => remote.chat.send(request, options)
  };
  // The room UI's transport is a Connection Fetch route under `/api` — the one
  // path this deployment mounts and fences for browser callers — not a
  // per-plugin RPC channel: `connection.rpc.handle("/dsh-chat", …)` produced no
  // reachable route here, so every call fell through to the web carrier's static
  // fallback, which answers a non-GET request with 405.
  ctx.inject(["connection"], (connectionCtx) => {
    connectionCtx.effect(() => connectionCtx.connection.fetch.register({
      path: "/api/dsh-chat",
      methods: ["POST"],
      requestBody: "buffered",
      fetch: (request) => handleChatRequest(createRpcHandler(handlers), request)
    }), "dsh-chat: room route");
  });
  const owningSession = (exec) => {
    if (!exec.agent) throw new Error("dsh-chat tools require an owning DSH session");
    return String(exec.agent.session.id);
  };
  const owningAlias = (exec) => exec.agent ? ctx.sessionTitle?.get?.(exec.agent.session)?.title : undefined;
  const roomOutput = {
    schema: { type: "object", additionalProperties: false, properties: {
      id: { type: "string", required: true }, name: { type: "string", required: true }
    } },
    render: (_args, value) => [{ type: "text", text: `${value.name} (${value.id})` }]
  };
  ctx.tools.register(defineTool({
    name: "chat_create",
    description: "Create a DSH group chat and join the current session to it. Use when the user asks to create a group chat by name.",
    parameters: { name: { type: "string", required: true, description: "Human-readable room name." } }, output: roomOutput,
    async execute(args, exec) {
      const sessionId = owningSession(exec);
      const room = await remote.chat.createRoom({ name: args.name, members: [{ kind: "session", sessionId, alias: owningAlias(exec) }] }, { signal: exec.signal });
      return { id: room.id, name: room.name };
    }
  }));
  ctx.tools.register(defineTool({
    name: "chat_join",
    description: "Join the current DSH session to an existing local group chat. Use when the user asks to join a named group chat.",
    parameters: { room: { type: "string", required: true, description: "Exact room name or room id." } }, output: roomOutput,
    async execute(args, exec) {
      const room = await remote.chat.resolveRoom(args.room, { signal: exec.signal });
      await remote.chat.addMember(room.id, { kind: "session", sessionId: owningSession(exec), alias: owningAlias(exec) }, { signal: exec.signal });
      return { id: room.id, name: room.name };
    }
  }));
  ctx.tools.register(defineTool({
    name: "chat_invite",
    description: "Add another live local DSH session to a group chat. Use only with an exact session id; the target receives subsequent group messages.",
    parameters: {
      room: { type: "string", required: true, description: "Exact room name or room id." },
      sessionId: { type: "string", required: true, description: "Target local DSH session id." }
    }, output: roomOutput,
    async execute(args, exec) {
      const room = await remote.chat.resolveRoom(args.room, { signal: exec.signal });
      const status = await ctx.dshBridge.status(args.sessionId, exec.signal);
      if (!status || status.state === "archived") throw new Error(`session ${args.sessionId} is not live`);
      await remote.chat.addMember(room.id, { kind: "session", sessionId: args.sessionId }, { signal: exec.signal });
      return { id: room.id, name: room.name };
    }
  }));
  ctx.tools.register(defineTool({
    name: "chat_send",
    description: "Send a message to a DSH group chat as the current session. Omit mentions for a human-only room message; use an exact member alias or session id to target sessions, or [\"all\"] for broadcast.",
    parameters: {
      room: { type: "string", required: true, description: "Exact room name or room id." },
      text: { type: "string", required: true, description: "Message body." },
      mentions: { type: "array", items: { type: "string" }, description: "Optional exact member aliases or stable session ids, or all. Message text is never parsed for delivery." }
    },
    output: { schema: { type: "object", additionalProperties: false, properties: { id: { type: "string", required: true }, delivered: { type: "number", required: true } } }, render: (_args, value) => [{ type: "text", text: `Sent ${value.id} to ${value.delivered} member(s).` }] },
    async execute(args, exec) {
      const room = await remote.chat.resolveRoom(args.room, { signal: exec.signal });
      const sessionId = owningSession(exec);
      if (!room.members.some((member) => member.kind === "session" && member.sessionId === sessionId)) throw new Error("the current session is not a member of this room");
      const message = await remote.chat.send({ roomId: room.id, author: sessionId, authorAlias: owningAlias(exec), text: args.text, mentions: args.mentions }, { signal: exec.signal });
      return { id: message.id, delivered: message.deliveries.filter((item) => item.status === "delivered").length };
    }
  }));
}

export { DshChatService, Remote };
