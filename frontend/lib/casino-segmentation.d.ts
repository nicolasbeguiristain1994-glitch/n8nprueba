import type { PoolClient } from 'pg'
export const AGENTS: string[]
export function amountSQL(value: string): string
export function activitySQL(first: string, last: string, count: string): string
export function prepareSegmentation(client: Pick<PoolClient, 'query'>, options?: { contactIds?: string[] | null; importedOnly?: boolean }): Promise<{ linked: number; changed_levels: number; estimated_levels: number; partial_histories: number; unknown_activity: number }>
export function applySegmentation(client: Pick<PoolClient, 'query'>, options?: { skipActivity?: boolean; updatePlayers?: boolean }): Promise<void>
