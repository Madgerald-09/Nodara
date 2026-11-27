import { createClient } from 'npm:@supabase/supabase-js@2'
import { PublicKey } from 'npm:@solana/web3.js@1.98.4'
import { assertCheckInAccountState, assertCheckInInstruction, deriveCheckInPdas } from './verification.ts'

const PROGRAM_ID = new PublicKey('CrNexJmcsgEnjAUW3fLeMQNP1k8kcSGm1wn8vYKBUwf')
const DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1'
const headers = { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info' }

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers })
  if (request.method !== 'POST') return respond({ error: 'Use POST for check-in verification.' }, 405)
  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    const rpcUrl = Deno.env.get('SOLANA_DEVNET_RPC_URL') || 'https://api.devnet.solana.com'
    if (!supabaseUrl || !anonKey || !serviceRoleKey) throw new Error('Server check-in verification is not configured.')
    const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '')
    if (!token) return respond({ error: 'Sign in to check in tickets.' }, 401)
    const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false, autoRefreshToken: false } })
    const { data: auth, error: authError } = await userClient.auth.getUser(token)
    if (authError || !auth.user) return respond({ error: 'Your NODARA session could not be verified. Sign in again.' }, 401)
    const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })
    const body = await request.json() as { ticketId?: string; eventId?: string; signature?: string; organizerWallet?: string }
    const ticketId = body.ticketId || ''
    const eventId = body.eventId || ''
    const signature = body.signature || ''
    if (!isUuid(ticketId) || !isUuid(eventId) || !/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(signature)) return respond({ error: 'Ticket, event or transaction signature is invalid.' }, 400)
    const organizer = new PublicKey(body.organizerWallet || '')

    // The organizer must own this Supabase event, in addition to signing with the
    // exact wallet authorized in the Anchor EventRecord.
    const { data: eventRow, error: eventError } = await admin.from('events').select('id,organizer_id').eq('id', eventId).maybeSingle()
    if (eventError) throw new Error('Could not verify the event organiser.')
    if (!eventRow || eventRow.organizer_id !== auth.user.id) return respond({ error: 'You are not the organiser of this event.' }, 403)
    const { data: previousCheckIn, error: previousError } = await admin.from('ticket_checkin_history')
      .select('ticket_id,event_id,organizer_user_id,organizer_wallet,solana_network').eq('transaction_signature', signature).maybeSingle()
    if (previousError) throw new Error('Could not check for duplicate check-in processing.')
    if (previousCheckIn) {
      if (previousCheckIn.ticket_id === ticketId && previousCheckIn.event_id === eventId
        && previousCheckIn.organizer_user_id === auth.user.id && previousCheckIn.organizer_wallet === organizer.toBase58()
        && previousCheckIn.solana_network === 'devnet') return respond({ verified: true, idempotent: true, ticketId, eventId, signature })
      return respond({ error: 'This transaction signature has already been used for another check-in.' }, 409)
    }
    const { data: ticket, error: ticketError } = await admin.from('tickets')
      .select('id,event_id,status,holder_user_id,blockchain_status,solana_network,solana_program_id,solana_ticket_account,solana_event_account,wallet_address')
      .eq('id', ticketId).eq('event_id', eventId).maybeSingle()
    if (ticketError) throw new Error('Could not load the ticket record.')
    if (!ticket) return respond({ error: 'Ticket was not found for this event.' }, 404)
    if (ticket.status === 'checked_in') return respond({ error: 'This ticket is already checked in.' }, 409)
    if (ticket.status !== 'issued' || ticket.blockchain_status !== 'verified' || ticket.solana_network !== 'devnet'
      || ticket.solana_program_id !== PROGRAM_ID.toBase58() || !ticket.wallet_address || !ticket.holder_user_id
      || !ticket.solana_ticket_account || !ticket.solana_event_account) {
      return respond({ error: 'This ticket is not an eligible registered Devnet ticket or has not been claimed by its current holder.' }, 409)
    }

    const rpc = async (method: string, params: unknown[]) => {
      const response = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'nodara-check-in-verify', method, params }) })
      if (!response.ok) throw new Error(`Devnet RPC returned HTTP ${response.status}.`)
      const result = await response.json() as { result?: unknown; error?: { message?: string } }
      if (result.error || result.result === undefined) throw new Error(result.error?.message || 'Devnet RPC did not return a result.')
      return result.result
    }
    if (await rpc('getGenesisHash', []) !== DEVNET_GENESIS_HASH) return respond({ error: 'The configured RPC is not Solana Devnet.' }, 503)
    const { event: eventPda, ticket: ticketPda, eventBytes, ticketBytes } = deriveCheckInPdas(PROGRAM_ID, eventId, ticketId)
    if (eventPda.toBase58() !== ticket.solana_event_account || ticketPda.toBase58() !== ticket.solana_ticket_account) return respond({ error: 'Ticket accounts do not match the deployed program PDA seeds.' }, 409)

    const tx = await rpc('getTransaction', [signature, { commitment: 'finalized', encoding: 'json', maxSupportedTransactionVersion: 1 }]) as TransactionResult | null
    if (!tx || tx.meta?.err) return respond({ error: 'The transaction is missing, not finalized or failed on Devnet.' }, 409)
    try { assertCheckInInstruction(tx.transaction.message, PROGRAM_ID.toBase58(), organizer.toBase58(), eventPda.toBase58(), ticketPda.toBase58(), ticketId) }
    catch (error) {
      const message = error instanceof Error ? error.message : 'Transaction instruction is invalid.'
      return respond({ error: message }, message.includes('organiser wallet') ? 403 : 409)
    }

    const [eventAccount, ticketAccount] = await Promise.all([
      rpc('getAccountInfo', [eventPda.toBase58(), { encoding: 'base64', commitment: 'finalized' }]) as Promise<AccountResult>,
      rpc('getAccountInfo', [ticketPda.toBase58(), { encoding: 'base64', commitment: 'finalized' }]) as Promise<AccountResult>,
    ])
    const eventData = dataBytes(eventAccount)
    const ticketData = dataBytes(ticketAccount)
    try {
      assertCheckInAccountState({
        programId: PROGRAM_ID.toBase58(),
        eventAccountOwner: eventAccount.value?.owner ?? '',
        eventData,
        ticketAccountOwner: ticketAccount.value?.owner ?? '',
        ticketData,
        eventId: eventBytes,
        ticketId: ticketBytes,
        event: eventPda.toBase58(),
        organizer: organizer.toBase58(),
        owner: ticket.wallet_address,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'On-chain account verification failed.'
      return respond({ error: message }, message.includes('organiser wallet') ? 403 : 409)
    }
    if (!ticketData) return respond({ error: 'Devnet ticket account data is unavailable for synchronization.' }, 409)
    const transferCount = new DataView(ticketData.buffer, ticketData.byteOffset + 122, 4).getUint32(0, true)

    const { data: recorded, error: recordError } = await admin.rpc('record_verified_ticket_checkin', {
      p_ticket_id: ticketId, p_event_id: eventId, p_organizer_user_id: auth.user.id,
      p_organizer_wallet: organizer.toBase58(), p_signature: signature, p_program_id: PROGRAM_ID.toBase58(),
      p_ticket_account: ticketPda.toBase58(), p_event_account: eventPda.toBase58(), p_owner_wallet: ticket.wallet_address,
      p_transfer_count: transferCount,
      p_verified_at: tx.blockTime === null ? new Date().toISOString() : new Date(tx.blockTime * 1000).toISOString(),
    })
    if (recordError || !recorded?.recorded) return respond({ error: recordError?.message ?? 'On-chain check-in was verified but database synchronization did not complete.' }, 409)
    return respond({ verified: true, idempotent: recorded.idempotent === true, ticketId, eventId, signature, ticketAccount: ticketPda.toBase58(), eventAccount: eventPda.toBase58() })
  } catch (error) {
    console.error('verify-solana-check-in:', error)
    return respond({ error: error instanceof Error ? error.message : 'Check-in verification failed.' }, 400)
  }
})

type TransactionResult = {
  meta: { err: unknown | null } | null
  blockTime: number | null
  transaction: { message: { accountKeys: ({ pubkey: string; signer: boolean } | string)[]; instructions: { programIdIndex: number; accounts: number[]; data: string }[] } }
}
type AccountResult = { value: { owner: string; data: [string, string] } | null }
function respond(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers }) }
function isUuid(value: string) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) }
function dataBytes(account: AccountResult) { return account.value ? Uint8Array.from(atob(account.value.data[0]), char => char.charCodeAt(0)) : null }
