const ownRows = (rows, userId, field = 'user_id') => (rows ?? []).filter(row => row?.[field] === userId)
const pick = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]))
const safePrivacyPreferences = value => value && typeof value === 'object' && !Array.isArray(value) ? {
  useInterestsForRecommendations: typeof value.useInterestsForRecommendations === 'boolean' ? value.useInterestsForRecommendations : undefined,
  useLocationForNearbyDiscovery: typeof value.useLocationForNearbyDiscovery === 'boolean' ? value.useLocationForNearbyDiscovery : undefined,
} : null

export function buildPersonalExport(userId, data, exportedAt = new Date().toISOString()) {
  const savedEvents = ownRows(data.savedEvents, userId).map(row => ({
    eventId: row.event_id,
    savedAt: row.created_at,
    event: row.event?.status === 'published'
      ? pick(row.event, ['id', 'title', 'slug', 'category', 'location', 'country', 'start_date', 'cover_image'])
      : null,
  }))
  const ticketRows = (data.tickets ?? []).filter(row => row?.user_id === userId || row?.holder_user_id === userId)
  const collectionRows = ownRows(data.collections, userId)
  const collectionIds = new Set(collectionRows.map(row => row.id))
  return {
    exportedAt,
    account: { email: data.email ?? null, profile: data.profile ?? null },
    preferences: { profilePrivacyPreferences: safePrivacyPreferences(data.profilePrivacyPreferences) },
    savedEvents,
    collections: {
      collections: collectionRows.map(row => pick(row, ['id', 'name', 'created_at', 'updated_at'])),
      items: (data.collectionItems ?? []).filter(row => collectionIds.has(row?.collection_id)).map(row => pick(row, ['collection_id', 'event_id', 'created_at'])),
    },
    bookings: ownRows(data.bookings, userId).map(row => pick(row, ['id', 'booking_reference', 'event_id', 'quantity', 'total_amount', 'currency', 'status', 'payment_status', 'created_at', 'expires_at'])),
    tickets: ticketRows.map(row => ({
      ...pick(row, ['id', 'booking_id', 'event_id', 'ticket_type_id', 'status', 'checked_in_at', 'created_at', 'blockchain_status']),
      currentUserIsHolder: row.holder_user_id === userId,
    })),
    communityMemberships: ownRows(data.memberships, userId).map(row => ({
      communityId: row.community_id, role: row.role, joinedAt: row.joined_at,
      community: row.community ? pick(row.community, ['id', 'name', 'slug', 'category', 'location']) : null,
    })),
    privateReports: ownRows(data.reports, userId, 'reporter_id').map(row => pick(row, ['id', 'target_type', 'target_id', 'community_id', 'reason', 'description', 'status', 'created_at', 'updated_at'])),
    accountDeletionRequests: ownRows(data.deletionRequests, userId).map(row => pick(row, ['id', 'status', 'requested_at', 'updated_at', 'cancelled_at', 'completed_at'])),
    warnings: data.warnings ?? [],
    exclusions: ['QR tokens', 'wallet addresses and transaction signatures', 'payment provider references and metadata', 'internal moderation notes', 'other users’ records'],
  }
}
