import { EventEmitter } from 'events'

declare global { var __warmupSseEmitter: EventEmitter | undefined }

export const warmupSseEmitter: EventEmitter =
  globalThis.__warmupSseEmitter ?? (globalThis.__warmupSseEmitter = new EventEmitter())

warmupSseEmitter.setMaxListeners(100)

export function emitWarmupChange(): void {
  warmupSseEmitter.emit('warmup-change')
}
