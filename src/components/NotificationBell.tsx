import { useEffect, useState } from 'react'
import { getUnreadNotificationCount } from '../services/notificationService'

export function NotificationBell({ userId, onOpen }: { userId: string; onOpen: () => void }) {
  const [unread, setUnread] = useState(0)
  useEffect(() => {
    let active = true
    const refresh = async () => { try { const count = await getUnreadNotificationCount(); if (active) setUnread(count) } catch { if (active) setUnread(0) } }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 60_000)
    return () => { active = false; window.clearInterval(timer) }
  }, [userId])
  return <button className="notification-bell" onClick={onOpen} aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}>
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/></svg>
    <span>Notifications</span>{unread > 0 && <span className="notification-bell-count" aria-hidden="true">{unread > 99 ? '99+' : unread}</span>}
  </button>
}
