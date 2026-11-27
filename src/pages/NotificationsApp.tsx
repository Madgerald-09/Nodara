import { useCallback, useEffect, useState } from 'react'
import './Notifications.css'
import { supabase } from '../lib/supabase'
import type { NavigateFunction } from './OrganiserApp'
import {
  defaultNotificationPreferences, fetchNotificationPreferences, fetchNotifications, formatNotificationTime, getUnreadNotificationCount,
  markAllNotificationsRead, markNotificationRead, notificationCategories, resolveNotificationHref, saveNotificationPreferences,
} from '../services/notificationService'
import type { NotificationCategory, NotificationPreferences, NotificationRow } from '../services/notificationService'

const labels: Record<NotificationCategory, string> = {
  bookings: 'Bookings', tickets: 'Tickets', payments: 'Payments', refunds: 'Refunds', events: 'Events',
  reminders: 'Reminders', communities: 'Communities', announcements: 'Announcements', organiser_updates: 'Organiser updates',
}

export function NotificationsApp({ navigate }: { navigate: NavigateFunction }) {
  const [items, setItems] = useState<NotificationRow[]>([])
  const [category, setCategory] = useState<NotificationCategory | 'all'>('all')
  const [preferences, setPreferences] = useState<NotificationPreferences>(structuredClone(defaultNotificationPreferences))
  const [showPreferences, setShowPreferences] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [preferencesError, setPreferencesError] = useState('')
  const [userReady, setUserReady] = useState(false)
  const [unreadCount, setUnreadCount] = useState(0)

  const load = useCallback(async (reset = true, offset = 0) => {
    setLoading(true); setError('')
    try {
      const current = await fetchNotifications({ category, offset: reset ? 0 : offset, limit: 20 })
      setItems(previous => reset ? current : [...previous, ...current])
      setHasMore(current.length === 20)
      setUnreadCount(await getUnreadNotificationCount())
    } catch {
      setError('Notifications could not be loaded. Check your connection and try again.')
    } finally { setLoading(false) }
  }, [category])

  useEffect(() => {
    let active = true
    void (async () => {
      if (!supabase) { setError('Supabase is not configured.'); setLoading(false); return }
      const { data, error: authError } = await supabase.auth.getUser()
      if (!active) return
      if (authError || !data.user) { navigate('/'); return }
      setUserReady(true)
      try { setPreferences(await fetchNotificationPreferences()) } catch { if (active) setPreferencesError('Notification preferences could not be loaded.') }
    })()
    return () => { active = false }
  }, [navigate])

  useEffect(() => {
    if (!userReady) return
    const timer = window.setTimeout(() => { void load(true) }, 0)
    return () => window.clearTimeout(timer)
  }, [userReady, load])

  const updateRead = async (item: NotificationRow, read: boolean) => {
    const result = await markNotificationRead(item.id, read)
    if (result.error) { setError('That notification could not be updated.'); return }
    setItems(current => current.map(row => row.id === item.id ? { ...row, read_at: read ? new Date().toISOString() : null } : row))
    setUnreadCount(current => Math.max(0, current + (read ? -1 : 1)))
  }

  const markAllRead = async () => {
    const result = await markAllNotificationsRead()
    if (result.error) { setError('Unread notifications could not be updated.'); return }
    setItems(current => current.map(row => ({ ...row, read_at: row.read_at ?? new Date().toISOString() })))
    setUnreadCount(0)
    setNotice('All notifications are marked as read.')
  }

  const openNotification = async (item: NotificationRow) => {
    try { navigate(await resolveNotificationHref(item)) }
    catch { navigate(item.related_resource_type === 'booking' || item.related_resource_type === 'ticket' ? '/my-tickets' : '/account/activity') }
  }

  const setPreference = (channel: 'in_app_enabled' | 'email_enabled', key: NotificationCategory, value: boolean) => {
    setPreferences(current => ({ ...current, [channel]: { ...current[channel], [key]: value } }))
  }
  const persistPreferences = async () => {
    setSaving(true); setError(''); setNotice('')
    const result = await saveNotificationPreferences(preferences)
    setSaving(false)
    if (result.error) setError('Preferences could not be saved. Please try again.')
    else setNotice('Notification preferences saved.')
  }

  return <main className="notifications-page">
    <header className="notifications-header"><button className="notifications-brand" onClick={() => navigate('/')}>NODARA <span>Discover. Connect. Experience.</span></button><button className="notifications-back" onClick={() => navigate('/')}>Back to discovery</button></header>
    <div className="notifications-content">
      <div className="notifications-title-row"><div><span className="notifications-eyebrow">YOUR ACCOUNT · PRIVATE</span><h1>Notifications<span>.</span></h1><p>Updates about your bookings, tickets, events, and communities.</p></div><button className="notifications-preferences-toggle" onClick={() => setShowPreferences(value => !value)} aria-expanded={showPreferences}>{showPreferences ? 'Hide preferences' : 'Notification preferences'}</button></div>
      {error && <p className="notifications-message error" role="alert">{error}</p>}{notice && <p className="notifications-message success" role="status">{notice}</p>}
      {showPreferences && <section className="notification-preferences" aria-label="Notification preferences"><h2>Choose what reaches you</h2><p>In-app and email settings apply to future notifications. Booking and ticket status remains available in My Tickets.</p>{preferencesError && <p className="notifications-message error" role="alert">{preferencesError}</p>}<div className="notification-preference-head"><span>Category</span><span>In app</span><span>Email</span></div>{notificationCategories.map(key => <div className="notification-preference-row" key={key}><strong>{labels[key]}</strong><label><span className="sr-only">In-app {labels[key]}</span><input type="checkbox" checked={preferences.in_app_enabled[key]} onChange={event => setPreference('in_app_enabled', key, event.target.checked)}/></label><label><span className="sr-only">Email {labels[key]}</span><input type="checkbox" checked={preferences.email_enabled[key]} onChange={event => setPreference('email_enabled', key, event.target.checked)}/></label></div>)}<button className="notifications-primary" disabled={saving} onClick={() => void persistPreferences()}>{saving ? 'Saving…' : 'Save preferences'}</button></section>}
      <div className="notification-list-toolbar"><label>Filter notifications<select value={category} onChange={event => setCategory(event.target.value as NotificationCategory | 'all')}><option value="all">All categories</option>{notificationCategories.map(key => <option value={key} key={key}>{labels[key]}</option>)}</select></label><div><span aria-live="polite">{unreadCount} unread</span><button disabled={!unreadCount} onClick={() => void markAllRead()}>Mark all read</button></div></div>
      {loading && !items.length ? <div className="notifications-state" role="status">Loading your notifications…</div> : error && !items.length ? <div className="notifications-state"><button onClick={() => void load(true)}>Try again</button></div> : items.length ? <div className="notification-list">{items.map(item => <article className={item.read_at ? 'notification-item read' : 'notification-item unread'} key={item.id}><span className="notification-mark" aria-hidden="true">{item.category === 'announcements' || item.category === 'communities' ? '✳' : item.category === 'reminders' ? '◷' : '•'}</span><div className="notification-copy"><div className="notification-item-meta"><span>{labels[item.category]}</span><time dateTime={item.created_at}>{formatNotificationTime(item.created_at)}</time></div><h2>{item.title}</h2><p>{item.message}</p><div className="notification-item-actions"><button className="notification-open-link" onClick={() => void openNotification(item)}>Open details</button><button onClick={() => void updateRead(item, !item.read_at)}>{item.read_at ? 'Mark unread' : 'Mark read'}</button></div></div><span className="notification-unread-dot" aria-label={item.read_at ? 'Read' : 'Unread'}/></article>)}</div> : <div className="notifications-state"><span aria-hidden="true">✳</span><h2>You're all caught up</h2><p>New booking, ticket, event, and community updates will appear here.</p></div>}
      {hasMore && <button className="notifications-load-more" disabled={loading} onClick={() => void load(false, items.length)}>{loading ? 'Loading…' : 'Load more'}</button>}
      <p className="notifications-privacy-note">Notifications are private to your account. Secure ticket credentials and payment provider details are never included here.</p>
    </div>
  </main>
}
