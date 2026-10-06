import type { NextRequest } from 'next/server'
import { handleWebhookGet, handleWebhookPost } from '@/lib/cloud-api/webhook-route'

export async function GET(req: NextRequest) { return handleWebhookGet(req) }
export async function POST(req: NextRequest) { return handleWebhookPost(req) }
