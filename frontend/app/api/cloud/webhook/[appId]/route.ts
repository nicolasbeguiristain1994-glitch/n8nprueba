import type { NextRequest } from 'next/server'
import { handleWebhookGet, handleWebhookPost } from '@/lib/cloud-api/webhook-route'

type Context = { params: Promise<{ appId: string }> }

export async function GET(req: NextRequest, context: Context) {
  return handleWebhookGet(req, (await context.params).appId)
}

export async function POST(req: NextRequest, context: Context) {
  return handleWebhookPost(req, (await context.params).appId)
}
