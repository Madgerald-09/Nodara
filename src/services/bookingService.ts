import { supabase } from '../lib/supabase'

export type TicketTypeView = { id: string; name: string; description: string | null; price: number; currency: string; remaining: number | null; max_per_booking: number }
export type BookingResult = { booking_id: string; booking_reference: string; status: 'confirmed' | 'payment_pending'; payment_status: string; total_amount: number; currency: string; expires_at: string | null; ticket_count: number }
export type TicketView = { ticket_id: string; qr_token: string; ticket_status: string; created_at: string; booking_reference: string; booking_status: string; payment_status: string; event_id: string; event_title: string; event_start: string; event_end: string | null; location: string; venue: string | null; cover_image: string | null; ticket_type: string; blockchain_status: string; solana_ticket_account?: string | null; solana_event_account?: string | null; wallet_address?: string | null }
export type TicketTypeAdmin = { id: string; name: string; description: string | null; price: number; currency: string; capacity: number | null; quantity_sold: number; quantity_reserved: number; max_per_booking: number; active: boolean }
export type PaymentInitialization = { authorizationUrl: string; reference: string; amountMinor: number; currency: string; idempotent: boolean }
export type BookingPaymentStatus = {
  booking: { id: string; status: string; paymentStatus: string; amount: number | string; currency: string; expiresAt: string | null }
  payment: { id: string; reference: string | null; amountMinor: number | string; currency: string; status: string; initializationStatus: string; authorizationUrl: string | null; fulfillmentStatus: string; createdAt: string; verifiedAt: string | null; errorCode: string | null } | null
  refunds: { amountMinor: number | string; currency: string; status: string; safeErrorCode: string | null; requestedAt: string; completedAt: string | null; ticketIds: string[] }[]
}
export type RefundRequestResult = { refundId: string; reference: string; amountMinor: number | string; currency: string; status: string; idempotent: boolean; retryable?: boolean }

export async function requestPaystackRefund(paymentId: string, ticketIds: string[], requestKey: string = crypto.randomUUID()) {
  if (!supabase) return { refund: null as RefundRequestResult | null, error: 'Supabase is not configured.', retryable: false }
  const { data, error } = await supabase.functions.invoke<RefundRequestResult>('request-paystack-refund', {
    body: { paymentId, ticketIds, requestKey },
  })
  const status = (error as { context?: { status?: number } } | null)?.context?.status
  return { refund: data ?? null, error: error?.message ?? null, retryable: status === undefined || status >= 500 }
}

export async function getEventTicketTypes(eventId: string) {
  if (!supabase) return { types: [] as TicketTypeView[], error: 'Supabase is not configured.' }
  const { data, error } = await supabase.rpc('get_event_ticket_types', { p_event_id: eventId })
  return { types: (data ?? []) as TicketTypeView[], error: error?.message ?? null }
}

export async function createBooking(eventId: string, items: { ticket_type_id: string; quantity: number }[]) {
  if (!supabase) return { booking: null as BookingResult | null, error: 'Supabase is not configured.' }
  const { data, error } = await supabase.rpc('create_booking', { p_event_id: eventId, p_items: items })
  return { booking: data as BookingResult | null, error: error?.message ?? null }
}

export async function initializePaystackPayment(bookingId: string) {
  if (!supabase) return { payment: null as PaymentInitialization | null, error: 'Supabase is not configured.' }
  const { data, error } = await supabase.functions.invoke<PaymentInitialization>('initialize-paystack-payment', {
    body: { bookingId },
  })
  return { payment: data ?? null, error: error?.message ?? null }
}

export async function getBookingPaymentStatus(bookingId: string) {
  if (!supabase) return { status: null as BookingPaymentStatus | null, error: 'Supabase is not configured.' }
  const { data, error } = await supabase.functions.invoke<BookingPaymentStatus>('get-payment-status', {
    body: { bookingId },
  })
  return { status: data ?? null, error: error?.message ?? null }
}

export async function getMyTickets() {
  if (!supabase) return { tickets: [] as TicketView[], error: 'Supabase is not configured.' }
  const { data, error } = await supabase.rpc('get_my_tickets')
  const tickets = (data ?? []) as TicketView[]
  if (error || !tickets.length) return { tickets, error: error?.message ?? null }
  const metadata = await supabase.from('tickets').select('id,solana_ticket_account,solana_event_account,wallet_address').in('id', tickets.map(ticket => ticket.ticket_id))
  const metadataByTicket = new Map((metadata.data ?? []).map(row => [row.id, row]))
  return { tickets: tickets.map(ticket => {
    const chain = metadataByTicket.get(ticket.ticket_id)
    return { ...ticket, solana_ticket_account: chain?.solana_ticket_account ?? null, solana_event_account: chain?.solana_event_account ?? null, wallet_address: chain?.wallet_address ?? null }
  }), error: metadata.error?.message ?? null }
}

export async function getMyBookings() {
  if (!supabase) return { bookings: [], error: 'Supabase is not configured.' }
  const { data, error } = await supabase.rpc('get_my_bookings')
  return { bookings: data ?? [], error: error?.message ?? null }
}

export async function getEventAttendees(eventId: string) {
  if (!supabase) return { attendees: [], error: 'Supabase is not configured.' }
  const { data, error } = await supabase.rpc('get_event_attendees', { p_event_id: eventId })
  return { attendees: data ?? [], error: error?.message ?? null }
}

export async function getEventAttendeeRefunds(eventId: string) {
  if (!supabase) return { refunds: [] as { ticket_id: string; amount_minor: number | string; currency: string; status: string; requested_at: string; completed_at: string | null; safe_error_code: string | null }[], error: 'Supabase is not configured.' }
  const { data, error } = await supabase.rpc('get_event_attendee_refunds', { p_event_id: eventId })
  return { refunds: data ?? [], error: error?.message ?? null }
}

export async function checkInTicket(eventId: string, code: string) {
  if (!supabase) return { result: null as { result: string; checked_in_at?: string } | null, error: 'Supabase is not configured.' }
  const { data, error } = await supabase.rpc('check_in_ticket', { p_event_id: eventId, p_code: code.trim() })
  return { result: data as { result: string; checked_in_at?: string } | null, error: error?.message ?? null }
}

export async function getTicketChainInfo(eventId: string, code: string) {
  if (!supabase) return { ticket: null, error: 'Supabase is not configured.' }
  const normalized = code.trim().replace(/^NODARA:TICKET:/i, '')
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(normalized)) return { ticket: null, error: null }
  const columns = 'id,qr_token,status,holder_user_id,wallet_address,blockchain_status,solana_ticket_account,solana_event_account'
  const byQr = await supabase.from('tickets').select(columns).eq('event_id', eventId).eq('qr_token', normalized).maybeSingle()
  if (byQr.error) return { ticket: null, error: byQr.error.message }
  if (byQr.data) return { ticket: byQr.data, error: null }
  const byId = await supabase.from('tickets').select(columns).eq('event_id', eventId).eq('id', normalized).maybeSingle()
  return { ticket: byId.data, error: byId.error?.message ?? null }
}

export async function getOrganiserTicketTypes(eventId: string) {
  if (!supabase) return { types: [] as TicketTypeAdmin[], error: 'Supabase is not configured.' }
  const { data, error } = await supabase.from('ticket_types').select('*').eq('event_id', eventId).order('created_at')
  return { types: (data ?? []) as TicketTypeAdmin[], error: error?.message ?? null }
}

export async function saveTicketType(eventId: string, input: { id?: string; name: string; description: string | null; price: number; currency: string; capacity: number | null; max_per_booking: number }) {
  if (!supabase) return { error: 'Supabase is not configured.' }
  const { id, ...values } = input
  const result = id
    ? await supabase.from('ticket_types').update(values).eq('id', id).eq('event_id', eventId)
    : await supabase.from('ticket_types').insert({ ...values, event_id: eventId })
  return { error: result.error?.message ?? null }
}

export async function removeTicketType(eventId: string, ticketTypeId: string) {
  if (!supabase) return { error: 'Supabase is not configured.' }
  const { error } = await supabase.from('ticket_types').delete().eq('id', ticketTypeId).eq('event_id', eventId)
  return { error: error?.message ?? null }
}
