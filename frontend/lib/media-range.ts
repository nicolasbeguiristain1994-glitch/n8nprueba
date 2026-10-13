// Single byte ranges let native audio players seek, including Safari's 0-1 probe.
export function mediaRange(header: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match || (!match[1] && !match[2]) || size === 0) return null
  const first = Number(match[1]), last = Number(match[2])
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last)) return null
  const start = match[1] ? first : Math.max(0, size - last)
  const end = match[1] && match[2] ? Math.min(last, size - 1) : size - 1
  return start >= size || end < start ? null : { start, end }
}
