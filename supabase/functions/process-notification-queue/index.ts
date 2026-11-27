import { createClient } from 'npm:@supabase/supabase-js@2'
import { isTransientEmailError, notificationEmailHtml, safeNotificationUrl, safeProviderError, type EmailDelivery } from '../_shared/notification_delivery.ts'

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
}

async function matchesSecret(candidate: string, expected: string) {
  const left = new TextEncoder().encode(candidate)
  const right = new TextEncoder().encode(expected)
  if (left.length !== right.length) return false
  let diff = 0
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i]
  return diff === 0
}

Deno.serve(async request => {
  if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405)
  const workerSecret = Deno.env.get('NOTIFICATION_WORKER_SECRET') ?? ''
  const supplied = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
  if (workerSecret.length < 32 || !(await matchesSecret(supplied, workerSecret))) return json({ error: 'Worker authorization required.' }, 401)

  const url = Deno.env.get('SUPABASE_URL')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !serviceKey) return json({ error: 'Notification worker is not configured.' }, 503)
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data: reminders, error: reminderError } = await admin.rpc('enqueue_due_event_reminders')
  if (reminderError) {
    console.error('Notification reminder enqueue failed', reminderError.code ?? 'database_error')
    return json({ error: 'Reminder work could not be queued.' }, 500)
  }

  const emailEnabled = Deno.env.get('NOTIFICATION_EMAIL_ENABLED') === 'true'
  const emailMode = Deno.env.get('NOTIFICATION_EMAIL_MODE') ?? 'test'
  const apiKey = Deno.env.get('RESEND_API_KEY') ?? ''
  const from = Deno.env.get('NOTIFICATION_FROM_EMAIL') ?? ''
  const appUrl = Deno.env.get('NODARA_APP_URL') ?? ''
  const testRecipient = Deno.env.get('NOTIFICATION_TEST_RECIPIENT') ?? ''
  if (!emailEnabled || !apiKey || !from || !appUrl || !['test', 'live'].includes(emailMode)
    || (emailMode === 'test' && !testRecipient)) {
    return json({ remindersQueued: Number(reminders ?? 0), emailEnabled: false, emailsProcessed: 0 })
  }

  const { data: deliveries, error: claimError } = await admin.rpc('claim_notification_email_batch', { p_limit: 25 })
  if (claimError) {
    console.error('Notification email claim failed', claimError.code ?? 'database_error')
    return json({ error: 'Email work could not be claimed.' }, 500)
  }

  let processed = 0
  for (const delivery of (deliveries ?? []) as EmailDelivery[]) {
    let sent = false
    let retryable = true
    let providerReference: string | null = null
    let errorCode = 'EMAIL_PROVIDER_TEMPORARY'
    try {
      const link = safeNotificationUrl(appUrl, delivery.resource_type)
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        signal: AbortSignal.timeout(12_000),
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', 'Idempotency-Key': delivery.idempotency_key },
        body: JSON.stringify({ from, to: [emailMode === 'test' ? testRecipient : delivery.recipient_email], subject: `NODARA · ${delivery.title}`, html: notificationEmailHtml(delivery.title, delivery.message, link) }),
      })
      const body = await response.json().catch(() => null) as { id?: unknown; name?: unknown } | null
      if (response.ok && typeof body?.id === 'string' && body.id.length <= 200) {
        sent = true; providerReference = body.id
      } else {
        errorCode = response.ok ? 'EMAIL_PROVIDER_RESPONSE' : safeProviderError(response.status, body)
        retryable = response.ok || isTransientEmailError(response.status)
      }
    } catch (error) {
      errorCode = error instanceof DOMException && error.name === 'TimeoutError' ? 'EMAIL_PROVIDER_TIMEOUT' : 'EMAIL_PROVIDER_UNAVAILABLE'
      retryable = true
    }
    const { error: finishError } = await admin.rpc('finish_notification_email_delivery', {
      p_delivery_id: delivery.delivery_id, p_sent: sent, p_retryable: retryable,
      p_provider_reference: providerReference, p_safe_error_code: sent ? null : errorCode,
    })
    if (finishError) {
      console.error('Notification delivery state update failed', finishError.code ?? 'database_error')
      // The processing lease will expire; the provider idempotency key makes a retry safe.
    }
    processed++
  }
  return json({ remindersQueued: Number(reminders ?? 0), emailEnabled: true, emailsProcessed: processed })
})
