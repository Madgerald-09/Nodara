import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { findPossibleDuplicate, normalizeImportedEvent, validateImportUrl } from '../supabase/functions/_shared/phase12.mjs'
import { buildEventSpeechText, normalizeTranscript } from '../supabase/functions/_shared/voice_discovery.mjs'
import { buildGroundedDiscoveryAnswer, parseNaturalLanguageDiscovery } from '../src/services/naturalLanguageDiscovery.ts'
import { requestEventSpeech, requestTranscript, scrapeEventPage } from '../supabase/functions/_shared/provider_api.mjs'

test('Firecrawl URL validation requires exact allowlisted HTTPS hosts', () => {
  assert.equal(validateImportUrl('https://events.example.com/show', ['events.example.com']).ok, true)
  for (const url of ['http://events.example.com', 'https://events.example.com:8443', 'https://localhost', 'https://127.0.0.1', 'https://evil.example.net', 'https://user:pass@events.example.com']) {
    assert.equal(validateImportUrl(url, ['events.example.com']).ok, false, url)
  }
  assert.equal(validateImportUrl('https://events.example.com', []).ok, false)
})

test('import extraction cleans content, preserves source, and reports missing details', () => {
  const { draft, warnings } = normalizeImportedEvent({ title: '<b>Summer Lab</b>', description: '<script>bad</script> Safe event', category: 'Technology', start_date: '2027-06-01T10:00:00Z', end_date: '2027-06-01T12:00:00Z', city: 'Lagos', country: 'Nigeria', cover_image: 'javascript:alert(1)', registration_url: 'https://events.example.com/register' }, 'https://events.example.com/page', ['Technology'])
  assert.equal(draft.title, 'Summer Lab')
  assert.equal(draft.source_url, 'https://events.example.com/page')
  assert.equal(draft.cover_image, '')
  assert.equal(draft.registration_url, 'https://events.example.com/register')
  assert.ok(warnings.some(value => value.includes('image URL was discarded')))
  assert.equal(draft.free, false)
  assert.equal(draft.price, '')
  assert.ok(warnings.some(value => value.includes('Ticket price was not clearly available')))
})

test('duplicate check compares title, day, and city only within supplied organiser data', () => {
  const candidate = { title: 'Summer Lab!', start_date: '2027-06-01T10:00:00Z', location: 'Lagos' }
  assert.equal(findPossibleDuplicate(candidate, [{ id: '1', title: 'Summer Lab', start_date: '2027-06-01T16:00:00Z', location: 'lagos' }]).id, '1')
  assert.equal(findPossibleDuplicate(candidate, [{ title: 'Summer Lab', start_date: '2027-06-02T10:00:00Z', location: 'Lagos' }]), null)
})

test('natural language discovery extracts supported category, price, date, and city filters', () => {
  const filters = parseNaturalLanguageDiscovery('Find free technology events in Lagos next month', new Date('2026-11-27T12:00:00Z'))
  assert.equal(filters.category, 'Technology')
  assert.equal(filters.price, 'free')
  assert.equal(filters.location, 'lagos')
  assert.equal(filters.dateFrom, '2026-12-01')
  assert.equal(filters.dateTo, '2026-12-31')
  assert.equal(filters.sort, 'upcoming')
})

test('natural language date ranges and no-query behavior are deterministic', () => {
  const filters = parseNaturalLanguageDiscovery('music events this weekend', new Date('2026-11-27T12:00:00Z'))
  assert.equal(filters.dateFrom, '2026-11-28')
  assert.equal(filters.dateTo, '2026-11-29')
  assert.deepEqual(parseNaturalLanguageDiscovery(''), { sort: 'upcoming' })
})

test('assistant response is grounded in retrieved listing fields and handles no results', () => {
  const answer = buildGroundedDiscoveryAnswer([{ title: 'Open Studio', city: 'Lagos', country: 'Nigeria', price: 'Free', startDate: '2026-12-01T10:00:00Z' }], { category: 'Art & Culture' })
  assert.match(answer, /Open Studio/)
  assert.match(answer, /Free/)
  assert.match(buildGroundedDiscoveryAnswer([], {}), /could not find published events/)
})

test('voice speech uses public event fields and transcript handling is bounded', () => {
  const text = buildEventSpeechText({ title: 'Design Day', short_description: 'Meet designers', location: 'Lagos', country: 'Nigeria', start_date: '2026-12-01T10:00:00Z', price: 0, status: 'published' }, 'summary')
  assert.match(text, /Design Day/)
  assert.match(text, /Free/)
  assert.throws(() => buildEventSpeechText({ status: 'draft' }, 'summary'), /unavailable/)
  assert.equal(normalizeTranscript({ text: '  Find music  ' }), 'Find music')
  assert.throws(() => normalizeTranscript({ text: '' }), /No speech was recognised/)
})

test('provider requests use the documented endpoints and handle success and retryable failures with mocks', async () => {
  let firecrawlRequest
  const scrape = await scrapeEventPage({ apiKey: 'test-only', url: 'https://events.example.com', schema: { type: 'object' }, prompt: 'Extract facts', fetcher: async (url, init) => {
    firecrawlRequest = { url, init }
    return new Response(JSON.stringify({ success: true, data: { json: { title: 'Gathering' } } }), { status: 200 })
  } })
  assert.equal(firecrawlRequest.url, 'https://api.firecrawl.dev/v2/scrape')
  assert.equal(firecrawlRequest.init.headers.authorization, 'Bearer test-only')
  assert.equal(scrape.data.title, 'Gathering')
  assert.equal((await scrapeEventPage({ apiKey: 'x', url: 'https://events.example.com', schema: {}, prompt: '', fetcher: async () => new Response('{}', { status: 429 }) })).error, 'busy')

  let speechRequest
  const speech = await requestEventSpeech({ apiKey: 'test-only', voiceId: 'voice-id', text: 'Grounded event facts', fetcher: async (url, init) => {
    speechRequest = { url, init }
    return new Response(new Uint8Array([1, 2, 3]), { status: 200 })
  } })
  assert.match(speechRequest.url, /\/v1\/text-to-speech\/voice-id\?output_format=mp3_22050_32$/)
  assert.equal(speechRequest.init.headers['xi-api-key'], 'test-only')
  assert.deepEqual([...speech.audio], [1, 2, 3])
  assert.equal((await requestEventSpeech({ apiKey: 'x', voiceId: 'v', text: 'x', fetcher: async () => new Response('', { status: 503 }) })).error, 'upstream')

  let transcriptRequest
  const transcript = await requestTranscript({ apiKey: 'test-only', file: new File(['audio'], 'query.webm', { type: 'audio/webm' }), fetcher: async (url, init) => {
    transcriptRequest = { url, init }
    return new Response(JSON.stringify({ text: 'Events near Lagos' }), { status: 200 })
  } })
  assert.equal(transcriptRequest.url, 'https://api.elevenlabs.io/v1/speech-to-text')
  assert.equal(transcriptRequest.init.headers['xi-api-key'], 'test-only')
  assert.equal(transcript.payload.text, 'Events near Lagos')
  assert.equal((await requestTranscript({ apiKey: 'x', file: new File(['audio'], 'query.webm'), fetcher: async () => new Response('', { status: 429 }) })).error, 'busy')
})

test('trusted Solana synchronization endpoints require finalized transaction and account evidence', async () => {
  for (const file of [
    '../supabase/functions/verify-solana-ticket/index.ts',
    '../supabase/functions/verify-solana-transfer/index.ts',
    '../supabase/functions/verify-solana-check-in/index.ts',
  ]) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8')
    assert.match(source, /getTransaction'.*commitment: 'finalized'/)
    assert.match(source, /getAccountInfo'.*commitment: 'finalized'/)
    assert.doesNotMatch(source, /commitment: 'confirmed'/)
  }
})
