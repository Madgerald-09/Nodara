export type EmailDelivery = {
  delivery_id: string
  notification_id: string
  recipient_id: string
  recipient_email: string
  title: string
  message: string
  resource_type: string | null
  resource_id: string | null
  idempotency_key: string
}

export function escapeHtml(value: string) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

export function safeNotificationUrl(baseUrl: string, resourceType: string | null) {
  let base: URL
  try { base = new URL(baseUrl) } catch { throw new Error('Invalid application URL') }
  if (base.protocol !== 'https:' && base.hostname !== 'localhost') throw new Error('Application URL must use HTTPS')
  const path = resourceType === 'booking' || resourceType === 'ticket' ? '/my-tickets'
    : resourceType === 'announcement' ? '/#communities' : '/account/activity'
  return new URL(path, base).toString()
}

export function isTransientEmailError(status: number) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500
}

export function notificationEmailHtml(title: string, message: string, url: string) {
  const safeTitle = escapeHtml(title)
  const safeMessage = escapeHtml(message)
  const safeUrl = escapeHtml(url)
  return `<!doctype html><html><body style="margin:0;background:#08100d;color:#eff7f2;font-family:Arial,sans-serif"><main style="max-width:560px;margin:32px auto;padding:28px;background:#101a15;border:1px solid #25372d;border-radius:14px"><p style="color:#5bd9a5;letter-spacing:3px;font-size:12px;font-weight:bold">NODARA</p><h1 style="font-size:22px">${safeTitle}</h1><p style="line-height:1.6;color:#c6d2cb">${safeMessage}</p><p><a href="${safeUrl}" style="display:inline-block;padding:12px 18px;background:#42c891;color:#062015;border-radius:8px;text-decoration:none;font-weight:bold">Open NODARA</a></p><p style="font-size:12px;color:#87968d">This account update was generated from a verified NODARA system event. Ticket QR codes and private credentials are not sent by email.</p></main></body></html>`
}

export function safeProviderError(status: number, body: unknown) {
  if (status === 401 || status === 403) return 'EMAIL_PROVIDER_AUTH'
  if (status === 429) return 'EMAIL_PROVIDER_RATE_LIMIT'
  if (status >= 500 || status === 408 || status === 409 || status === 425) return 'EMAIL_PROVIDER_TEMPORARY'
  const code = typeof body === 'object' && body !== null && 'name' in body && typeof body.name === 'string'
    ? body.name.toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 48) : ''
  return code && /^[A-Z]/.test(code) ? `EMAIL_${code}` : 'EMAIL_PROVIDER_REJECTED'
}
