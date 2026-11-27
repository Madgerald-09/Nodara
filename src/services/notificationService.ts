import { supabase } from '../lib/supabase'
import { notificationHref } from './notificationPresentation'

export const notificationCategories = [
  'bookings', 'tickets', 'payments', 'refunds', 'events', 'reminders', 'communities', 'announcements', 'organiser_updates',
] as const
export type NotificationCategory = typeof notificationCategories[number]
export type NotificationRow = {
  id: string
  category: NotificationCategory
  notification_type: string
  title: string
  message: string
  related_resource_type: 'event' | 'booking' | 'ticket' | 'announcement' | null
  related_resource_id: string | null
  created_at: string
  expires_at: string | null
  read_at: string | null
}
export type NotificationPreferences = { in_app_enabled: Record<NotificationCategory, boolean>; email_enabled: Record<NotificationCategory, boolean> }

export const defaultNotificationPreferences: NotificationPreferences = {
  in_app_enabled: Object.fromEntries(notificationCategories.map(category => [category, true])) as Record<NotificationCategory, boolean>,
  email_enabled: Object.fromEntries(notificationCategories.map(category => [category, true])) as Record<NotificationCategory, boolean>,
}

export { notificationHref, formatNotificationTime } from './notificationPresentation'

export async function resolveNotificationHref(notification: Pick<NotificationRow, 'related_resource_type' | 'related_resource_id'>): Promise<string> {
  if (!supabase || !notification.related_resource_id) return '/account/activity'
  if (notification.related_resource_type === 'event') {
    const { data } = await supabase.from('events').select('slug').eq('id', notification.related_resource_id).maybeSingle()
    return data?.slug ? `/events/${encodeURIComponent(data.slug)}` : '/account/activity'
  }
  if (notification.related_resource_type === 'announcement') {
    const { data } = await supabase.from('community_announcements').select('community_id')
      .eq('id', notification.related_resource_id).maybeSingle()
    if (!data?.community_id) return '/'
    const { data: community } = await supabase.from('communities').select('slug').eq('id', data.community_id).maybeSingle()
    return community?.slug ? `/communities/${encodeURIComponent(community.slug)}/announcements/${encodeURIComponent(notification.related_resource_id)}` : '/'
  }
  return notificationHref(notification.related_resource_type)
}

function missingConfig() { return new Error('Supabase is not configured.') }

export async function getUnreadNotificationCount(): Promise<number> {
  if (!supabase) return 0
  const { count, error } = await supabase.from('notifications').select('id', { count: 'exact', head: true }).is('read_at', null)
  if (error) throw error
  return count ?? 0
}

export async function fetchNotifications(input: { category?: NotificationCategory | 'all'; offset: number; limit?: number }) {
  if (!supabase) throw missingConfig()
  const limit = Math.max(1, Math.min(input.limit ?? 20, 50))
  let query = supabase.from('notifications')
    .select('id,category,notification_type,title,message,related_resource_type,related_resource_id,created_at,expires_at,read_at')
    .order('created_at', { ascending: false }).order('id', { ascending: false })
    .range(Math.max(0, input.offset), Math.max(0, input.offset) + limit - 1)
  if (input.category && input.category !== 'all') query = query.eq('category', input.category)
  const { data, error } = await query
  if (error) throw error
  return (data ?? []) as NotificationRow[]
}

export async function markNotificationRead(notificationId: string, read: boolean) {
  if (!supabase) return { error: missingConfig() }
  if (!/^[0-9a-f-]{36}$/i.test(notificationId)) return { error: new Error('This notification could not be updated.') }
  const { data, error } = await supabase.from('notifications').update({ read_at: read ? new Date().toISOString() : null })
    .eq('id', notificationId).select('id').maybeSingle()
  return { error: error ?? (data ? null : new Error('This notification was not available to your account.')) }
}

export async function markAllNotificationsRead() {
  if (!supabase) return { error: missingConfig() }
  const { error } = await supabase.from('notifications').update({ read_at: new Date().toISOString() }).is('read_at', null)
  return { error }
}

export async function fetchNotificationPreferences(): Promise<NotificationPreferences> {
  if (!supabase) throw missingConfig()
  const { data: auth, error: authError } = await supabase.auth.getUser()
  if (authError || !auth.user) throw authError ?? new Error('Sign in to manage notification preferences.')
  const { data, error } = await supabase.from('notification_preferences').select('in_app_enabled,email_enabled').eq('user_id', auth.user.id).maybeSingle()
  if (error) throw error
  if (!data) return structuredClone(defaultNotificationPreferences)
  return {
    in_app_enabled: { ...defaultNotificationPreferences.in_app_enabled, ...(data.in_app_enabled as Partial<NotificationPreferences['in_app_enabled']>) },
    email_enabled: { ...defaultNotificationPreferences.email_enabled, ...(data.email_enabled as Partial<NotificationPreferences['email_enabled']>) },
  }
}

export async function saveNotificationPreferences(preferences: NotificationPreferences) {
  if (!supabase) return { error: missingConfig() }
  for (const category of notificationCategories) {
    if (typeof preferences.in_app_enabled[category] !== 'boolean' || typeof preferences.email_enabled[category] !== 'boolean') {
      return { error: new Error('Choose a valid setting for every notification type.') }
    }
  }
  const { error } = await supabase.rpc('set_notification_preferences', {
    p_in_app: preferences.in_app_enabled,
    p_email: preferences.email_enabled,
  })
  return { error }
}

