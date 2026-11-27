import { createClient } from 'npm:@supabase/supabase-js@2'
import { PublicKey } from 'npm:@solana/web3.js@1.98.4'

const PROGRAM_ID = new PublicKey('CrNexJmcsgEnjAUW3fLeMQNP1k8kcSGm1wn8vYKBUwf')
const DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1'
// These discriminators are taken from the bundled Anchor 0.30.1 IDL for this exact deployment.
const CREATE_EVENT = Uint8Array.from([49, 219, 29, 203, 22, 98, 100, 87])
const REGISTER_TICKET = Uint8Array.from([109, 13, 236, 88, 213, 108, 159, 122])
const SYSTEM_PROGRAM = '11111111111111111111111111111111'
const headers = { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info' }

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers })
  if (request.method !== 'POST') return respond({ error: 'Use POST for ticket verification.' }, 405)
  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    const rpcUrl = Deno.env.get('SOLANA_DEVNET_RPC_URL') || 'https://api.devnet.solana.com'
    if (!supabaseUrl || !anonKey || !serviceRoleKey) throw new Error('Server verification is not configured.')
    const authorization = request.headers.get('authorization') || ''
    const token = authorization.replace(/^Bearer\s+/i, '')
    if (!token) return respond({ error: 'Sign in to verify this ticket.' }, 401)
    const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false, autoRefreshToken: false } })
    const { data: auth, error: authError } = await userClient.auth.getUser(token)
    if (authError || !auth.user) return respond({ error: 'Your NODARA session could not be verified. Sign in again.' }, 401)
    const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })

    const body = await request.json() as { eventId?: string; ticketId?: string; ownerWallet?: string; organizerWallet?: string; signature?: string }
    const eventId = body.eventId || ''
    const ticketId = body.ticketId || ''
    const signature = body.signature || ''
    const ownerWallet = body.ownerWallet || ''
    const organizerWallet = body.organizerWallet || ''
    if (!isUuid(eventId) || !isUuid(ticketId) || !/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(signature)) return respond({ error: 'Ticket, event, or transaction signature is invalid.' }, 400)
    const organizer = new PublicKey(organizerWallet)
    const initialOwner = new PublicKey(ownerWallet)

    const { data: ticket, error: ticketError } = await admin.from('tickets')
      .select('id,event_id,status,blockchain_status,solana_network,solana_program_id,solana_ticket_account,solana_event_account,solana_transaction_signature,wallet_address,booking:bookings!inner(status,payment_status),event:events!inner(id,organizer_id,status,solana_network,solana_program_id,solana_event_account)')
      .eq('id', ticketId).eq('event_id', eventId).maybeSingle()
    if (ticketError) throw new Error('Could not load the ticket record for verification.')
    if (!ticket) return respond({ error: 'Ticket was not found.' }, 404)
    const event = ticket.event as { id: string; organizer_id: string; status: string; solana_network: string | null; solana_program_id: string | null; solana_event_account: string | null }
    const booking = ticket.booking as { status: string; payment_status: string }
    if (event.organizer_id !== auth.user.id) return respond({ error: 'Only this event’s organiser can register its tickets.' }, 403)
    if (event.status !== 'published' || ticket.status !== 'issued' || booking.status !== 'confirmed' || !['verified', 'not_required'].includes(booking.payment_status)) {
      return respond({ error: 'Only issued tickets from confirmed, eligible bookings for published events can be registered.' }, 409)
    }
    if (ticket.blockchain_status === 'verified') {
      if (ticket.solana_transaction_signature === signature && ticket.wallet_address === ownerWallet) return respond({ verified: true, idempotent: true })
      return respond({ error: 'This ticket has already been registered on-chain.' }, 409)
    }
    if (ticket.solana_ticket_account || ticket.solana_transaction_signature) return respond({ error: 'This ticket already has a registration record. Contact support before retrying.' }, 409)
    if ((event.solana_network && event.solana_network !== 'devnet') || (event.solana_program_id && event.solana_program_id !== PROGRAM_ID.toBase58())) {
      return respond({ error: 'Event chain metadata does not match the configured Devnet program.' }, 409)
    }

    const rpc = async (method: string, params: unknown[]) => {
      const response = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'nodara-verify', method, params }) })
      if (!response.ok) throw new Error(`Devnet RPC returned HTTP ${response.status}.`)
      const payload = await response.json() as { result?: unknown; error?: { message?: string } }
      if (payload.error || payload.result === undefined) throw new Error(payload.error?.message || 'Devnet RPC did not return a result.')
      return payload.result
    }
    if (await rpc('getGenesisHash', []) !== DEVNET_GENESIS_HASH) return respond({ error: 'The configured RPC is not Solana Devnet.' }, 503)

    const eventBytes = uuidBytes(eventId)
    const ticketBytes = uuidBytes(ticketId)
    const [eventPda] = PublicKey.findProgramAddressSync([new TextEncoder().encode('event'), eventBytes], PROGRAM_ID)
    const [ticketPda] = PublicKey.findProgramAddressSync([new TextEncoder().encode('ticket'), eventPda.toBytes(), ticketBytes], PROGRAM_ID)
    if (event.solana_event_account && event.solana_event_account !== eventPda.toBase58()) return respond({ error: 'Stored event PDA does not match the deployed program seeds.' }, 409)

    const tx = await rpc('getTransaction', [signature, { commitment: 'confirmed', encoding: 'json', maxSupportedTransactionVersion: 0 }]) as TransactionResult | null
    if (!tx || tx.meta?.err) return respond({ error: 'The transaction is missing, unconfirmed, or failed on Devnet.' }, 409)
    const keys = tx.transaction.message.accountKeys.map(key => typeof key === 'string' ? { pubkey: key, signer: false } : key)
    if (!keys.some(key => key.pubkey === organizer.toBase58() && key.signer)) return respond({ error: 'The event organiser wallet did not sign this transaction.' }, 403)
    const programInstructions = tx.transaction.message.instructions.filter(ix => keys[ix.programIdIndex]?.pubkey === PROGRAM_ID.toBase58())
    const registrations = programInstructions.filter(ix => equalPrefix(base58Decode(ix.data), REGISTER_TICKET))
    const creates = programInstructions.filter(ix => equalPrefix(base58Decode(ix.data), CREATE_EVENT))
    if (registrations.length !== 1 || creates.length > 1 || programInstructions.length !== registrations.length + creates.length) return respond({ error: 'Transaction does not contain exactly one valid ticket registration and its optional event initialisation.' }, 409)
    const registerIx = registrations[0]
    const registerData = base58Decode(registerIx.data)
    const registerAccounts = registerIx.accounts.map(index => keys[index]?.pubkey)
    if (registerAccounts.length !== 5 || registerData.length !== 24 || !equalBytes(registerData.slice(8), ticketBytes) || registerAccounts[0] !== organizer.toBase58() || registerAccounts[1] !== eventPda.toBase58() || registerAccounts[2] !== initialOwner.toBase58() || registerAccounts[3] !== ticketPda.toBase58() || registerAccounts[4] !== SYSTEM_PROGRAM) {
      return respond({ error: 'Registration instruction does not match the requested ticket, event, organiser, and owner.' }, 409)
    }
    if (creates.length === 1) {
      const createIx = creates[0]
      const createData = base58Decode(createIx.data)
      const createAccounts = createIx.accounts.map(index => keys[index]?.pubkey)
      if (createAccounts.length !== 3 || createData.length !== 25 || !equalBytes(createData.slice(8, 24), eventBytes) || createData[24] !== 0 || createAccounts[0] !== organizer.toBase58() || createAccounts[1] !== eventPda.toBase58() || createAccounts[2] !== SYSTEM_PROGRAM) {
        return respond({ error: 'Event initialisation instruction does not match the event and organiser.' }, 409)
      }
    }

    const onChainEvent = await rpc('getAccountInfo', [eventPda.toBase58(), { encoding: 'base64', commitment: 'confirmed' }]) as AccountResult
    const onChainTicket = await rpc('getAccountInfo', [ticketPda.toBase58(), { encoding: 'base64', commitment: 'confirmed' }]) as AccountResult
    const decodedEvent = accountData(onChainEvent)
    const decodedTicket = accountData(onChainTicket)
    if (!decodedEvent || !decodedTicket || onChainEvent.value?.owner !== PROGRAM_ID.toBase58() || onChainTicket.value?.owner !== PROGRAM_ID.toBase58()) return respond({ error: 'Devnet ticket or event account is missing or owned by another program.' }, 409)
    if (decodedEvent.length < 58 || decodedTicket.length < 127 || !equalBytes(decodedTicket.slice(0, 8), Uint8Array.from([37, 215, 102, 48, 114, 66, 21, 87])) || !equalBytes(decodedEvent.slice(0, 8), Uint8Array.from([150, 209, 156, 235, 9, 198, 56, 184]))) return respond({ error: 'Devnet account data does not match the deployed Anchor IDL.' }, 409)
    if (!equalBytes(decodedEvent.slice(8, 24), eventBytes) || !equalBytes(decodedEvent.slice(24, 56), organizer.toBytes())) return respond({ error: 'On-chain event identity or organiser does not match.' }, 409)
    if (!equalBytes(decodedTicket.slice(8, 24), ticketBytes) || !equalBytes(decodedTicket.slice(24, 56), eventPda.toBytes()) || !equalBytes(decodedTicket.slice(56, 88), organizer.toBytes()) || !equalBytes(decodedTicket.slice(88, 120), initialOwner.toBytes()) || decodedTicket[120] !== 1 || decodedTicket[121] !== 0) {
      return respond({ error: 'On-chain ticket identity, issuer, owner, or validity does not match.' }, 409)
    }

    const { data: updatedEvent, error: eventUpdateError } = await admin.from('events').update({ solana_network: 'devnet', solana_program_id: PROGRAM_ID.toBase58(), solana_event_account: eventPda.toBase58() })
      .eq('id', eventId).eq('organizer_id', auth.user.id).select('id').maybeSingle()
    if (eventUpdateError || !updatedEvent) return respond({ error: 'Event metadata could not be saved after verification.' }, 500)

    const { data: updatedTicket, error: updateTicketError } = await admin.from('tickets').update({
      solana_network: 'devnet', solana_program_id: PROGRAM_ID.toBase58(), solana_ticket_account: ticketPda.toBase58(),
      solana_event_account: eventPda.toBase58(), solana_transaction_signature: signature,
      solana_registration_signature: signature, wallet_address: initialOwner.toBase58(),
      solana_ticket_valid: true, solana_checked_in: false, solana_transfer_count: 0,
      blockchain_status: 'verified', blockchain_verified_at: new Date().toISOString(),
    }).eq('id', ticketId).eq('event_id', eventId).is('solana_ticket_account', null).select('id').maybeSingle()
    if (updateTicketError || !updatedTicket) {
      const { data: current } = await admin.from('tickets').select('blockchain_status,solana_transaction_signature,wallet_address').eq('id', ticketId).maybeSingle()
      if (current?.blockchain_status === 'verified' && current.solana_transaction_signature === signature && current.wallet_address === initialOwner.toBase58()) return respond({ verified: true, idempotent: true })
      return respond({ error: 'Ticket metadata changed during verification. Refresh before trying again.' }, 409)
    }
    return respond({ verified: true, signature, eventAccount: eventPda.toBase58(), ticketAccount: ticketPda.toBase58() })
  } catch (error) {
    console.error('verify-solana-ticket:', error)
    return respond({ error: error instanceof Error ? error.message : 'Ticket verification failed.' }, 400)
  }
})

type TransactionResult = { meta: { err: unknown | null } | null; transaction: { message: { accountKeys: ({ pubkey: string; signer: boolean } | string)[]; instructions: { programIdIndex: number; accounts: number[]; data: string }[] } } }
type AccountResult = { value: { owner: string; data: [string, string] } | null }
function respond(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers }) }
function isUuid(value: string) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) }
function uuidBytes(value: string) { return Uint8Array.from(value.replaceAll('-', '').match(/.{2}/g)!, byte => Number.parseInt(byte, 16)) }
function accountData(account: AccountResult) { return account.value ? Uint8Array.from(atob(account.value.data[0]), char => char.charCodeAt(0)) : null }
function equalBytes(left: Uint8Array, right: Uint8Array) { return left.length === right.length && left.every((byte, index) => byte === right[index]) }
function equalPrefix(left: Uint8Array, prefix: Uint8Array) { return left.length >= prefix.length && prefix.every((byte, index) => left[index] === byte) }
function base58Decode(value: string) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
  let number = 0n
  for (const char of value) { const digit = alphabet.indexOf(char); if (digit < 0) throw new Error('Transaction includes invalid base58 instruction data.'); number = number * 58n + BigInt(digit) }
  const bytes: number[] = []
  while (number > 0n) { bytes.unshift(Number(number & 255n)); number >>= 8n }
  for (const char of value) { if (char !== '1') break; bytes.unshift(0) }
  return Uint8Array.from(bytes)
}
