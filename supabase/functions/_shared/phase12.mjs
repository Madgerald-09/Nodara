const blockedHost = /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.test|metadata\.google\.internal)$/i

export function validateImportUrl(raw, allowedHosts) {
  if (typeof raw !== 'string' || raw.length > 2048) return { ok: false, error: 'Enter a valid public event webpage URL.' }
  let url
  try { url = new URL(raw) } catch { return { ok: false, error: 'Enter a valid public event webpage URL.' } }
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  const allowed = new Set((allowedHosts ?? []).map(item => String(item).trim().toLowerCase()).filter(Boolean))
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !host || blockedHost.test(host)
      || host.includes(':') || /^\d+(?:\.\d+){3}$/.test(host) || !allowed.has(host)) {
    return { ok: false, error: 'This HTTPS host is not on the organiser import allowlist.' }
  }
  return { ok: true, url: url.toString(), host }
}

const cleanText = (value, max) => typeof value === 'string'
  ? value.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
  : ''

function safeHttps(value) {
  if (typeof value !== 'string' || !value.trim()) return ''
  try {
    const u = new URL(value), host = u.hostname.toLowerCase().replace(/\.$/, '')
    return u.protocol === 'https:' && !u.username && !u.password && !u.port && host.includes('.')
      && !blockedHost.test(host) && !host.includes(':') && !/^\d+(?:\.\d+){3}$/.test(host) && !/^\d+$/.test(host)
      ? u.toString() : ''
  } catch { return '' }
}

const hasExplicitZone = value => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/i.test(value)

export function normalizeImportedEvent(raw, sourceUrl, allowedCategories) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('The event page did not return structured event details.')
  const title = cleanText(raw.title, 180)
  const description = cleanText(raw.description, 3000)
  const categoryText = cleanText(raw.category, 80)
  const category = allowedCategories.find(value => value.toLowerCase() === categoryText.toLowerCase()) ?? ''
  const start = hasExplicitZone(raw.start_date) ? new Date(raw.start_date) : new Date(NaN)
  const end = hasExplicitZone(raw.end_date) ? new Date(raw.end_date) : null
  const city = cleanText(raw.city, 180)
  const country = cleanText(raw.country, 100)
  const venue = cleanText(raw.venue, 180)
  const image = safeHttps(raw.cover_image)
  const registration = safeHttps(raw.registration_url)
  const extractedPrice = raw.price === null || raw.price === undefined ? null : Number(raw.price)
  const currency = typeof raw.currency === 'string' && /^[A-Za-z]{3}$/.test(raw.currency) ? raw.currency.toUpperCase() : ''
  const priceKnown = extractedPrice !== null && Number.isFinite(extractedPrice) && extractedPrice >= 0 && (extractedPrice === 0 || Boolean(currency))
  const warnings = []
  if (!title) warnings.push('Add an event title.')
  if (!description) warnings.push('Add a description.')
  if (!category) warnings.push('Choose a supported category.')
  if (!Number.isFinite(start.getTime())) warnings.push('Add a valid start date and time.')
  if (end && (!Number.isFinite(end.getTime()) || end <= start)) warnings.push('Review the end date and time.')
  if (!city) warnings.push('Add a city.')
  if (!country) warnings.push('Add a country.')
  if (!priceKnown) warnings.push('Ticket price was not clearly available. Confirm whether this event is free or paid in the form.')
  if (raw.cover_image && !image) warnings.push('The extracted image URL was discarded because it was not a safe HTTPS URL.')
  if (raw.registration_url && !registration) warnings.push('The registration URL was discarded because it was not a safe HTTPS URL.')
  return {
    draft: {
      title, short_description: description.slice(0, 240), description, category, country, location: city,
      venue, address: '', start_date: Number.isFinite(start.getTime()) ? start.toISOString() : '',
      end_date: end && Number.isFinite(end.getTime()) && end > start ? end.toISOString() : '',
      cover_image: image, registration_url: registration, source_url: sourceUrl,
      free: priceKnown && extractedPrice === 0, price: priceKnown && extractedPrice > 0 ? String(extractedPrice) : priceKnown ? '0' : '', currency: currency || 'USD', capacity: '',
    },
    warnings,
  }
}

export function findPossibleDuplicate(candidate, events) {
  const title = String(candidate?.title ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  if (!title) return null
  const day = candidate?.start_date ? new Date(candidate.start_date).toISOString().slice(0, 10) : ''
  const city = String(candidate?.location ?? '').toLowerCase().trim()
  return (events ?? []).find(event => {
    const otherTitle = String(event.title ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
    const otherDay = event.start_date ? new Date(event.start_date).toISOString().slice(0, 10) : ''
    return otherTitle === title && day && day === otherDay && String(event.location ?? '').toLowerCase().trim() === city
  }) ?? null
}
