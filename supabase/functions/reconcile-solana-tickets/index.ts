import { createClient } from 'npm:@supabase/supabase-js@2'
import { PublicKey } from 'npm:@solana/web3.js@1.98.4'
import {
  assertProgramOwner,
  assertExpectedPda,
  bytesUuid,
  classifyReconciliation,
  confirmationFinality,
  createDevnetRpc,
  decodeEventAccount,
  decodeTicketAccount,
  decodeTransferReceipt,
  deriveTicketPdas,
  deriveTransferReceipt,
  DEVNET_GENESIS_HASH,
  equalBytes,
  isAuthorizedEventOwner,
  isUuid,
  MAX_TRANSFER_HISTORY,
  mergePageIds,
  PROGRAM_ID,
  RpcUnavailableError,
  assertRegistrationTransaction,
  assertTransferTransaction,
  assertCheckInTransaction,
  type DatabaseTicketState,
  type DevnetRpc,
  type DiscrepancyClassification,
  type FinalizedTransaction,
  type ReconciliationResult,
  type TransferState,
  type VerifiedChainState,
} from './reconciliation.ts'

const MAX_EVENT_TICKETS = 2_000
const corsHeaders = {
  'content-type': 'application/json',
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info',
}

function assertAccountProgramOwner(owner: string, accountName: string) {
  try { assertProgramOwner(owner, accountName) }
  catch (error) { throw new InvalidAccountError(error instanceof Error ? error.message : `${accountName} has an unexpected program owner.`) }
}

type EventRow = {
  id: string
  organizer_id: string
  solana_network: string | null
  solana_program_id: string | null
  solana_event_account: string | null
}

type TicketRow = {
  id: string
  event_id: string
  status: string
  blockchain_status: string
  solana_network: string | null
  solana_program_id: string | null
  solana_ticket_account: string | null
  solana_event_account: string | null
  solana_registration_signature: string | null
  solana_transaction_signature: string | null
  blockchain_verified_at: string | null
  wallet_address: string | null
  solana_ticket_valid: boolean | null
  solana_checked_in: boolean | null
  solana_transfer_count: number | null
  checked_in_at: string | null
  checked_in_by: string | null
  holder_user_id: string | null
}

type TransferRow = {
  ticket_id: string
  from_wallet: string
  to_wallet: string
  transaction_signature: string
  transfer_sequence: number | null
  solana_receipt_account: string | null
  solana_network: string
}

type CheckInRow = {
  ticket_id: string
  organizer_user_id: string
  organizer_wallet: string
  transaction_signature: string
  verified_at: string
  solana_network: string
}

type RpcContext<T> = { context?: { slot?: number }; value: T }
type AccountInfo = { owner: string; data: [string, string] } | null
type SignatureInfo = { signature: string; err: unknown | null; confirmationStatus: string | null; slot: number }
type ProgramAccount = { pubkey: string; account: { owner: string; data: [string, string] } }
type RequestBody = {
  mode?: 'scan' | 'repair'
  eventId?: string
  ticketId?: string
  cursorAfter?: string | null
  pageSize?: number
  sourceRunId?: string
  items?: { ticketId: string; sourceRunId?: string }[]
}

class PendingConfirmationError extends Error {}
class InvalidAccountError extends Error {}
class ManualReviewError extends Error {}
class MissingChainAccountError extends Error {}

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') return respond({ error: 'Use POST for ticket reconciliation.' }, 405)
  return handleRequest(request)
})

async function handleRequest(request: Request) {
  let runId: string | null = null
  let admin: ReturnType<typeof createClient> | null = null
  let actorId: string | null = null
  let eventId: string | null = null
  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    const rpcUrl = Deno.env.get('SOLANA_DEVNET_RPC_URL') || 'https://api.devnet.solana.com'
    const configuredProgram = Deno.env.get('SOLANA_PROGRAM_ID')
    if (!supabaseUrl || !anonKey || !serviceRoleKey) throw new Error('Reconciliation service is not configured.')
    if (configuredProgram && configuredProgram !== PROGRAM_ID) throw new RpcUnavailableError('Configured Solana program ID does not match the deployed Devnet IDL.')
    const parsedRpc = new URL(rpcUrl)
    if (parsedRpc.protocol !== 'https:' || /mainnet|testnet/i.test(parsedRpc.hostname)) {
      throw new RpcUnavailableError('Reconciliation RPC must be an HTTPS Solana Devnet endpoint.')
    }

    const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '')
    if (!token) return respond({ error: 'Sign in to reconcile tickets.' }, 401)
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const { data: auth, error: authError } = await userClient.auth.getUser(token)
    if (authError || !auth.user) return respond({ error: 'Your NODARA session could not be verified. Sign in again.' }, 401)
    actorId = auth.user.id
    admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })

    const body = await parseBody(request)
    eventId = body.eventId ?? ''
    const mode = body.mode ?? 'scan'
    const pageSize = body.pageSize ?? 10
    if (!isUuid(eventId) || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 25) {
      return respond({ error: 'Event ID or page size is invalid.' }, 400)
    }
    if (mode !== 'scan' && mode !== 'repair') return respond({ error: 'Unsupported reconciliation mode.' }, 400)
    if (body.cursorAfter !== undefined && body.cursorAfter !== null && !isUuid(body.cursorAfter)) {
      return respond({ error: 'Pagination cursor is invalid.' }, 400)
    }

    const { data: eventData, error: eventError } = await admin.from('events')
      .select('id,organizer_id,solana_network,solana_program_id,solana_event_account')
      .eq('id', eventId).maybeSingle()
    if (eventError) throw new Error('Could not load event authorization and chain metadata.')
    const event = eventData as EventRow | null
    if (!event) return respond({ error: 'Event was not found.' }, 404)
    if (!isAuthorizedEventOwner(event.organizer_id, actorId)) return respond({ error: 'Only this event’s organiser can reconcile its tickets.' }, 403)

    const scope = mode === 'repair' || body.ticketId ? 'ticket' : 'event'
    if (body.ticketId && !isUuid(body.ticketId)) return respond({ error: 'Ticket ID is invalid.' }, 400)
    let selectedTicketIsOffChain = false
    if (mode === 'scan' && body.ticketId) {
      const { data: selectedTicket, error: selectedTicketError } = await admin.from('tickets')
        .select('id,blockchain_status').eq('id', body.ticketId).eq('event_id', event.id).maybeSingle()
      if (selectedTicketError) throw new Error('Could not validate the selected ticket.')
      selectedTicketIsOffChain = (selectedTicket as { blockchain_status: string } | null)?.blockchain_status === 'off_chain'
    }
    if (mode === 'repair' && (!body.sourceRunId || !isUuid(body.sourceRunId) || !Array.isArray(body.items)
      || body.items.length < 1 || body.items.length > 25
      || body.items.some(item => !item || !isUuid(item.ticketId) || (item.sourceRunId && item.sourceRunId !== body.sourceRunId)))) {
      return respond({ error: 'Repair requires selected ticket IDs from one authorised scan page.' }, 400)
    }
    if (mode === 'repair' && body.items && new Set(body.items.map(item => item.ticketId)).size !== body.items.length) {
      return respond({ error: 'Repair ticket IDs must be unique.' }, 400)
    }
    if (mode === 'scan' && body.items) return respond({ error: 'Scan requests cannot contain repair items.' }, 400)
    if (mode === 'scan' && scope === 'ticket' && !body.ticketId) return respond({ error: 'A single-ticket scan requires a ticket ID.' }, 400)

    runId = crypto.randomUUID()
    const sourceRunId = mode === 'repair' ? body.sourceRunId! : null
    const { error: runError } = await rpcCall<string>(admin, 'start_solana_reconciliation_run', {
      p_run_id: runId,
      p_event_id: eventId,
      p_initiated_by: actorId,
      p_mode: mode,
      p_scope: scope,
      p_page_size: pageSize,
      p_cursor_after: body.cursorAfter ?? null,
      p_source_run_id: sourceRunId,
    })
    if (runError) {
      const rateLimited = /rate limit/i.test(runError.message)
      const forbidden = /access denied|source reconciliation run/i.test(runError.message)
      return respond({ error: runError.message }, rateLimited ? 429 : forbidden ? 403 : 400)
    }

    const rpc = createDevnetRpc(rpcUrl)
    if (selectedTicketIsOffChain && body.ticketId) {
      await assertDevnet(rpc)
      const { ticket } = deriveTicketPdas(event.id, body.ticketId)
      const account = await rpc<RpcContext<AccountInfo>>('getAccountInfo', [
        ticket.toBase58(), { encoding: 'base64', commitment: 'finalized' },
      ])
      if (!account.value) {
        const { error: finishError } = await rpcCall<void>(admin, 'finish_solana_reconciliation_run', {
          p_run_id: runId,
          p_initiated_by: actorId,
          p_status: 'completed',
          p_checked_count: 0,
          p_in_sync_count: 0,
          p_discrepancy_count: 0,
          p_repaired_count: 0,
          p_manual_review_count: 0,
          p_error_count: 0,
        })
        if (finishError) throw new Error('Could not close the reconciliation run.')
        return respond({ error: 'This ticket is off-chain and has no finalized Devnet account to reconcile.' }, 409)
      }
    }
    const results = mode === 'scan'
      ? await scanEventPage(admin, rpc, event, actorId, runId, body, pageSize)
      : await repairSelectedTickets(admin, rpc, event, actorId, runId, sourceRunId!, body.items!)

    const counts = summarize(results.items)
    const { error: finishError } = await rpcCall<void>(admin, 'finish_solana_reconciliation_run', {
      p_run_id: runId,
      p_initiated_by: actorId,
      p_status: 'completed',
      p_checked_count: results.items.length,
      p_in_sync_count: counts.inSync,
      p_discrepancy_count: counts.discrepancies,
      p_repaired_count: counts.repaired,
      p_manual_review_count: counts.manualReview,
      p_error_count: counts.errors,
    })
    if (finishError) throw new Error('Reconciliation results were produced, but the audit run could not be completed.')

    return respond({
      runId,
      eventId,
      mode,
      pageSize,
      nextCursor: results.nextCursor,
      hasMore: results.nextCursor !== null,
      summary: { checked: results.items.length, ...counts },
      results: results.items,
      generatedAt: new Date().toISOString(),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Ticket reconciliation failed.'
    console.error('reconcile-solana-tickets:', error)
    if (admin && runId && actorId) {
      await rpcCall<void>(admin, 'finish_solana_reconciliation_run', {
        p_run_id: runId,
        p_initiated_by: actorId,
        p_status: 'failed',
        p_checked_count: 0,
        p_in_sync_count: 0,
        p_discrepancy_count: 0,
        p_repaired_count: 0,
        p_manual_review_count: 0,
        p_error_count: 1,
      })
    }
    const status = error instanceof RpcUnavailableError ? 503
      : error instanceof PendingConfirmationError ? 409
        : error instanceof ManualReviewError ? 409
          : 500
    return respond({
      error: message,
      results: eventId && actorId && error instanceof RpcUnavailableError
        ? [{ ticketId: '', eventId, databaseState: null, verifiedChainState: null, classification: 'RPC_UNAVAILABLE', autoRepairSafe: false, reason: message, timestamp: new Date().toISOString(), transactionSignature: null, repairAction: null, repairSucceeded: null }]
        : undefined,
    }, status)
  }
}

async function scanEventPage(
  admin: ReturnType<typeof createClient>,
  rpc: DevnetRpc,
  event: EventRow,
  actorId: string,
  runId: string,
  body: RequestBody,
  pageSize: number,
) {
  let ticketIds: string[]
  let nextCursor: string | null = null
  let chainAccounts = new Map<string, ProgramAccount>()
  let eventState: EventChainState | null = null
  let discoveryError: Error | null = null

  try {
    await assertDevnet(rpc)
    const eventPdas = deriveTicketPdas(event.id, event.id)
    if (event.solana_network && event.solana_network !== 'devnet') throw new InvalidAccountError('Stored event is not marked for Devnet.')
    if (event.solana_program_id && event.solana_program_id !== PROGRAM_ID) throw new InvalidAccountError('Stored event program ID does not match the deployed Devnet program.')
    if (event.solana_event_account && event.solana_event_account !== eventPdas.event.toBase58()) throw new InvalidAccountError('Stored event PDA does not match the Anchor seeds.')
    eventState = await fetchEventState(rpc, event.id)
    if (!body.ticketId) chainAccounts = await fetchEventTickets(rpc, eventPdas.event.toBase58())
  } catch (error) {
    discoveryError = normalizeRpcError(error)
  }

  if (body.ticketId) {
    ticketIds = [body.ticketId]
  } else {
    const query = admin.from('tickets').select('id').eq('event_id', event.id)
      .neq('blockchain_status', 'off_chain').order('id').limit(pageSize + 1)
    const { data, error } = body.cursorAfter ? await query.gt('id', body.cursorAfter) : await query
    if (error) throw new Error('Could not page event ticket identifiers.')
    const databaseIds = ((data ?? []) as { id: string }[]).map(row => row.id)
    const merged = discoveryError
      ? { ticketIds: databaseIds.slice(0, pageSize), hasMore: databaseIds.length > pageSize, nextCursor: databaseIds.length > pageSize ? databaseIds[pageSize - 1] : null }
      : mergePageIds(databaseIds, [...chainAccounts.keys()], body.cursorAfter ?? null, pageSize)
    ticketIds = merged.ticketIds
    nextCursor = merged.nextCursor
  }
  if (discoveryError && ticketIds.length === 0) throw discoveryError

  const { data: ticketData, error: ticketError } = ticketIds.length
    ? await admin.from('tickets').select('*').eq('event_id', event.id).in('id', ticketIds)
    : { data: [], error: null }
  if (ticketError) throw new Error('Could not load ticket records for reconciliation.')
  const tickets = new Map(((ticketData ?? []) as TicketRow[]).map(ticket => [ticket.id, ticket]))
  const transferRows = ticketIds.length
    ? await admin.from('ticket_transfer_history')
      .select('ticket_id,from_wallet,to_wallet,transaction_signature,transfer_sequence,solana_receipt_account,solana_network')
      .in('ticket_id', ticketIds)
    : { data: [], error: null }
  if (transferRows.error) throw new Error('Could not load transfer history for reconciliation.')
  const checkInRows = ticketIds.length
    ? await admin.from('ticket_checkin_history')
      .select('ticket_id,organizer_user_id,organizer_wallet,transaction_signature,verified_at,solana_network')
      .in('ticket_id', ticketIds)
    : { data: [], error: null }
  if (checkInRows.error) throw new Error('Could not load check-in history for reconciliation.')
  const transfersByTicket = groupBy((transferRows.data ?? []) as TransferRow[], row => row.ticket_id)
  const checkInsByTicket = groupBy((checkInRows.data ?? []) as CheckInRow[], row => row.ticket_id)

  const items: ReconciliationResult[] = []
  for (const ticketId of ticketIds) {
    const ticket = tickets.get(ticketId) ?? null
    const databaseState = ticket ? toDatabaseState(ticket, transfersByTicket.get(ticketId) ?? [], checkInsByTicket.get(ticketId) ?? []) : null
    let result: ReconciliationResult
    if (discoveryError) {
      result = classifyReconciliation({
        ticketId, eventId: event.id, databaseState, verifiedChainState: null,
        failure: discoveryError instanceof InvalidAccountError ? 'invalid'
          : discoveryError instanceof PendingConfirmationError ? 'pending'
            : discoveryError instanceof MissingChainAccountError ? 'manual' : 'rpc',
        reason: discoveryError.message,
      })
    } else if (chainAccounts.size > MAX_EVENT_TICKETS) {
      result = classifyReconciliation({
        ticketId, eventId: event.id, databaseState, verifiedChainState: null,
        failure: 'manual', reason: `Event has more than ${MAX_EVENT_TICKETS} on-chain tickets; use single-ticket reconciliation or contact support.`,
      })
    } else {
      try {
        result = await reconcileOne(admin, rpc, event, ticketId, databaseState, tickets.get(ticketId) ?? null, chainAccounts.get(ticketId) ?? null, eventState!)
      } catch (error) {
        const failure = error instanceof PendingConfirmationError ? 'pending'
          : error instanceof InvalidAccountError ? 'invalid'
            : error instanceof ManualReviewError ? 'manual'
              : error instanceof RpcUnavailableError ? 'rpc'
                : error instanceof MissingChainAccountError && databaseState ? undefined
                  : error instanceof MissingChainAccountError ? 'manual' : 'manual'
        result = classifyReconciliation({
          ticketId, eventId: event.id, databaseState, verifiedChainState: null,
          failure,
          reason: error instanceof Error ? error.message : 'Could not verify ticket state.',
        })
      }
    }
    await storeAudit(admin, {
      runId, eventId: event.id, ticketId, actorId, result,
      databaseState: databaseState as unknown as Record<string, unknown> | null,
    })
    items.push(result)
  }
  return { items, nextCursor }
}

async function repairSelectedTickets(
  admin: ReturnType<typeof createClient>,
  rpc: DevnetRpc,
  event: EventRow,
  actorId: string,
  repairRunId: string,
  sourceRunId: string,
  items: { ticketId: string; sourceRunId?: string }[],
) {
  await assertDevnet(rpc)
  const results: ReconciliationResult[] = []
  for (const item of items) {
    const { data: sourceRow, error: sourceError } = await admin.from('solana_reconciliation_audit')
      .select('ticket_id,classification,database_state,verified_chain_state,auto_repair_safe,reason')
      .eq('run_id', sourceRunId).eq('event_id', event.id).eq('ticket_id', item.ticketId)
      .eq('initiated_by', actorId).maybeSingle()
    if (sourceError) throw new Error('Could not verify the selected reconciliation result.')
    const source = sourceRow as {
      ticket_id: string
      classification: DiscrepancyClassification
      database_state: Record<string, unknown> | null
      verified_chain_state: VerifiedChainState | null
      auto_repair_safe: boolean
      reason: string
    } | null
    if (!source || !source.auto_repair_safe || !['OWNER_MISMATCH', 'STATUS_MISMATCH', 'TRANSFER_HISTORY_MISMATCH', 'CHECKIN_MISMATCH'].includes(source.classification)) {
      const result = classifyReconciliation({
        ticketId: item.ticketId, eventId: event.id, databaseState: null, verifiedChainState: null,
        failure: 'manual', reason: 'This ticket was not marked safe for automatic repair by the selected scan.',
      })
      await storeAudit(admin, { runId: repairRunId, sourceRunId, eventId: event.id, ticketId: item.ticketId, actorId, result, databaseState: null, actionTaken: 'repair refused' })
      results.push(result)
      continue
    }

    const { data: ticketData, error: ticketError } = await admin.from('tickets').select('*')
      .eq('id', item.ticketId).eq('event_id', event.id).maybeSingle()
    if (ticketError) throw new Error('Could not re-read ticket state before repair.')
    if (!ticketData) throw new Error('Ticket disappeared before repair.')
    const ticket = ticketData as TicketRow
    const historyResult = await admin.from('ticket_transfer_history')
      .select('ticket_id,from_wallet,to_wallet,transaction_signature,transfer_sequence,solana_receipt_account,solana_network')
      .eq('ticket_id', item.ticketId)
    if (historyResult.error) throw new Error('Could not re-read transfer history before repair.')
    const checkInResult = await admin.from('ticket_checkin_history')
      .select('ticket_id,organizer_user_id,organizer_wallet,transaction_signature,verified_at,solana_network')
      .eq('ticket_id', item.ticketId)
    if (checkInResult.error) throw new Error('Could not re-read check-in history before repair.')
    const databaseState = toDatabaseState(ticket, (historyResult.data ?? []) as TransferRow[], (checkInResult.data ?? []) as CheckInRow[])
    let result: ReconciliationResult
    try {
      const eventState = await fetchEventState(rpc, event.id)
      result = await reconcileOne(admin, rpc, event, item.ticketId, databaseState, ticket, null, eventState)
    } catch (error) {
      result = classifyReconciliation({
        ticketId: item.ticketId, eventId: event.id, databaseState, verifiedChainState: null,
        failure: error instanceof PendingConfirmationError ? 'pending'
          : error instanceof InvalidAccountError ? 'invalid'
            : error instanceof ManualReviewError ? 'manual'
              : error instanceof MissingChainAccountError ? undefined
                : error instanceof RpcUnavailableError ? 'rpc' : 'manual',
        reason: error instanceof Error ? error.message : 'Could not re-verify the ticket before repair.',
      })
    }

    if (!result.autoRepairSafe || result.classification === 'IN_SYNC' || !result.verifiedChainState) {
      await storeAudit(admin, {
        runId: repairRunId, sourceRunId, eventId: event.id, ticketId: item.ticketId, actorId, result,
        databaseState: databaseState as unknown as Record<string, unknown>,
        actionTaken: result.classification === 'IN_SYNC' ? 'already synchronized; no write required' : 'repair refused after re-verification',
      })
      results.push(result)
      continue
    }
    if (result.classification !== source.classification) {
      result = {
        ...result, classification: 'REQUIRES_MANUAL_REVIEW', autoRepairSafe: false,
        repairAction: null,
        reason: 'Ticket discrepancy changed since the scan; no repair was applied. Run reconciliation again.',
      }
      await storeAudit(admin, {
        runId: repairRunId, sourceRunId, eventId: event.id, ticketId: item.ticketId, actorId, result,
        databaseState: databaseState as unknown as Record<string, unknown>, actionTaken: 'repair refused because state changed',
      })
      results.push(result)
      continue
    }

    const { data: applied, error: applyError } = await rpcCall<{ repaired: boolean; action?: string }>(admin, 'apply_solana_ticket_reconciliation', {
      p_run_id: repairRunId,
      p_source_run_id: sourceRunId,
      p_ticket_id: item.ticketId,
      p_initiated_by: actorId,
      p_classification: result.classification,
      p_previous_state: databaseState,
      p_verified_chain_state: result.verifiedChainState,
      p_reason: result.reason,
    })
    if (applyError || applied?.repaired !== true) {
      const message = applyError?.message ?? 'Database repair did not complete.'
      result = { ...result, autoRepairSafe: false, repairAction: null, repairSucceeded: false, reason: `${result.reason} Repair failed: ${message}` }
      await storeAudit(admin, {
        runId: repairRunId, sourceRunId, eventId: event.id, ticketId: item.ticketId, actorId, result,
        databaseState: databaseState as unknown as Record<string, unknown>, actionTaken: 'repair failed', errorDetails: message,
      })
    } else {
      result = { ...result, repairSucceeded: true, repairAction: applied.action ?? result.repairAction }
    }
    results.push(result)
  }
  return { items: results, nextCursor: null }
}

async function reconcileOne(
  admin: ReturnType<typeof createClient>,
  rpc: DevnetRpc,
  event: EventRow,
  ticketId: string,
  databaseState: DatabaseTicketState | null,
  ticket: TicketRow | null,
  indexedAccount: ProgramAccount | null,
  eventState: EventChainState,
): Promise<ReconciliationResult> {
  if ((event.solana_network && event.solana_network !== 'devnet')
    || (event.solana_program_id && event.solana_program_id !== PROGRAM_ID)) {
    throw new InvalidAccountError('Stored event network or program ID conflicts with the configured Devnet deployment.')
  }
  if (!eventState.account) throw new InvalidAccountError('The derived event PDA is missing or invalid at finalized commitment.')
  const pdas = deriveTicketPdas(event.id, ticketId)
  try {
    assertExpectedPda(eventState.address, pdas.event.toBase58(), 'Event PDA')
    if (event.solana_event_account) assertExpectedPda(event.solana_event_account, pdas.event.toBase58(), 'Stored event PDA')
  } catch (error) {
    throw new InvalidAccountError(error instanceof Error ? error.message : 'Event PDA is invalid.')
  }
  if (!equalBytes(eventState.decoded.eventId, pdas.eventBytes) || eventState.decoded.bump !== pdas.eventBump) throw new InvalidAccountError('Event account identifier or bump does not match its PDA.')
  if (ticket?.solana_network && ticket.solana_network !== 'devnet') throw new InvalidAccountError('Ticket is not marked for Devnet.')
  if (ticket?.solana_program_id && ticket.solana_program_id !== PROGRAM_ID) throw new InvalidAccountError('Stored ticket program ID conflicts with the deployed program.')
  try {
    if (ticket?.solana_ticket_account) assertExpectedPda(ticket.solana_ticket_account, pdas.ticket.toBase58(), 'Stored ticket PDA')
    if (ticket?.solana_event_account) assertExpectedPda(ticket.solana_event_account, pdas.event.toBase58(), 'Stored ticket event PDA')
  } catch (error) {
    throw new InvalidAccountError(error instanceof Error ? error.message : 'Ticket PDA is invalid.')
  }

  const rawAccount = indexedAccount
    ? { context: { slot: eventState.slot }, value: indexedAccount.account }
    : await rpc<RpcContext<AccountInfo>>('getAccountInfo', [pdas.ticket.toBase58(), { encoding: 'base64', commitment: 'finalized' }])
  const accountInfo = rawAccount.value
  if (!accountInfo) {
    if (ticket?.blockchain_status === 'pending' && ticket.solana_transaction_signature) {
      const state = await getSignatureState(rpc, ticket.solana_transaction_signature)
      if (state !== 'finalized') throw new PendingConfirmationError('Registration transaction has not reached finalized commitment.')
    }
    throw new MissingChainAccountError('Derived ticket PDA is absent at finalized commitment.')
  }
  assertAccountProgramOwner(accountInfo.owner, 'Ticket PDA')
  const ticketData = decodeAccountData(accountInfo.data)
  const decodedTicket = decodeTicketAccount(ticketData)
  if (indexedAccount) {
    try { assertExpectedPda(indexedAccount.pubkey, pdas.ticket.toBase58(), 'On-chain ticket account') }
    catch (error) { throw new InvalidAccountError(error instanceof Error ? error.message : 'Ticket PDA is invalid.') }
  }
  if (!equalBytes(decodedTicket.ticketId, pdas.ticketBytes) || decodedTicket.event !== pdas.event.toBase58()
    || decodedTicket.issuer !== eventState.decoded.organizer || decodedTicket.bump !== pdas.ticketBump) {
    throw new InvalidAccountError('Ticket ID, event, issuer or bump does not match the expected Anchor account.')
  }

  const registration = await findRegistration(rpc, ticket, event, ticketId, pdas.event, pdas.ticket, eventState.decoded.organizer)
  const transfers = await verifyTransferHistory(rpc, ticketId, pdas.event, pdas.ticket, decodedTicket, registration.initialOwner)
  const checkIn = decodedTicket.checkedIn
    ? await findCheckIn(admin, rpc, ticket, ticketId, pdas.event, pdas.ticket, eventState.decoded.organizer)
    : await verifyExistingCheckIn(admin, rpc, ticket, ticketId, pdas.event, pdas.ticket, eventState.decoded.organizer)
  const verifiedChainState: VerifiedChainState = {
    network: 'devnet',
    programId: PROGRAM_ID,
    eventAccount: pdas.event.toBase58(),
    ticketAccount: pdas.ticket.toBase58(),
    eventId: event.id,
    ticketId,
    organizer: eventState.decoded.organizer,
    issuer: decodedTicket.issuer,
    initialOwner: registration.initialOwner,
    owner: decodedTicket.owner,
    valid: decodedTicket.valid,
    checkedIn: decodedTicket.checkedIn,
    transferCount: decodedTicket.transferCount,
    transferHistory: transfers,
    registrationSignature: registration.signature,
    checkInSignature: checkIn?.signature ?? null,
    checkInBlockTime: checkIn?.blockTime ?? null,
    checkInOrganizerWallet: checkIn?.organizer ?? null,
    lastTransferSignature: transfers.at(-1)?.signature ?? null,
    finalizedSlot: Math.max(eventState.slot, rawAccount.context?.slot ?? 0),
  }
  return classifyReconciliation({
    ticketId, eventId: event.id, databaseState, verifiedChainState,
    failure: registration.manualReason ? 'manual' : undefined,
    reason: registration.manualReason ?? undefined,
    eventOrganizerUserId: event.organizer_id,
  })
}

type EventChainState = { address: string; account: AccountInfo; decoded: ReturnType<typeof decodeEventAccount>; slot: number }

async function fetchEventState(rpc: DevnetRpc, eventId: string): Promise<EventChainState> {
  const pdas = deriveTicketPdas(eventId, eventId)
  const result = await rpc<RpcContext<AccountInfo>>('getAccountInfo', [pdas.event.toBase58(), { encoding: 'base64', commitment: 'finalized' }])
  if (!result.value) throw new MissingChainAccountError('Derived event PDA is absent at finalized commitment.')
  assertAccountProgramOwner(result.value.owner, 'Event PDA')
  const decoded = decodeEventAccount(decodeAccountData(result.value.data))
  if (!equalBytes(decoded.eventId, pdas.eventBytes) || decoded.bump !== pdas.eventBump) throw new InvalidAccountError('Event account data does not match its Anchor PDA.')
  return { address: pdas.event.toBase58(), account: result.value, decoded, slot: result.context?.slot ?? 0 }
}

async function fetchEventTickets(rpc: DevnetRpc, eventPda: string) {
  const result = await rpc<ProgramAccount[]>('getProgramAccounts', [PROGRAM_ID, {
    commitment: 'finalized',
    encoding: 'base64',
    filters: [
      { dataSize: 127 },
      { memcmp: { offset: 24, bytes: eventPda } },
    ],
  }])
  const accounts = new Map<string, ProgramAccount>()
  for (const row of result) {
    if (!row?.pubkey || !row.account) throw new InvalidAccountError('Program-account scan returned malformed account data.')
    assertAccountProgramOwner(row.account.owner, 'Ticket account scan result')
    const decoded = decodeTicketAccount(decodeAccountData(row.account.data))
    const ticketId = bytesUuid(decoded.ticketId)
    accounts.set(ticketId, row)
  }
  return accounts
}

async function findRegistration(
  rpc: DevnetRpc,
  ticket: TicketRow | null,
  event: EventRow,
  ticketId: string,
  eventPda: PublicKey,
  ticketPda: PublicKey,
  organizer: string,
) {
  const storedSignature = ticket?.solana_registration_signature
    ?? (ticket && ticket.solana_transfer_count === 0 ? ticket.solana_transaction_signature : null)
  if (storedSignature) {
    const tx = await requireFinalizedTransaction(rpc, storedSignature)
    try {
      const initialOwner = assertRegistrationTransaction(tx, storedSignature, event.id, ticketId, eventPda, ticketPda, organizer)
      return { signature: storedSignature, initialOwner, manualReason: null }
    } catch (error) {
      throw new ManualReviewError(error instanceof Error ? error.message : 'Stored registration transaction is invalid.')
    }
  }
  const signatures = await rpc<SignatureInfo[]>('getSignaturesForAddress', [ticketPda.toBase58(), { commitment: 'finalized', limit: 100 }])
  for (const item of signatures) {
    if (item.err) continue
    const tx = await getFinalizedTransactionOrPending(rpc, item.signature)
    if (!tx) continue
    try {
      const initialOwner = assertRegistrationTransaction(tx, item.signature, event.id, ticketId, eventPda, ticketPda, organizer)
      return { signature: item.signature, initialOwner, manualReason: null }
    } catch { /* Other ticket instructions are expected in the same address history. */ }
  }
  return { signature: '', initialOwner: '', manualReason: 'A valid finalized registration transaction could not be established from Devnet history.' }
}

async function verifyTransferHistory(rpc: DevnetRpc, ticketId: string, eventPda: PublicKey, ticketPda: PublicKey, ticket: ReturnType<typeof decodeTicketAccount>, initialOwner: string): Promise<TransferState[]> {
  if (ticket.transferCount > MAX_TRANSFER_HISTORY) throw new ManualReviewError(`Ticket has more than ${MAX_TRANSFER_HISTORY} transfers; full receipt verification requires manual review.`)
  const history: TransferState[] = []
  let previousOwner = initialOwner
  for (let sequence = 0; sequence < ticket.transferCount; sequence += 1) {
    const { receipt, bump } = deriveTransferReceipt(ticketPda, sequence)
    const accountResult = await rpc<RpcContext<AccountInfo>>('getAccountInfo', [receipt.toBase58(), { encoding: 'base64', commitment: 'finalized' }])
    const account = accountResult.value
    if (!account) throw new ManualReviewError(`Finalized transfer receipt ${sequence} is missing.`)
    assertAccountProgramOwner(account.owner, `Transfer receipt ${sequence}`)
    const receiptData = decodeTransferReceipt(decodeAccountData(account.data))
    if (receiptData.ticket !== ticketPda.toBase58() || receiptData.sequence !== sequence || receiptData.bump !== bump) {
      throw new InvalidAccountError(`Transfer receipt ${sequence} does not match its derived PDA and sequence.`)
    }
    if (receiptData.from !== previousOwner) throw new ManualReviewError('Transfer receipt chain contains a discontinuous owner history.')
    const signatures = await rpc<SignatureInfo[]>('getSignaturesForAddress', [receipt.toBase58(), { commitment: 'finalized', limit: 2 }])
    const finalSignatures = signatures.filter(item => item.confirmationStatus === 'finalized' && !item.err)
    if (finalSignatures.length !== 1) {
      if (signatures.some(item => confirmationFinality(item.confirmationStatus) === 'pending')) {
        throw new PendingConfirmationError(`Transfer receipt ${sequence} has not reached finalized commitment.`)
      }
      throw new ManualReviewError(`A unique finalized transaction for transfer receipt ${sequence} could not be established.`)
    }
    const signature = finalSignatures[0].signature
    const tx = await requireFinalizedTransaction(rpc, signature)
    assertTransferTransaction(tx, signature, ticketId, sequence, eventPda.toBase58(), ticketPda.toBase58(), receipt.toBase58(), receiptData.from, receiptData.to)
    history.push({
      sequence,
      receiptAccount: receipt.toBase58(),
      fromWallet: receiptData.from,
      toWallet: receiptData.to,
      signature,
    })
    previousOwner = receiptData.to
  }
  if (previousOwner !== ticket.owner) throw new ManualReviewError('Finalized transfer receipts do not lead to the current ticket owner.')
  return history
}

async function findCheckIn(admin: ReturnType<typeof createClient>, rpc: DevnetRpc, ticket: TicketRow | null, ticketId: string, eventPda: PublicKey, ticketPda: PublicKey, organizer: string) {
  const stored = ticket ? (await readCheckInHistory(admin, ticket.id)) : null
  if (stored) {
    if (stored.organizer_wallet !== organizer || stored.solana_network !== 'devnet') throw new ManualReviewError('Stored check-in history conflicts with the on-chain event organiser.')
    const tx = await requireFinalizedTransaction(rpc, stored.transaction_signature)
    try { assertCheckInTransaction(tx, stored.transaction_signature, ticketId, eventPda.toBase58(), ticketPda.toBase58(), organizer) }
    catch (error) { throw new ManualReviewError(error instanceof Error ? error.message : 'Stored check-in transaction is invalid.') }
    if (tx.blockTime === null) throw new ManualReviewError('Finalized check-in transaction has no block time.')
    return { signature: stored.transaction_signature, blockTime: tx.blockTime, organizer }
  }
  const signatures = await rpc<SignatureInfo[]>('getSignaturesForAddress', [ticketPda.toBase58(), { commitment: 'finalized', limit: 1000 }])
  for (const item of signatures) {
    if (item.err || item.confirmationStatus !== 'finalized') continue
    const tx = await requireFinalizedTransaction(rpc, item.signature)
    try {
      assertCheckInTransaction(tx, item.signature, ticketId, eventPda.toBase58(), ticketPda.toBase58(), organizer)
      if (tx.blockTime === null) throw new ManualReviewError('Finalized check-in transaction has no block time.')
      return { signature: item.signature, blockTime: tx.blockTime, organizer }
    } catch (error) {
      if (error instanceof PendingConfirmationError || error instanceof RpcUnavailableError) throw error
    }
  }
  throw new ManualReviewError('The checked-in account has no independently verifiable finalized check-in instruction.')
}

async function verifyExistingCheckIn(admin: ReturnType<typeof createClient>, rpc: DevnetRpc, ticket: TicketRow | null, ticketId: string, eventPda: PublicKey, ticketPda: PublicKey, organizer: string) {
  if (!ticket) return null
  const stored = await readCheckInHistory(admin, ticket.id)
  if (!stored) return null
  if (stored.organizer_wallet !== organizer || stored.solana_network !== 'devnet') throw new ManualReviewError('Database check-in history conflicts with the current finalized event account.')
  const tx = await requireFinalizedTransaction(rpc, stored.transaction_signature)
  try {
    assertCheckInTransaction(tx, stored.transaction_signature, ticketId, eventPda.toBase58(), ticketPda.toBase58(), organizer)
  } catch (error) {
    throw new ManualReviewError(error instanceof Error ? error.message : 'Database check-in transaction is invalid.')
  }
  return { signature: stored.transaction_signature, blockTime: tx.blockTime, organizer }
}

async function readCheckInHistory(admin: ReturnType<typeof createClient>, ticketId: string): Promise<CheckInRow | null> {
  const { data, error } = await admin.from('ticket_checkin_history')
    .select('ticket_id,organizer_user_id,organizer_wallet,transaction_signature,verified_at,solana_network')
    .eq('ticket_id', ticketId).maybeSingle()
  if (error) throw new Error('Could not read ticket check-in history.')
  return data as CheckInRow | null
}

async function requireFinalizedTransaction(rpc: DevnetRpc, signature: string) {
  const tx = await getFinalizedTransactionOrPending(rpc, signature)
  if (!tx) throw new ManualReviewError('Transaction could not be loaded at finalized commitment.')
  if (!tx.meta || tx.meta.err !== null) throw new ManualReviewError('Transaction did not succeed on Devnet.')
  return tx
}

async function getFinalizedTransactionOrPending(rpc: DevnetRpc, signature: string) {
  const tx = await rpc<FinalizedTransaction | null>('getTransaction', [signature, {
    commitment: 'finalized',
    encoding: 'json',
    maxSupportedTransactionVersion: 1,
  }])
  if (tx) return tx
  const state = await getSignatureState(rpc, signature)
  if (confirmationFinality(state) === 'pending') throw new PendingConfirmationError('Transaction has not reached finalized commitment.')
  if (confirmationFinality(state) !== 'finalized') return null
  return null
}

async function getSignatureState(rpc: DevnetRpc, signature: string) {
  const response = await rpc<{ value: { confirmationStatus: string | null; err: unknown | null } | null }>(
    'getSignatureStatuses', [[signature], { searchTransactionHistory: true }],
  )
  const value = response.value
  if (!value) return 'unknown'
  if (value.err) throw new ManualReviewError('Transaction failed on Devnet.')
  return value.confirmationStatus ?? 'unknown'
}

function toDatabaseState(ticket: TicketRow, transfers: TransferRow[], checkIns: CheckInRow[]): DatabaseTicketState {
  const checkIn = checkIns[0] ?? null
  return {
    status: ticket.status,
    blockchainStatus: ticket.blockchain_status,
    network: ticket.solana_network,
    programId: ticket.solana_program_id,
    ticketAccount: ticket.solana_ticket_account,
    eventAccount: ticket.solana_event_account,
    registrationSignature: ticket.solana_registration_signature,
    walletAddress: ticket.wallet_address,
    ticketValid: ticket.solana_ticket_valid,
    checkedIn: ticket.solana_checked_in,
    transferCount: ticket.solana_transfer_count,
    checkedInAt: ticket.checked_in_at,
    checkedInBy: ticket.checked_in_by,
    checkInSignature: checkIn?.transaction_signature ?? null,
    transferHistory: transfers.map(row => ({
      sequence: row.transfer_sequence,
      receiptAccount: row.solana_receipt_account,
      fromWallet: row.from_wallet,
      toWallet: row.to_wallet,
      signature: row.transaction_signature,
    })),
  }
}

async function storeAudit(admin: ReturnType<typeof createClient>, input: {
  runId: string
  sourceRunId?: string
  eventId: string
  ticketId: string
  actorId: string
  result: ReconciliationResult
  databaseState: Record<string, unknown> | null
  actionTaken?: string
  errorDetails?: string
}) {
  const auditTable = admin.from('solana_reconciliation_audit')
  const upsert = auditTable.upsert.bind(auditTable) as unknown as (
    row: Record<string, unknown>,
    options: { onConflict: string },
  ) => Promise<{ error: { message: string } | null }>
  const { error } = await upsert({
    run_id: input.runId,
    source_run_id: input.sourceRunId ?? null,
    event_id: input.eventId,
    ticket_id: input.ticketId,
    classification: input.result.classification,
    database_state: input.databaseState,
    verified_chain_state: input.result.verifiedChainState,
    action_taken: input.actionTaken ?? input.result.repairAction ?? 'none',
    repair_succeeded: input.result.repairSucceeded,
    auto_repair_safe: input.result.autoRepairSafe,
    reason: input.result.reason,
    transaction_signature: input.result.transactionSignature,
    error_details: input.errorDetails ?? null,
    initiated_by: input.actorId,
  }, { onConflict: 'run_id,ticket_id' })
  if (error) throw new Error('Could not persist reconciliation audit record.')
}

async function rpcCall<T>(
  admin: ReturnType<typeof createClient>,
  functionName: string,
  args: Record<string, unknown>,
) {
  const invoke = admin.rpc.bind(admin) as unknown as (
    name: string,
    parameters: Record<string, unknown>,
  ) => Promise<{ data: T | null; error: { message: string } | null }>
  return invoke(functionName, args)
}

async function assertDevnet(rpc: DevnetRpc) {
  const genesis = await rpc<string>('getGenesisHash', [])
  if (genesis !== DEVNET_GENESIS_HASH) throw new RpcUnavailableError('Configured RPC is not Solana Devnet.')
}

function decodeAccountData(data: [string, string]) {
  if (!Array.isArray(data) || data.length !== 2 || data[1] !== 'base64' || typeof data[0] !== 'string') {
    throw new InvalidAccountError('Devnet returned an unexpected account data encoding.')
  }
  try { return Uint8Array.from(atob(data[0]), character => character.charCodeAt(0)) }
  catch { throw new InvalidAccountError('Devnet account data is not valid base64.') }
}

function normalizeRpcError(error: unknown): Error {
  if (error instanceof Error) return error
  return new RpcUnavailableError('Devnet RPC could not be reached.')
}

async function parseBody(request: Request): Promise<RequestBody> {
  try {
    const body: unknown = await request.json()
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error()
    return body as RequestBody
  } catch {
    throw new Error('Request body must be valid JSON.')
  }
}

function groupBy<T>(rows: T[], keyOf: (row: T) => string) {
  const groups = new Map<string, T[]>()
  for (const row of rows) {
    const key = keyOf(row)
    const group = groups.get(key) ?? []
    group.push(row)
    groups.set(key, group)
  }
  return groups
}

function summarize(results: ReconciliationResult[]) {
  const inSync = results.filter(result => result.classification === 'IN_SYNC').length
  const repaired = results.filter(result => result.repairSucceeded === true).length
  const manualReview = results.filter(result => result.classification === 'REQUIRES_MANUAL_REVIEW').length
  const errors = results.filter(result => result.classification === 'RPC_UNAVAILABLE' || result.classification === 'PENDING_CONFIRMATION').length
  return { inSync, discrepancies: results.length - inSync, repaired, manualReview, errors }
}

function respond(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders })
}
