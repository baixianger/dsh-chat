import { DshChatService } from "./room-store.js";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";

/** The initial public contract version for dsh-chat. */
export const DSH_CHAT_PROTOCOL_VERSION = 1;

/** dsh-chat has a host identity; its interactive client is the next milestone. */
export const DSH_CHAT_STAGE = "room-service-mvp";

export const name = "dsh-chat";
export const inject = ["connection"];

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

/** Host entrypoint. Bridge and Weave are discovered only when a room sends. */
export function apply(ctx, config) {
  const remote = new DshChatRemote(ctx, config);
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
}

export { DshChatService, Remote };
