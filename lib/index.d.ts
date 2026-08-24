/** The initial public contract version for dsh-chat. */
export declare const DSH_CHAT_PROTOCOL_VERSION: 1;

export declare const DSH_CHAT_STAGE: "room-sessions";
export declare const name = "dsh-chat";
export declare const inject: readonly ["connection", "tools", "dshBridge", "dshWeave", "sessions", "workspaceRegistry", "sessionTitle"];
export interface DshChatConfig { path?: string; workspacePath?: string; }
export declare const Config: import("@standard-schema/spec").StandardSchemaV1<unknown, DshChatConfig>;
export interface DshChatMember { kind: "session" | "remote"; sessionId: string; alias?: string; workspaceTitle?: string; hostId?: string; hostName?: string; capability?: string; }
export interface DshChatMessage { id: string; roomId: string; author: string; authorHostId?: string; authorAlias?: string; text: string; mentions: string[]; sentAt: number; deliveries: Array<{ member: string; kind: string; status: "delivered" | "failed"; error?: string }>; }
export declare class DshChatService {
  constructor(ctx: unknown, config?: DshChatConfig);
  close(): Promise<void>;
  ensureRoomSessions(): Promise<void>;
  subscribe(listener: (event: unknown) => void): () => void;
  listRooms(): Promise<unknown[]>;
  messages(roomId: string, limit?: number, waitMs?: number): Promise<DshChatMessage[]>;
  remoteSessions(): Promise<Array<{ hostId: string; hostName: string; workspaces: Array<{ id: string; title: string; sessions: Array<{ id: string; title: string; running: boolean; updatedAt: number }> }> }>>;
  createRoom(request: { name: string; members?: DshChatMember[] }): Promise<unknown>;
  addMember(roomId: string, member: DshChatMember): Promise<DshChatMember>;
  removeMember(roomId: string, member: DshChatMember): Promise<DshChatMember | null>;
  send(request: { roomId: string; author: string; authorHostId?: string; authorAlias?: string; text: string; mentions?: string[] }): Promise<DshChatMessage>;
  retryPendingDeliveries(): Promise<void>;
}
declare module "@deepseek-ai/cordis" { interface Context { dshChat: DshChatRemote; } }
export declare class DshChatRemote { readonly chat: DshChatService; }
export declare function apply(ctx: Context, config?: DshChatConfig): void;
import type { Context } from "@deepseek-ai/cordis";
