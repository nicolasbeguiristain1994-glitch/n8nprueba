// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
const mocks=vi.hoisted(()=>({query:vi.fn(),cloud:vi.fn(),guard:vi.fn((_phone,fn)=>fn())}))
vi.mock('@/lib/db',()=>({query:mocks.query}))
vi.mock('@/lib/global-opt-out',()=>({withGlobalSendGuard:mocks.guard}))
vi.mock('@/lib/campaign-distributor',()=>({sendViaCloud:mocks.cloud,CloudSendOutcomeUnknownError:class extends Error{}}))
import { isReactionEmoji } from '../message-reactions'
import { buildMessagePayload } from '../cloud-api/infrastructure/message-sender.service'
import { sendMessageReaction, type ReactionTarget } from '../send-message-reaction'

describe('WhatsApp reactions',()=>{
  it.each(['','👍','👍🏽','❤️','🇦🇷','1️⃣','👨‍👩‍👧‍👦','✅'])('accepts a single emoji or removal: %s',emoji=>expect(isReactionEmoji(emoji)).toBe(true))
  it.each(['Hola','👍😂',' 👍','1','\n',null,'a'.repeat(65)])('rejects invalid content: %s',emoji=>expect(isReactionEmoji(emoji)).toBe(false))
  it.each(['👍',''])('builds the exact Cloud API payload for %s',emoji=>{
    expect(buildMessagePayload({phoneNumberId:'100',to:'+5491100000001',type:'reaction',reaction:{messageId:'wamid.target',emoji}}))
      .toEqual({messaging_product:'whatsapp',recipient_type:'individual',to:'+5491100000001',type:'reaction',reaction:{message_id:'wamid.target',emoji}})
  })
  const target={id:'message-id',line_id:'line-a',line_type:'cloud',phone_number_id:'100',phone_number:'+5491100000001',target_wamid:'wamid.target',direction:'inbound'} as ReactionTarget
  it('uses the target line with the existing reply, capacity and opt-out safeguards',async()=>{
    mocks.cloud.mockResolvedValue({messageId:'wamid.reaction'})
    await sendMessageReaction(target,'👍')
    expect(mocks.cloud).toHaveBeenCalledWith({id:'line-a',phone_number_id:'100'},target.phone_number,{kind:'reaction',messageId:'wamid.target',emoji:'👍'},undefined,{purpose:'conversation_reply',reserveCapacity:true})
  })
  it.each(['inbound','outbound'])('uses the correct Evolution key for %s messages',async direction=>{
    vi.stubEnv('EVOLUTION_GLOBAL_API_KEY','test-key')
    const fetchMock=vi.fn().mockResolvedValue(Response.json({key:{id:'reaction-id'}}))
    vi.stubGlobal('fetch',fetchMock)
    mocks.query.mockResolvedValueOnce([]).mockResolvedValueOnce([{evolution_url:'https://evolution.invalid',evolution_instance:'original'}])
    try {
      await sendMessageReaction({...target,line_type:'evolution',direction},'')
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({key:{remoteJid:'5491100000001@s.whatsapp.net',fromMe:direction==='outbound',id:'wamid.target'},reaction:''})
      expect(mocks.guard).toHaveBeenCalledWith(target.phone_number,expect.any(Function))
    } finally {vi.unstubAllGlobals();vi.unstubAllEnvs()}
  })
})
