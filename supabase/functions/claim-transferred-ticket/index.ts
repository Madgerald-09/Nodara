import { createClient } from 'npm:@supabase/supabase-js@2'
import { PublicKey } from 'npm:@solana/web3.js@1.98.4'

const PROGRAM_ID = new PublicKey('CrNexJmcsgEnjAUW3fLeMQNP1k8kcSGm1wn8vYKBUwf')
const DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1'
const headers = { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info' }

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers })
  if (request.method !== 'POST') return respond({ error: 'Use POST to claim a transferred ticket.' }, 405)
  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    const rpcUrl = Deno.env.get('SOLANA_DEVNET_RPC_URL') || 'https://api.devnet.solana.com'
    if (!supabaseUrl || !anonKey || !serviceRoleKey) throw new Error('Server verification is not configured.')
    const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '')
    if (!token) return respond({ error: 'Sign in to claim this ticket.' }, 401)
    const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false, autoRefreshToken: false } })
    const { data: auth, error: authError } = await userClient.auth.getUser(token)
    if (authError || !auth.user) return respond({ error: 'Your NODARA session could not be verified. Sign in again.' }, 401)
    const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })
    const body = await request.json() as { ticketId?: string; walletAddress?: string; signature?: string }
    const ticketId = body.ticketId || ''
    const walletText = body.walletAddress || ''
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ticketId)) return respond({ error: 'Enter the ticket ID provided by its sender.' }, 400)
    const wallet = new PublicKey(walletText)
    const signature = fromBase64(body.signature || '')
    if (signature.length !== 64) return respond({ error: 'Wallet proof signature is invalid.' }, 400)

    const { data: ticket, error: ticketError } = await admin.from('tickets')
      .select('id,event_id,status,holder_user_id,blockchain_status,solana_network,solana_program_id,solana_ticket_account,solana_event_account,wallet_address')
      .eq('id', ticketId).maybeSingle()
    if (ticketError) throw new Error('Could not load the transferred ticket.')
    if (!ticket) return respond({ error: 'Ticket was not found.' }, 404)
    if (ticket.holder_user_id === auth.user.id && ticket.wallet_address === wallet.toBase58()) return respond({ claimed: true, idempotent: true })
    if (ticket.holder_user_id !== null || ticket.status !== 'issued' || ticket.blockchain_status !== 'verified'
      || ticket.solana_network !== 'devnet' || ticket.solana_program_id !== PROGRAM_ID.toBase58()
      || ticket.wallet_address !== wallet.toBase58() || !ticket.solana_ticket_account || !ticket.solana_event_account) {
      return respond({ error: 'This ticket is not waiting to be claimed by the connected wallet.' }, 409)
    }
    const { data: history, error: historyError } = await admin.from('ticket_transfer_history')
      .select('ticket_id,to_wallet,transaction_signature').eq('ticket_id', ticketId).eq('to_wallet', wallet.toBase58())
      .order('created_at', { ascending: false }).limit(1).maybeSingle()
    if (historyError) throw new Error('Could not verify transfer history.')
    if (!history) return respond({ error: 'No verified transfer to this wallet was found.' }, 409)

    const message = claimMessage(ticketId, wallet.toBase58(), auth.user.id)
    const publicKey = await crypto.subtle.importKey('raw', wallet.toBytes(), { name: 'Ed25519' }, false, ['verify'])
    const validSignature = await crypto.subtle.verify({ name: 'Ed25519' }, publicKey, signature, new TextEncoder().encode(message))
    if (!validSignature) return respond({ error: 'The connected wallet did not sign this ticket claim.' }, 403)

    const rpc = async (method: string, params: unknown[]) => {
      const response = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'nodara-ticket-claim', method, params }) })
      if (!response.ok) throw new Error(`Devnet RPC returned HTTP ${response.status}.`)
      const result = await response.json() as { result?: unknown; error?: { message?: string } }
      if (result.error || result.result === undefined) throw new Error(result.error?.message || 'Devnet RPC did not return a result.')
      return result.result
    }
    if (await rpc('getGenesisHash', []) !== DEVNET_GENESIS_HASH) return respond({ error: 'The configured RPC is not Solana Devnet.' }, 503)
    const eventBytes = uuidBytes(ticket.event_id)
    const ticketBytes = uuidBytes(ticketId)
    const [eventPda] = PublicKey.findProgramAddressSync([new TextEncoder().encode('event'), eventBytes], PROGRAM_ID)
    const [ticketPda] = PublicKey.findProgramAddressSync([new TextEncoder().encode('ticket'), eventPda.toBytes(), ticketBytes], PROGRAM_ID)
    if (ticketPda.toBase58() !== ticket.solana_ticket_account || eventPda.toBase58() !== ticket.solana_event_account) return respond({ error: 'Ticket account metadata does not match the deployed program PDAs.' }, 409)
    const account = await rpc('getAccountInfo', [ticketPda.toBase58(), { encoding: 'base64', commitment: 'confirmed' }]) as AccountResult
    const data = account.value ? Uint8Array.from(atob(account.value.data[0]), char => char.charCodeAt(0)) : null
    if (!data || account.value?.owner !== PROGRAM_ID.toBase58() || data.length < 127
      || !equalBytes(data.slice(0, 8), Uint8Array.from([37, 215, 102, 48, 114, 66, 21, 87]))
      || !equalBytes(data.slice(8, 24), ticketBytes) || !equalBytes(data.slice(24, 56), eventPda.toBytes())
      || !equalBytes(data.slice(88, 120), wallet.toBytes()) || data[120] !== 1 || data[121] !== 0) {
      return respond({ error: 'The current on-chain ticket owner does not match the claiming wallet.' }, 409)
    }

    const { data: claimed, error: claimError } = await admin.rpc('claim_transferred_ticket', {
      p_ticket_id: ticketId, p_user_id: auth.user.id, p_wallet: wallet.toBase58(),
    })
    if (claimError || claimed !== true) return respond({ error: claimError?.message ?? 'Ticket claim was already completed by another account.' }, 409)
    return respond({ claimed: true, ticketId })
  } catch (error) {
    console.error('claim-transferred-ticket:', error)
    return respond({ error: error instanceof Error ? error.message : 'Ticket claim failed.' }, 400)
  }
})

function claimMessage(ticketId: string, wallet: string, userId: string) {
  return `NODARA TRANSFER CLAIM v1\nTicket ID: ${ticketId}\nRecipient wallet: ${wallet}\nNODARA account: ${userId}\n`
}
type AccountResult = { value: { owner: string; data: [string, string] } | null }
function respond(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers }) }
function uuidBytes(value: string) { return Uint8Array.from(value.replaceAll('-', '').match(/.{2}/g)!, byte => Number.parseInt(byte, 16)) }
function equalBytes(a: Uint8Array, b: Uint8Array) { return a.length === b.length && a.every((value, index) => value === b[index]) }
function fromBase64(value: string) { try { return Uint8Array.from(atob(value), char => char.charCodeAt(0)) } catch { return new Uint8Array() } }
