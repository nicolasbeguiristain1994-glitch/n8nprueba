import type { WebhookMessage } from '@/lib/cloud-api/types/webhooks'

// Only explicit text and reply buttons can express consent; media captions,
// file names and sentences that happen to contain "baja" are not commands.
export function cloudOptOutCandidates(msg: WebhookMessage): string[] {
  if (msg.type === 'text') return [msg.text?.body ?? '']
  if (msg.type === 'button') return [msg.button?.payload ?? '', msg.button?.text ?? '']
  if (msg.type === 'interactive' && msg.interactive?.type === 'button_reply') {
    return [msg.interactive.button_reply?.id ?? '', msg.interactive.button_reply?.title ?? '']
  }
  return []
}

export function evolutionOptOutCandidates(msg: Record<string, unknown> | null): string[] {
  const text = msg?.conversation || (msg?.extendedTextMessage as {text?:string})?.text
  const button = (msg?.buttonsResponseMessage ?? msg?.templateButtonReplyMessage) as
    {selectedButtonId?:string;selectedDisplayText?:string;selectedId?:string} | undefined
  return [text, button?.selectedButtonId, button?.selectedId, button?.selectedDisplayText]
    .filter((value): value is string => typeof value === 'string' && !!value.trim())
}
