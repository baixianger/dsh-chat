/** The initial public contract version for dsh-chat. */
export declare const DSH_CHAT_PROTOCOL_VERSION: 1;

export declare const DSH_CHAT_STAGE: "room-service-mvp";
export declare const name = "dsh-chat";
export interface DshChatMember { kind: "session" | "weave"; sessionId: string; ticket?: string; }
export interface DshChatMessage { id: string; roomId: string; author: string; text: string; sentAt: number; deliveries: Array<{ member: string; kind: string; status: "delivered" | "failed"; error?: string }>; }
export declare class DshChatService {
  constructor(ctx: unknown, config?: { path?: string });
  subscribe(listener: (event: unknown) => void): () => void;
  listRooms(): Promise<unknown[]>;
  messages(roomId: string, limit?: number): Promise<DshChatMessage[]>;
  createRoom(request: { name: string; members?: DshChatMember[] }): Promise<unknown>;
  addMember(roomId: string, member: DshChatMember): Promise<DshChatMember>;
  resolveRoom(reference: string): Promise<unknown>;
  attachWeave(): void;
  send(request: { roomId: string; author: string; text: string; mentions?: string[] }): Promise<DshChatMessage>;
}
export declare function apply(ctx: unknown, config?: { path?: string }): void;
