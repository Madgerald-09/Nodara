const plain = value => String(value ?? '').replace(/<[^>]*>/g, ' ').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()

export function buildEventSpeechText(event, mode) {
  if (!event || event.status !== 'published') throw new Error('This published event is unavailable.')
  const title = plain(event.title).slice(0, 180)
  const description = plain(mode === 'description' ? event.description : (event.short_description || event.description)).slice(0, mode === 'description' ? 1200 : 500)
  if (!title || !description) throw new Error('The event does not include enough public information to read aloud.')
  const date = event.start_date ? new Date(event.start_date) : null
  const dateText = date && Number.isFinite(date.getTime()) ? date.toLocaleString('en', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) : ''
  const place = [plain(event.location), plain(event.country)].filter(Boolean).join(', ')
  const price = Number(event.price) === 0 ? 'Free' : Number.isFinite(Number(event.price)) && event.currency
    ? `${new Intl.NumberFormat('en', { style: 'currency', currency: event.currency }).format(Number(event.price))}` : ''
  return [title, description, dateText && `Date listed: ${dateText} UTC.`, place && `Location: ${place}.`, price && `Listed price: ${price}.`].filter(Boolean).join(' ').slice(0, 1800)
}

export function normalizeTranscript(payload) {
  const value = typeof payload?.text === 'string' ? plain(payload.text).slice(0, 1200) : ''
  if (!value) throw new Error('No speech was recognised. Try again or type your search.')
  return value
}
