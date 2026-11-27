import { supabase } from '../lib/supabase'
import { fetchOwnProfile } from './accountProfileService'
import { getMyBookings, getMyTickets } from './bookingService'
import type { TicketView } from './bookingService'
import { fetchOwnSavedExperiences, fetchPersonalCollections } from './personalCollectionsService'
import type { PersonalBooking, PersonalMembership, PersonalTicketCheckin, PersonalTicketMetadata } from './personalActivity'

export type PersonalActivityDashboardData = {
  userId: string
  displayName: string
  bookings: PersonalBooking[]
  bookingQuantities: Record<string, number>
  tickets: TicketView[]
  ticketMetadata: PersonalTicketMetadata[]
  checkins: PersonalTicketCheckin[]
  savedEvents: Awaited<ReturnType<typeof fetchOwnSavedExperiences>>['experiences']
  unavailableSavedCount: number
  collections: Awaited<ReturnType<typeof fetchPersonalCollections>>['collections']
  memberships: PersonalMembership[]
  warnings: string[]
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : 'This part of your activity could not be loaded.'
}

export async function loadPersonalActivityDashboard() {
  if (!supabase) return { data: null as PersonalActivityDashboardData | null, signedIn: false, error: new Error('Supabase is not configured.') }
  const { data: authData, error: authError } = await supabase.auth.getUser()
  if (authError) return { data: null, signedIn: false, error: authError }
  const user = authData.user
  if (!user) return { data: null, signedIn: false, error: null }

  const warnings: string[] = []
  const [profileResult, savedResult, collectionResult, bookingsResult, ticketsResult, membershipResult] = await Promise.all([
    fetchOwnProfile(), fetchOwnSavedExperiences(), fetchPersonalCollections(), getMyBookings(), getMyTickets(),
    supabase.from('community_members').select('community_id,role,joined_at')
      .eq('user_id', user.id).order('joined_at', { ascending: false }).limit(100),
  ])

  const bookings = (bookingsResult.bookings ?? []) as PersonalBooking[]
  const tickets = ticketsResult.tickets
  if (profileResult.error) warnings.push(`Profile summary: ${errorText(profileResult.error)}`)
  if (savedResult.error) warnings.push(`Saved events: ${errorText(savedResult.error)}`)
  if (collectionResult.error) warnings.push('Personal collections are unavailable. Check that the private collections database setup is installed.')
  if (bookingsResult.error) warnings.push(`Booking history: ${bookingsResult.error}`)
  if (ticketsResult.error) warnings.push(`Ticket information: ${ticketsResult.error}`)
  if (membershipResult.error) warnings.push(`Community memberships: ${membershipResult.error.message}`)

  const bookingIds = bookings.map(booking => booking.id)
  const ticketIds = tickets.map(ticket => ticket.ticket_id)
  const [itemResult, ticketMetaResult, checkinResult, communitiesResult] = await Promise.all([
    bookingIds.length
      ? supabase.from('booking_items').select('booking_id,quantity').in('booking_id', bookingIds).limit(1000)
      : Promise.resolve({ data: [], error: null }),
    ticketIds.length
      ? supabase.from('tickets').select('id,user_id,status,checked_in_at,created_at')
        .eq('holder_user_id', user.id).in('id', ticketIds).limit(500)
      : Promise.resolve({ data: [], error: null }),
    ticketIds.length
      ? supabase.from('ticket_checkin_history').select('ticket_id,verified_at')
        .in('ticket_id', ticketIds).order('verified_at', { ascending: false }).limit(500)
      : Promise.resolve({ data: [], error: null }),
    membershipResult.data?.length
      ? supabase.from('communities').select('id,name,slug,category,location,cover_image')
        .in('id', membershipResult.data.map(row => row.community_id)).limit(100)
      : Promise.resolve({ data: [], error: null }),
  ])

  if (itemResult.error) warnings.push(`Booking quantities: ${itemResult.error.message}`)
  if (ticketMetaResult.error) warnings.push(`Ticket history details: ${ticketMetaResult.error.message}`)
  if (checkinResult.error) warnings.push(`Check-in history: ${checkinResult.error.message}`)
  if (communitiesResult.error) warnings.push(`Community details: ${communitiesResult.error.message}`)

  const bookingQuantities: Record<string, number> = {}
  for (const row of itemResult.data ?? []) bookingQuantities[row.booking_id] = (bookingQuantities[row.booking_id] ?? 0) + row.quantity
  const communities = new Map((communitiesResult.data ?? []).map(community => [community.id, community]))
  const memberships: PersonalMembership[] = (membershipResult.data ?? []).flatMap(row => {
    const community = communities.get(row.community_id)
    return community ? [{ community_id: row.community_id, role: row.role, joined_at: row.joined_at, community }] : []
  })

  const metadataName = user.user_metadata?.full_name
  return {
    data: {
      userId: user.id,
      displayName: profileResult.profile?.full_name?.trim()
        || (typeof metadataName === 'string' ? metadataName.trim() : '') || 'Your activity',
      bookings,
      bookingQuantities,
      tickets,
      ticketMetadata: (ticketMetaResult.data ?? []) as PersonalTicketMetadata[],
      checkins: (checkinResult.data ?? []) as PersonalTicketCheckin[],
      savedEvents: savedResult.experiences,
      unavailableSavedCount: savedResult.unavailableCount,
      collections: collectionResult.collections,
      memberships,
      warnings,
    } satisfies PersonalActivityDashboardData,
    signedIn: true,
    error: null,
  }
}
