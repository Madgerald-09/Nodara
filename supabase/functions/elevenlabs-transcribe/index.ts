import { createClient } from 'npm:@supabase/supabase-js@2'
import { normalizeTranscript } from '../_shared/voice_discovery.mjs'
import { requestTranscript } from '../_shared/provider_api.mjs'

const origin = Deno.env.get('NODARA_APP_ORIGIN') ?? 'https://nodara-sigma.vercel.app'
const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': origin, 'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info', 'access-control-allow-methods': 'POST, OPTIONS', vary: 'origin' }
const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers })
const allowedMime = new Set(['audio/webm', 'audio/mp4', 'audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/ogg'])

async function readBounded(request: Request, maxBytes: number) {
  const reader = request.body?.getReader()
  if (!reader) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) { await reader.cancel(); return null }
    chunks.push(value)
  }
  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength }
  return body
}

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers })
  if (request.method !== 'POST') return respond({ error: 'Use POST to transcribe a short voice search.' }, 405)
  if (request.headers.get('origin') && request.headers.get('origin') !== origin) return respond({ error: 'Origin is not allowed.' }, 403)
  if (Number(request.headers.get('content-length') ?? '0') > 1_600_000) return respond({ error: 'Audio must be shorter or smaller than the supported limit.' }, 413)
  const url = Deno.env.get('SUPABASE_URL'), anon = Deno.env.get('SUPABASE_ANON_KEY'), service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'), apiKey = Deno.env.get('ELEVENLABS_API_KEY')
  if (!url || !anon || !service || !apiKey) return respond({ error: 'Voice search is not configured.' }, 503)
  const token = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
  if (!token) return respond({ error: 'Sign in to use voice search. Typing remains available.' }, 401)
  const userClient = createClient(url, anon, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false, autoRefreshToken: false } })
  const { data: auth, error: authError } = await userClient.auth.getUser(token)
  if (authError || !auth.user) return respond({ error: 'Your signed-in account could not be verified.' }, 401)
  const boundedBody = await readBounded(request, 1_600_000)
  if (!boundedBody) return respond({ error: 'Audio must be shorter or smaller than the supported limit.' }, 413)
  let form: FormData
  try { form = await new Request(request.url, { method: 'POST', headers: request.headers, body: boundedBody }).formData() } catch { return respond({ error: 'Send an audio recording to transcribe.' }, 400) }
  const file = form.get('audio')
  if (!(file instanceof File) || file.size < 1 || file.size > 1_500_000 || !allowedMime.has(file.type.toLowerCase())) return respond({ error: 'Use a short recording in a supported audio format.' }, 400)
  const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data: allowed, error: limitError } = await admin.rpc('consume_ai_provider_request', { p_user_id: auth.user.id, p_provider: 'elevenlabs_stt', p_limit: 10, p_window_seconds: 3600 })
  if (limitError) return respond({ error: 'Request protection is unavailable. Try again later.' }, 503)
  if (!allowed) return respond({ error: 'Voice search limit reached. Try again later.' }, 429)
  try {
    const result = await requestTranscript({ apiKey, file })
    if (result.error) return respond({ error: result.error === 'busy' ? 'Voice service is busy. Try again later.' : 'Speech could not be transcribed.' }, result.error === 'busy' ? 429 : 502)
    return respond({ transcript: normalizeTranscript(result.payload) })
  } catch (error) {
    console.error('ElevenLabs transcription failed', error instanceof Error ? error.name : 'unknown')
    return respond({ error: 'Voice search timed out. You can type your search instead.' }, 502)
  }
})
