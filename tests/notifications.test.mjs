import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { formatNotificationTime, notificationHref } from '../src/services/notificationPresentation.ts'
import { escapeHtml, isTransientEmailError, notificationEmailHtml, safeNotificationUrl, safeProviderError } from '../supabase/functions/_shared/notification_delivery.ts'

test('notification links stay within known account routes', () => {
  assert.equal(notificationHref('booking'), '/my-tickets')
  assert.equal(notificationHref('ticket'), '/my-tickets')
  assert.equal(notificationHref('announcement'), '/')
  assert.equal(notificationHref('event'), '/account/activity')
  assert.equal(notificationHref(null), '/account/activity')
})

test('notification timestamps handle invalid values and relative time', () => {
  const now = Date.parse('2026-11-27T12:00:00Z')
  assert.equal(formatNotificationTime('invalid', now), 'Recently')
  assert.equal(formatNotificationTime('2026-11-27T11:59:20Z', now), 'Just now')
  assert.equal(formatNotificationTime('2026-11-27T11:30:00Z', now), '30m ago')
  assert.equal(formatNotificationTime('2026-11-27T09:00:00Z', now), '3h ago')
})

test('email rendering escapes untrusted notification text and uses safe app destinations', () => {
  assert.equal(escapeHtml('<script>&"\''), '&lt;script&gt;&amp;&quot;&#39;')
  const html = notificationEmailHtml('<Hello>', 'This & that', 'https://nodara.example/my-tickets')
  assert.match(html, /&lt;Hello&gt;/)
  assert.match(html, /This &amp; that/)
  assert.doesNotMatch(html, /<script>/)
  assert.equal(safeNotificationUrl('https://nodara.example', 'booking'), 'https://nodara.example/my-tickets')
  assert.equal(safeNotificationUrl('https://nodara.example', 'announcement'), 'https://nodara.example/#communities')
  assert.throws(() => safeNotificationUrl('javascript:alert(1)', 'event'))
  assert.throws(() => safeNotificationUrl('http://nodara.example', 'event'))
})

test('email retry decisions separate temporary and permanent provider failures', () => {
  assert.equal(isTransientEmailError(429), true)
  assert.equal(isTransientEmailError(503), true)
  assert.equal(isTransientEmailError(422), false)
  assert.equal(safeProviderError(401, null), 'EMAIL_PROVIDER_AUTH')
  assert.equal(safeProviderError(503, null), 'EMAIL_PROVIDER_TEMPORARY')
  assert.equal(safeProviderError(422, { name: 'invalid_recipient' }), 'EMAIL_INVALID_RECIPIENT')
})

test('notification migration wires only trusted lifecycle transitions and protects worker RPCs', async () => {
  const sql = await readFile(new URL('../supabase/migrations/202611270012_notifications.sql', import.meta.url), 'utf8')
  for (const expected of [
    'bookings_notify_state_change', 'tickets_notify_issued', 'tickets_notify_owner_or_status',
    'payments_notify_state_change', 'payment_refunds_notify_state_change', 'events_notify_change',
    'community_announcements_notify_publish', 'notification_deliveries_unique_channel',
    'for update skip locked', "auth.role() is distinct from 'service_role'",
    'revoke all on public.notification_preferences,public.notifications,public.notification_deliveries from public,anon,authenticated',
  ]) assert.ok(sql.toLowerCase().includes(expected.toLowerCase()), `missing migration safeguard: ${expected}`)
  assert.match(sql, /create policy notifications_read_own[\s\S]*recipient_id=\(select auth\.uid\(\)\)/i)
  assert.match(sql, /grant update\(read_at\) on public\.notifications to authenticated/i)
  assert.match(sql, /idempotency_key text not null unique/i)
})
