export const PAYSTACK_API = 'https://api.paystack.co'

// Paystack's documented currencies use a factor of 100 for API amounts.
// XOF does not support fractional major units, so that rule is enforced below.
export const PAYSTACK_CURRENCY_EXPONENT: Readonly<Record<string, number>> = {
  NGN: 2,
  USD: 2,
  GHS: 2,
  ZAR: 2,
  KES: 2,
  XOF: 2,
}

export type BookingForPayment = {
  id: string
  user_id: string
  booking_reference: string
  status: string
  payment_status: string
  total_amount: string | number
  currency: string
  expires_at: string | null
}

export type PendingPayment = {
  id: string
  internal_reference: string
  provider_reference: string | null
  amount_minor: number | string
  currency: string
  status: string
  initialization_status: 'pending' | 'initialized' | 'failed' | 'unknown'
  checkout_url: string | null
}

export type PaystackTransaction = {
  id: number | string
  domain: string
  status: string
  reference: string
  amount: number
  currency: string
  fees?: number | null
  channel?: string | null
  paid_at?: string | null
  customer?: { email?: string | null } | null
}

export type VerifiedAmounts = {
  transactionId: string
  amountMinor: number
  currency: string
  providerFeeMinor: number | null
  netAmountMinor: number | null
}

export class PaymentFlowError extends Error {
  readonly httpStatus: number
  readonly errorCode: string

  constructor(httpStatus: number, errorCode: string, message: string) {
    super(message)
    this.httpStatus = httpStatus
    this.errorCode = errorCode
    this.name = 'PaymentFlowError'
  }
}

export function amountToMinorUnits(value: string | number, currency: string): number {
  const exponent = PAYSTACK_CURRENCY_EXPONENT[currency]
  if (exponent === undefined) throw new PaymentFlowError(422, 'UNSUPPORTED_CURRENCY', 'This ticket currency is not enabled for Paystack.')
  const amount = typeof value === 'number' ? String(value) : value.trim()
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(amount)
  if (!match) throw new PaymentFlowError(422, 'INVALID_BOOKING_AMOUNT', 'The booking amount is invalid for payment.')
  const fraction = (match[2] ?? '').padEnd(exponent, '0')
  if (currency === 'XOF' && fraction !== '00') {
    throw new PaymentFlowError(422, 'INVALID_CURRENCY_PRECISION', 'XOF ticket prices must be whole amounts.')
  }
  const major = BigInt(match[1])
  const minor = major * BigInt(10 ** exponent) + BigInt(fraction || '0')
  if (minor <= 0n || minor > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new PaymentFlowError(422, 'INVALID_BOOKING_AMOUNT', 'The booking amount is outside Paystack limits.')
  }
  return Number(minor)
}

export function validateBookingForInitialization(
  booking: BookingForPayment | null,
  userId: string,
  nowMs = Date.now(),
): number {
  if (!booking) throw new PaymentFlowError(404, 'BOOKING_NOT_FOUND', 'Booking was not found.')
  if (booking.user_id !== userId) throw new PaymentFlowError(403, 'BOOKING_ACCESS_DENIED', 'You cannot initialize payment for this booking.')
  if (booking.status !== 'payment_pending' || booking.payment_status !== 'pending') {
    throw new PaymentFlowError(409, 'BOOKING_NOT_PAYABLE', 'This booking is no longer awaiting payment.')
  }
  const expires = booking.expires_at ? Date.parse(booking.expires_at) : Number.NaN
  if (!Number.isFinite(expires) || expires <= nowMs) {
    throw new PaymentFlowError(409, 'BOOKING_EXPIRED', 'This ticket reservation has expired.')
  }
  return amountToMinorUnits(booking.total_amount, booking.currency)
}

export function getReusableCheckout(payment: PendingPayment | null): {
  authorizationUrl: string
  reference: string
  amountMinor: number
  currency: string
} | null {
  if (!payment || payment.status !== 'pending' || payment.initialization_status !== 'initialized' || !payment.checkout_url) return null
  return {
    authorizationUrl: payment.checkout_url,
    reference: payment.provider_reference ?? payment.internal_reference,
    amountMinor: Number(payment.amount_minor),
    currency: payment.currency,
  }
}

export function isSafePaystackCheckoutUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === 'checkout.paystack.com' && url.username === '' && url.password === ''
  } catch {
    return false
  }
}

export function validateSuccessfulTransaction(
  transaction: PaystackTransaction,
  payment: Pick<PendingPayment, 'provider_reference' | 'internal_reference' | 'amount_minor' | 'currency'>,
): VerifiedAmounts {
  if (!transaction || transaction.status !== 'success') {
    throw new PaymentFlowError(409, 'PROVIDER_NOT_SUCCESSFUL', 'Paystack has not confirmed a successful payment.')
  }
  return validateTransactionIdentity(transaction, payment)
}

export function validateTransactionIdentity(
  transaction: PaystackTransaction,
  payment: Pick<PendingPayment, 'provider_reference' | 'internal_reference' | 'amount_minor' | 'currency'>,
): VerifiedAmounts {
  // The server is deliberately pinned to Paystack test credentials. Also
  // verify the domain returned for the transaction so a live transaction can
  // never be accepted by a test deployment (or vice versa).
  if (transaction?.domain !== 'test') {
    throw new PaymentFlowError(422, 'TRANSACTION_DOMAIN_MISMATCH', 'Paystack transaction is not from the test environment.')
  }
  const reference = payment.provider_reference ?? payment.internal_reference
  if (transaction.reference !== reference) {
    throw new PaymentFlowError(422, 'REFERENCE_MISMATCH', 'Paystack transaction reference does not match the payment.')
  }
  if (!Number.isSafeInteger(transaction.amount) || transaction.amount !== Number(payment.amount_minor)) {
    throw new PaymentFlowError(422, 'AMOUNT_MISMATCH', 'Paystack transaction amount does not match the booking.')
  }
  if (transaction.currency !== payment.currency) {
    throw new PaymentFlowError(422, 'CURRENCY_MISMATCH', 'Paystack transaction currency does not match the booking.')
  }
  const transactionId = String(transaction.id)
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(transactionId)) {
    throw new PaymentFlowError(422, 'TRANSACTION_ID_INVALID', 'Paystack transaction identity is invalid.')
  }
  const fees = transaction.fees ?? null
  if (fees !== null && (!Number.isSafeInteger(fees) || fees < 0 || fees > transaction.amount)) {
    throw new PaymentFlowError(422, 'PROVIDER_FEE_INVALID', 'Paystack fee details are invalid.')
  }
  return {
    transactionId,
    amountMinor: transaction.amount,
    currency: transaction.currency,
    providerFeeMinor: fees,
    netAmountMinor: fees === null ? null : transaction.amount - fees,
  }
}

export async function verifyPaystackSignature(
  rawBody: Uint8Array,
  modernSignature: string | null,
  legacySignature: string | null,
  secrets: { webhookSecret?: string; secretKey?: string },
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (modernSignature) {
    if (!secrets.webhookSecret) return false
    const parts = modernSignature.split(',').map(part => part.trim())
    const timestamp = parts.find(part => part.startsWith('t='))?.slice(2)
    const time = timestamp && /^\d{1,12}$/.test(timestamp) ? Number(timestamp) : NaN
    if (!Number.isSafeInteger(time) || Math.abs(nowSeconds - time) > 300) return false
    const signatures = parts.filter(part => part.startsWith('v1=')).map(part => part.slice(3).split(':').at(-1) ?? '')
    if (!signatures.length || signatures.some(value => !/^[a-f0-9]{128}$/i.test(value))) return false
    // Sign the exact timestamp text from the header as specified by Paystack.
    const prefix = new TextEncoder().encode(`${timestamp}.`)
    const message = new Uint8Array(prefix.length + rawBody.length)
    message.set(prefix)
    message.set(rawBody, prefix.length)
    const expected = await hmacSha512(secrets.webhookSecret, message)
    return signatures.some(signature => constantTimeHexEqual(expected, signature.toLowerCase()))
  }
  if (!legacySignature || !secrets.secretKey || !/^[a-f0-9]{128}$/i.test(legacySignature)) return false
  const expected = await hmacSha512(secrets.secretKey, rawBody)
  return constantTimeHexEqual(expected, legacySignature.toLowerCase())
}

async function hmacSha512(key: string, message: Uint8Array): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-512' }, false, ['sign'])
  const messageBuffer = new ArrayBuffer(message.byteLength)
  new Uint8Array(messageBuffer).set(message)
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, messageBuffer))
  return [...signature].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

function constantTimeHexEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index++) difference |= left.charCodeAt(index) ^ right.charCodeAt(index)
  return difference === 0
}

export async function paystackRequest<T>(
  url: string,
  secretKey: string,
  init: RequestInit = {},
  timeoutMs = 12_000,
  fetcher: typeof fetch = fetch,
): Promise<{ httpStatus: number; body: T }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetcher(url, {
      ...init,
      signal: controller.signal,
      headers: { authorization: `Bearer ${secretKey}`, 'content-type': 'application/json', ...init.headers },
    })
    let body: T
    try {
      body = await response.json() as T
    } catch {
      throw new PaymentFlowError(503, 'PAYSTACK_INVALID_RESPONSE', 'Paystack returned an invalid response.')
    }
    return { httpStatus: response.status, body }
  } catch (error) {
    if (error instanceof PaymentFlowError) throw error
    throw new PaymentFlowError(503, 'PAYSTACK_UNAVAILABLE', 'Paystack could not be reached. Payment status will remain pending until it can be checked.')
  } finally {
    clearTimeout(timer)
  }
}
