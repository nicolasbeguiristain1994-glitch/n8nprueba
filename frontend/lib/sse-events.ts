import { EventEmitter } from 'events'

declare global { var __sseEmitter: EventEmitter | undefined }

export const sseEmitter: EventEmitter =
  globalThis.__sseEmitter ?? (globalThis.__sseEmitter = new EventEmitter())

sseEmitter.setMaxListeners(200)

export type SseEventType = 'message' | 'status' | 'note' | 'blacklist'

export function emitUpdate(phone: string, eventType: SseEventType): void {
  sseEmitter.emit('update', { type: eventType, phone })
}
