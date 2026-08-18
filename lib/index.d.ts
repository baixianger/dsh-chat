/** The initial public contract version for dsh-chat. */
export declare const DSH_CHAT_PROTOCOL_VERSION: 1;

export declare const DSH_CHAT_STAGE: "room-sessions";
export declare const name = "dsh-chat";
export interface DshChatMember { kind: "session" | "weave"; sessionId: string; ticket?: string; }
export interface DshChatMessage { id: string; roomId: string; author: string; text: string; mentions: string[]; sentAt: number; deliveries: Array<{ member: string; kind: string; status: "delivered" | "failed"; error?: string }>; }
export declare class DshChatService {
  constructor(ctx: unknown, config?: { path?: string; workspacePath?: string });
  ensureRoomSessions(): Promise<void>;
  subscribe(listener: (event: unknown) => void): () => void;
  listRooms(): Promise<unknown[]>;
  messages(roomId: string, limit?: number, waitMs?: number): Promise<DshChatMessage[]>;
  createRoom(request: { name: string; members?: DshChatMember[] }): Promise<unknown>;
  addMember(roomId: string, member: DshChatMember): Promise<DshChatMember>;
  send(request: { roomId: string; author: string; text: string; mentions?: string[] }): Promise<DshChatMessage>;
  retryPendingDeliveries(): Promise<void>;
}
export declare function apply(ctx: unknown, config?: { path?: string }): void;
