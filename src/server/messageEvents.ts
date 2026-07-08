import type { MessageEventPayload } from "../shared/types.js";
import { messageEventId, type MessageChangeResult } from "./database.js";

export type MessageEventListener = (payload: MessageEventPayload) => void;

export class MessageEventHub {
  private readonly listeners = new Set<MessageEventListener>();

  subscribe(listener: MessageEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(change: MessageChangeResult | null): void {
    if (!change?.changed) return;
    const payload: MessageEventPayload = {
      eventId: change.eventId || messageEventId(change.message),
      message: change.message
    };
    for (const listener of this.listeners) {
      listener(payload);
    }
  }
}
