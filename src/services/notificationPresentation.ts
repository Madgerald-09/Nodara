export function notificationHref(resourceType: string | null): string {
  if (resourceType === 'booking' || resourceType === 'ticket') return '/my-tickets'
  if (resourceType === 'announcement') return '/'
  return '/account/activity'
}

export function formatNotificationTime(value: string, now = Date.now()): string {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return 'Recently'
  const difference = Math.max(0, now - timestamp)
  if (difference < 60_000) return 'Just now'
  if (difference < 3_600_000) return `${Math.floor(difference / 60_000)}m ago`
  if (difference < 86_400_000) return `${Math.floor(difference / 3_600_000)}h ago`
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(timestamp)
}
