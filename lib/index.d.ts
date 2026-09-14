/** The initial public contract version for dsh-chat. */
export declare const DSH_CHAT_PROTOCOL_VERSION: 1;

export declare const DSH_CHAT_STAGE: "room-sessions";
export declare const name = "dsh-chat";
export declare const inject: readonly ["connection", "tools", "dshBridge", "sessions", "workspaceRegistry", "sessionTitle", "sessionPersistence"];
export interface DshChatOperationOptions { signal?: AbortSignal; }
export interface DshChatConfig { path?: string; workspacePath?: string; }
export declare const Config: import("@standard-schema/spec").StandardSchemaV1<unknown, DshChatConfig>;
/** One logical RPC failure carried in the `RpcResult` error branch. */
export interface DshChatRpcFailure { code: string; message: string; details: object; }
export type DshChatRpcResult = { ok: true; value: unknown } | { ok: false; error: DshChatRpcFailure };
/**
 * Build the `/api/dsh-chat` endpoint handler: every input, including a throwing
 * endpoint, is answered with an `RpcResult` instead of an HTTP 500.
 * @param handlers - endpoint table keyed by wire endpoint name.
 * @returns the endpoint handler.
 */
export declare function createRpcHandler(handlers: Record<string, (args: any, options?: DshChatOperationOptions) => Promise<unknown>>): (endpoint: string, payload: unknown, options?: DshChatOperationOptions) => Promise<DshChatRpcResult>;
/**
 * Answer one room UI POST on `/api/dsh-chat`: a body that is not JSON, a missing
 * endpoint, and a throwing handler are all answered with HTTP 200 carrying an
 * `RpcResult` instead of a thrown transport failure.
 * @param handler - the endpoint handler built by `createRpcHandler`.
 * @param request - the incoming request.
 * @returns the response carrying the `RpcResult`.
 */
export declare function handleChatRequest(handler: (endpoint: string, payload: any, options?: DshChatOperationOptions) => Promise<DshChatRpcResult>, request: { json(): Promise<any>; signal?: AbortSignal }): Promise<Response>;
export interface DshChatMember { kind: "session" | "remote"; sessionId: string; alias?: string; workspaceTitle?: string; hostId?: string; hostName?: string; capability?: string; }
export interface DshChatMessage { id: string; roomId: string; author: string; authorHostId?: string; authorAlias?: string; text: string; mentions: string[]; sentAt: number; deliveries: Array<{ member: string; kind: string; status: "delivered" | "failed"; error?: string }>; }
export declare class DshChatService {
  constructor(ctx: unknown, config?: DshChatConfig);
  close(): Promise<void>;
  ensureRoomSessions(): Promise<void>;
  subscribe(listener: (event: unknown) => void): () => void;
  listRooms(options?: DshChatOperationOptions): Promise<unknown[]>;
  messages(roomId: string, limit?: number, waitMs?: number, options?: DshChatOperationOptions): Promise<DshChatMessage[]>;
  remoteSessions(options?: DshChatOperationOptions): Promise<Array<{ hostId: string; hostName: string; workspaces: Array<{ id: string; title: string; sessions: Array<{ id: string; title: string; running: boolean; updatedAt: number }> }> }>>;
  createRoom(request: { name: string; members?: DshChatMember[] }, options?: DshChatOperationOptions): Promise<unknown>;
  addMember(roomId: string, member: DshChatMember, options?: DshChatOperationOptions): Promise<DshChatMember>;
  removeMember(roomId: string, member: DshChatMember, options?: DshChatOperationOptions): Promise<DshChatMember | null>;
  send(request: { roomId: string; author: string; authorHostId?: string; authorAlias?: string; text: string; mentions?: string[] }, options?: DshChatOperationOptions): Promise<DshChatMessage>;
  resolveRoom(reference: string, options?: DshChatOperationOptions): Promise<unknown>;
  retryPendingDeliveries(): Promise<void>;
}
declare module "@deepseek-ai/cordis" { interface Context { dshChat: DshChatRemote; } }
export declare class DshChatRemote { readonly chat: DshChatService; }
export declare function apply(ctx: Context, config?: DshChatConfig): void;
import type { Context } from "@deepseek-ai/cordis";
