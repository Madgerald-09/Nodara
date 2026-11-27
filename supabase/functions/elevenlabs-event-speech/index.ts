import { createClient } from 'npm:@supabase/supabase-js@2'
import { buildEventSpeechText } from '../_shared/voice_discovery.mjs'
import { requestEventSpeech } from '../_shared/provider_api.mjs'

const origin = Deno.env.get('NODARA_APP_ORIGIN') ?? 'https://nodara-sigma.vercel.app'
const headers = { 'cache-control': 'private, no-store', 'access-control-allow-origin': origin, 'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info', 'access-control-allow-methods': 'POST, OPTIONS', vary: 'origin' }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...headers, 'content-type': 'application/json; charset=utf-8' } })

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers })
  if (request.method !== 'POST') return json({ error: 'Use POST to request event audio.' }, 405)
  if (request.headers.get('origin') && request.headers.get('origin') !== origin) return json({ error: 'Origin is not allowed.' }, 403)
  if (Number(request.headers.get('content-length') ?? '0') > 2048) return json({ error: 'Request is too large.' }, 413)
  const url = Deno.env.get('SUPABASE_URL'), anon = Deno.env.get('SUPABASE_ANON_KEY'), service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const apiKey = Deno.env.get('ELEVENLABS_API_KEY'), voiceId = Deno.env.get('ELEVENLABS_VOICE_ID')
  if (!url || !anon || !service || !apiKey || !voiceId) return json({ error: 'Spoken event summaries are not configured.' }, 503)
  const token = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
  if (!token) return json({ error: 'Sign in to use spoken event summaries.' }, 401)
  const userClient = createClient(url, anon, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false, autoRefreshToken: false } })
  const { data: auth, error: authError } = await userClient.auth.getUser(token)
  if (authError || !auth.user) return json({ error: 'Your signed-in account could not be verified.' }, 401)
  let body: { eventId?: unknown; mode?: unknown }
  try { body = await request.json() } catch { return json({ error: 'Send a valid request.' }, 400) }
  if (typeof body.eventId !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.eventId) || !['summary', 'description'].includes(String(body.mode))) return json({ error: 'Choose a published event and supported audio format.' }, 400)
  const { data: event, error: eventError } = await userClient.from('events').select('id,title,short_description,description,location,country,start_date,price,currency,status').eq('id', body.eventId).eq('status', 'published').maybeSingle()
  if (eventError || !event) return json({ error: 'This published event is unavailable.' }, 404)
  let text: string
  try { text = buildEventSpeechText(event, body.mode) } catch (error) { return json({ error: error instanceof Error ? error.message : 'Event audio is unavailable.' }, 422) }
  const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data: allowed, error: limitError } = await admin.rpc('consume_ai_provider_request', { p_user_id: auth.user.id, p_provider: 'elevenlabs_tts', p_limit: 20, p_window_seconds: 3600 })
  if (limitError) return json({ error: 'Request protection is unavailable. Try again later.' }, 503)
  if (!allowed) return json({ error: 'Spoken summary limit reached. Try again later.' }, 429)
  try {
    const result = await requestEventSpeech({ apiKey, voiceId, text })
    if (result.error) return json({ error: result.error === 'busy' ? 'Voice service is busy. Try again later.' : 'Spoken audio could not be generated.' }, result.error === 'busy' ? 429 : 502)
    const audio = result.audio!
    return new Response(audio, { status: 200, headers: { ...headers, 'content-type': 'application/octet-stream', 'x-audio-content-type': 'audio/mpeg' } })
  } catch (error) {
    console.error('ElevenLabs speech request failed', error instanceof Error ? error.name : 'unknown')
    return json({ error: 'Voice service timed out. Try again.' }, 502)
  }
})
