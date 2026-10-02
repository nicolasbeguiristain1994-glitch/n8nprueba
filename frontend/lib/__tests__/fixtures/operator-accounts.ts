import type { SyncPlatform } from '@/lib/casino-agents'

/** Business truth: configured account of each operator on each platform (empty = none configured). */
export const OPERATOR_ACCOUNTS: Record<string, Record<SyncPlatform, string[]>> = {
  bigwin:   { zeus: ['bigwin'],   bet30: ['bigwin'],    ganamos: ['admbigwin'],    argenbet: [] },
  ofizeus:  { zeus: ['ofizeus'],  bet30: ['zeus'],      ganamos: ['adminzeus'],    argenbet: ['adminzeus'] },
  betcoin:  { zeus: ['betcoin'],  bet30: ['btcuno'],    ganamos: ['adminbtc'],     argenbet: ['adminbtc'] },
  royal:    { zeus: ['royal'],    bet30: ['zeusroyal'], ganamos: ['adminroyal'],   argenbet: ['adminroyal'] },
  farabet:  { zeus: ['farabet'],  bet30: ['btcdos'],    ganamos: ['adminfara'],    argenbet: [] },
  imperio:  { zeus: ['imperio'],  bet30: ['imperio'],   ganamos: ['adminimperio'], argenbet: [] },
  lasvegas: { zeus: ['lasvegas'], bet30: [],            ganamos: [],               argenbet: [] },
}
