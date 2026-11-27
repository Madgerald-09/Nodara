import type { BookingPaymentStatus, TicketView } from './bookingService'
import type { SavedExperience } from './personalCollectionsService'

export type PersonalBooking = {
  id: string
  booking_reference: string
  status: string
  payment_status: string
  total_amount: number | string
  currency: string
  expires_at: string | null
  created_at: string
  event_id: string
  event_title: string
  event_start: string
  event_location: string
  event_cover_image: string | null
  quantity?: number
}

export type PersonalMembership = {
  community_id: string
  role: string
  joined_at: string
  community: { id: string; name: string; slug: string; category: string; location: string | null; cover_image: string | null }
}

export type PersonalTicketCheckin = { ticket_id: string; verified_at: string }
export type PersonalTicketMetadata = { id: string; user_id: string; status: string; checked_in_at: string | null; created_at: string }

export type PersonalActivityItem = {
  id: string
  kind: 'saved' | 'booking' | 'ticket' | 'checkin' | 'community'
  occurredAt: string
  title: string
  detail: string
  href?: string
}

export function isConfirmedPersonalBooking(booking: Pick<PersonalBooking, 'status' | 'payment_status'>) {
  return booking.status === 'confirmed'
    && (booking.payment_status === 'not_required' || booking.payment_status === 'verified')
}

export function getPersonalBookingState(booking: PersonalBooking, payment: BookingPaymentStatus | null) {
  if (payment) {
    const status = payment.payment?.status
    if (status === 'refunded' || payment.booking.paymentStatus === 'refunded') return 'refunded'
    if (status === 'partially_refunded') return 'partially_refunded'
    if (payment.payment?.fulfillmentStatus === 'manual_review') return 'manual_review'
    if (payment.booking.status === 'expired' || status === 'expired' || booking.status === 'expired') return 'expired'
    if (payment.booking.status === 'cancelled' || booking.status === 'cancelled') return 'cancelled'
    if (status === 'failed' || payment.booking.paymentStatus === 'failed') return 'failed'
    if (isConfirmedPersonalBooking({ status: payment.booking.status, payment_status: payment.booking.paymentStatus })) return 'confirmed'
    if (status === 'pending' || payment.booking.status === 'payment_pending') return 'awaiting_payment'
    return 'processing'
  }
  if (booking.status === 'confirmed' && booking.payment_status === 'not_required') return 'confirmed'
  if (booking.status === 'confirmed' && booking.payment_status === 'verified') return 'processing'
  if (booking.status === 'payment_pending') return 'awaiting_payment'
  if (booking.status === 'expired') return 'expired'
  if (booking.status === 'cancelled') return 'cancelled'
  if (booking.payment_status === 'failed') return 'failed'
  return 'processing'
}

export function buildPersonalActivityTimeline(input: {
  userId: string
  savedEvents: SavedExperience[]
  bookings: PersonalBooking[]
  tickets: TicketView[]
  ticketMetadata: PersonalTicketMetadata[]
  checkins: PersonalTicketCheckin[]
  memberships: PersonalMembership[]
}, limit = 12): PersonalActivityItem[] {
  const timeline: PersonalActivityItem[] = []
  for (const saved of input.savedEvents) {
    timeline.push({ id: `saved:${saved.event.id}`, kind: 'saved', occurredAt: saved.savedAt,
      title: 'Saved an experience', detail: saved.event.title, href: `/events/${saved.event.slug}` })
  }
  for (const booking of input.bookings) {
    timeline.push({ id: `booking:${booking.id}`, kind: 'booking', occurredAt: booking.created_at,
      title: 'Created a booking', detail: booking.event_title || 'Experience booking', href: '/my-tickets' })
  }
  const metadata = new Map(input.ticketMetadata.map(ticket => [ticket.id, ticket]))
  for (const ticket of input.tickets) {
    const ticketMeta = metadata.get(ticket.ticket_id)
    // A ticket issued to a different account can later be transferred here. Its
    // original issue date is not activity performed by this user.
    if (ticketMeta?.user_id === input.userId) {
      timeline.push({ id: `ticket:${ticket.ticket_id}`, kind: 'ticket', occurredAt: ticket.created_at,
        title: 'Ticket issued', detail: `${ticket.ticket_type} · ${ticket.event_title}`, href: '/my-tickets' })
    }
    if (ticket.ticket_status === 'checked_in') {
      const chainCheckin = input.checkins.find(item => item.ticket_id === ticket.ticket_id)
      const checkedInAt = chainCheckin?.verified_at ?? ticketMeta?.checked_in_at
      if (checkedInAt) timeline.push({ id: `checkin:${ticket.ticket_id}`, kind: 'checkin', occurredAt: checkedInAt,
        title: 'Experience check-in completed', detail: ticket.event_title, href: '/my-tickets' })
    }
  }
  for (const membership of input.memberships) {
    timeline.push({ id: `community:${membership.community_id}`, kind: 'community', occurredAt: membership.joined_at,
      title: 'Joined a community', detail: membership.community.name })
  }
  return timeline.filter(item => Number.isFinite(Date.parse(item.occurredAt)))
    .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))
    .slice(0, Math.max(0, limit))
}

export function getPersonalActivityCounts(input: {
  bookings: PersonalBooking[]
  currentTicketBookingReferences?: string[]
  savedCount: number
  collectionCount: number
  ticketCount: number
  communityCount: number
}, now = Date.now()) {
  const currentTicketBookings = input.currentTicketBookingReferences
    ? new Set(input.currentTicketBookingReferences)
    : null
  const confirmed = input.bookings.filter(booking => isConfirmedPersonalBooking(booking)
    && (!currentTicketBookings || currentTicketBookings.has(booking.booking_reference)))
  return {
    upcoming: confirmed.filter(booking => Date.parse(booking.event_start) >= now).length,
    past: confirmed.filter(booking => Date.parse(booking.event_start) < now).length,
    pending: input.bookings.filter(booking => booking.status === 'payment_pending').length,
    saved: input.savedCount,
    collections: input.collectionCount,
    tickets: input.ticketCount,
    communities: input.communityCount,
  }
}

