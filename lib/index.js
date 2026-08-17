import { DshChatService } from "./room-store.js";

/** The initial public contract version for dsh-chat. */
export const DSH_CHAT_PROTOCOL_VERSION = 1;

/** dsh-chat has a host identity; its interactive client is the next milestone. */
export const DSH_CHAT_STAGE = "room-service-mvp";

export const name = "dsh-chat";

/** Host entrypoint. Bridge and Weave are discovered only when a room sends. */
export function apply(ctx, config) {
  const chat = new DshChatService(ctx, config);
  ctx.accessor("dshChat", { get: () => chat });
}

export { DshChatService };
