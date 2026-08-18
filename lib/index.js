import { DshChatService } from "./room-store.js";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { defineTool } from "@deepseek-ai/dsh-tools";

/** The initial public contract version for dsh-chat. */
export const DSH_CHAT_PROTOCOL_VERSION = 1;

/** dsh-chat has a host identity; its interactive client is the next milestone. */
export const DSH_CHAT_STAGE = "room-service-mvp";

export const name = "dsh-chat";
export const inject = ["connection", "tools"];

function exposeRemote(instance, method) {
  Remote(method)(instance[method], {
    private: false,
    static: false,
    name: method,
    addInitializer(initializer) { initializer.call(instance); }
  });
}

/** Host Remote. The source-mode Typert gateway derives JSON request shapes. */
export class DshChatRemote extends TypertRemoteService {
  constructor(ctx, config) {
    super(ctx, "dshChat");
    this.chat = new DshChatService(ctx, config);
    for (const method of ["listRooms", "messages", "createRoom", "addMember", "send"]) exposeRemote(this, method);
  }
  async listRooms() { return this.chat.listRooms(); }
  async messages(roomId, limit) { return this.chat.messages(roomId, limit); }
  async createRoom(request) { return this.chat.createRoom(request); }
  async addMember(roomId, member) { return this.chat.addMember(roomId, member); }
  async send(request) { return this.chat.send(request); }
}

/** Host entrypoint. */
export function apply(ctx, config) {
  const remote = new DshChatRemote(ctx, config);
  remote.chat.attachWeave();
  const handlers = {
    listRooms: () => remote.listRooms(),
    messages: ({ roomId, limit }) => remote.messages(roomId, limit),
    createRoom: ({ request }) => remote.createRoom(request),
    addMember: ({ roomId, member }) => remote.addMember(roomId, member),
    send: ({ request }) => remote.send(request)
  };
  ctx.connection.rpc.handle("/dsh-chat", async (endpoint, payload) => {
    if (!(endpoint in handlers)) throw new Error(`unknown dsh-chat endpoint: ${endpoint}`);
    return { ok: true, value: await handlers[endpoint](payload?.args ?? {}) };
  }, { authority: "trusted-host" });
  const owningSession = (exec) => {
    if (!exec.agent) throw new Error("dsh-chat tools require an owning DSH session");
    return String(exec.agent.session.id);
  };
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
      const room = await remote.chat.createRoom({ name: args.name, members: [{ kind: "session", sessionId }] });
      return { id: room.id, name: room.name };
    }
  }));
  ctx.tools.register(defineTool({
    name: "chat_join",
    description: "Join the current DSH session to an existing local group chat. Use when the user asks to join a named group chat.",
    parameters: { room: { type: "string", required: true, description: "Exact room name or room id." } }, output: roomOutput,
    async execute(args, exec) {
      const room = await remote.chat.resolveRoom(args.room);
      await remote.chat.addMember(room.id, { kind: "session", sessionId: owningSession(exec) });
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
    async execute(args) {
      const room = await remote.chat.resolveRoom(args.room);
      await remote.chat.addMember(room.id, { kind: "session", sessionId: args.sessionId });
      return { id: room.id, name: room.name };
    }
  }));
  ctx.tools.register(defineTool({
    name: "chat_send",
    description: "Send a message to a DSH group chat as the current session. Omit mentions to notify the whole room; use exact session ids (without @) to target members, or [\"all\"] for broadcast.",
    parameters: {
      room: { type: "string", required: true, description: "Exact room name or room id." },
      text: { type: "string", required: true, description: "Message body." },
      mentions: { type: "array", items: { type: "string" }, description: "Optional exact member session ids, or all." }
    },
    output: { schema: { type: "object", additionalProperties: false, properties: { id: { type: "string", required: true }, delivered: { type: "number", required: true } } }, render: (_args, value) => [{ type: "text", text: `Sent ${value.id} to ${value.delivered} member(s).` }] },
    async execute(args, exec) {
      const room = await remote.chat.resolveRoom(args.room);
      const message = await remote.chat.send({ roomId: room.id, author: owningSession(exec), text: args.text, mentions: args.mentions });
      return { id: message.id, delivered: message.deliveries.filter((item) => item.status === "delivered").length };
    }
  }));
}

export { DshChatService, Remote };
