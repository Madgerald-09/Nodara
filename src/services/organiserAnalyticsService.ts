import { supabase } from '../lib/supabase'

export type CurrencyFinancials = {
  currency: string
  gross_minor: number
  refunded_minor: number
  successful_count: number
  pending_count: number
  failed_count: number
  expired_count: number
  completed_refund_count: number
  pending_refund_count: number
  failed_refund_count: number
  cancelled_refund_count: number
}

export type OrganiserAnalytics = {
  generatedAt: string
  period: { from: string; to: string }
  events: { total: number; published: number; draft: number; cancelled: number; completed: number; upcoming: number; past: number }
  bookings: { total: number; confirmed: number; pending: number; failed: number; cancelled: number; expired: number }
  tickets: { issued: number; validRemaining: number; cancelled: number; checkedIn: number }
  inventory: { capacity: number | null; unlimitedTypes: number; sold: number; reserved: number; available: number | null }
  eventOptions: Array<{ id: string; title: string; status: string; location: string; country: string }>
  financeByCurrency: CurrencyFinancials[]
  financeByEventCurrency: Array<{ event_id: string; title: string; currency: string; gross_minor: number; refunded_minor: number }>
  paymentTrend: Array<{ day: string; currency: string; gross_minor: number; refunded_minor: number }>
  eventsBreakdown: Array<{
    id: string; title: string; status: string; start_date: string; currency: string
    bookings: number; confirmed_bookings: number; pending_bookings: number; failed_bookings: number; issued_tickets: number; checked_in_tickets: number
    capacity: number | null; sold: number; reserved: number
  }>
  ticketTypes: Array<{ id: string; name: string; capacity: number | null; sold: number; reserved: number; issued: number }>
  bookingTrend: Array<{ day: string; confirmed: number; pending: number; cancelled: number }>
  checkinTrend: Array<{ day: string; checked_in: number }>
}

export async function getOrganiserAnalytics(from: string, to: string, eventId?: string) {
  if (!supabase) return { data: null as OrganiserAnalytics | null, error: 'Supabase is not configured.' }
  const { data, error } = await supabase.rpc('get_organiser_analytics', {
    p_from: from,
    p_to: to,
    p_event_id: eventId || null,
  })
  return { data: (data as OrganiserAnalytics | null) ?? null, error: error?.message ?? null }
}
