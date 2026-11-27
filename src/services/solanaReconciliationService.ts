import { supabase } from '../lib/supabase'

export type ReconciliationClassification =
  | 'IN_SYNC'
  | 'MISSING_ON_CHAIN'
  | 'MISSING_IN_DATABASE'
  | 'OWNER_MISMATCH'
  | 'STATUS_MISMATCH'
  | 'TRANSFER_HISTORY_MISMATCH'
  | 'CHECKIN_MISMATCH'
  | 'INVALID_ACCOUNT'
  | 'PENDING_CONFIRMATION'
  | 'RPC_UNAVAILABLE'
  | 'REQUIRES_MANUAL_REVIEW'

export type ReconciliationResult = {
  ticketId: string
  eventId: string
  databaseState: {
    status: string
    walletAddress: string | null
    ticketValid: boolean | null
    checkedIn: boolean | null
    transferCount: number | null
  } | null
  verifiedChainState: {
    owner: string
    valid: boolean
    checkedIn: boolean
    transferCount: number
  } | null
  classification: ReconciliationClassification
  autoRepairSafe: boolean
  reason: string
  timestamp: string
  transactionSignature: string | null
  repairAction: string | null
  repairSucceeded: boolean | null
}

export type ReconciliationResponse = {
  runId: string
  eventId: string
  mode: 'scan' | 'repair'
  pageSize: number
  nextCursor: string | null
  hasMore: boolean
  summary: {
    checked: number
    inSync: number
    discrepancies: number
    repaired: number
    manualReview: number
    errors: number
  }
  results: ReconciliationResult[]
  generatedAt: string
}

type Request = {
  eventId: string
  mode?: 'scan' | 'repair'
  ticketId?: string
  cursorAfter?: string | null
  pageSize?: number
  sourceRunId?: string
  items?: { ticketId: string; sourceRunId: string }[]
}

export async function reconcileSolanaTickets(input: Request): Promise<ReconciliationResponse> {
  if (!supabase) throw new Error('Supabase is not configured for ticket reconciliation.')
  const { data, error } = await supabase.functions.invoke<ReconciliationResponse>('reconcile-solana-tickets', {
    body: input,
  })
  if (error) throw new Error(`Ticket reconciliation failed: ${error.message}`)
  if (!data || !Array.isArray(data.results) || !data.summary || !data.runId) {
    throw new Error('The reconciliation service returned an invalid response.')
  }
  return data
}
