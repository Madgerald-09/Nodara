async function readBounded(response, maximum) {
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > maximum) return null
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader(), chunks = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maximum) { await reader.cancel(); return null }
    chunks.push(value)
  }
  const result = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength }
  return result
}

export async function scrapeEventPage({ apiKey, url, schema, prompt, fetcher = fetch }) {
  const response = await fetcher('https://api.firecrawl.dev/v2/scrape', {
    method: 'POST', signal: AbortSignal.timeout(20000),
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ url, onlyMainContent: true, formats: [{ type: 'json', schema, prompt }] }),
  })
  if (response.status === 429) return { data: null, error: 'busy' }
  if (!response.ok) return { data: null, error: 'upstream' }
  let result
  try {
    const body = await readBounded(response, 1_000_000)
    if (!body) return { data: null, error: 'response_too_large' }
    result = JSON.parse(new TextDecoder().decode(body))
  } catch { return { data: null, error: 'invalid_response' } }
  return result?.success && result?.data?.json
    ? { data: result.data.json, error: null }
    : { data: null, error: 'no_structured_data' }
}

export async function requestEventSpeech({ apiKey, voiceId, text, fetcher = fetch }) {
  const response = await fetcher(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_22050_32`, {
    method: 'POST', signal: AbortSignal.timeout(20000),
    headers: { 'xi-api-key': apiKey, 'content-type': 'application/json', accept: 'audio/mpeg' },
    body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2' }),
  })
  if (response.status === 429) return { audio: null, error: 'busy' }
  if (!response.ok) return { audio: null, error: 'upstream' }
  const audio = await readBounded(response, 5_000_000)
  return audio?.length ? { audio, error: null } : { audio: null, error: 'invalid_audio' }
}

export async function requestTranscript({ apiKey, file, fetcher = fetch }) {
  const form = new FormData()
  form.append('file', file, file.name || 'voice-search.webm')
  form.append('model_id', 'scribe_v2')
  const response = await fetcher('https://api.elevenlabs.io/v1/speech-to-text', {
    method: 'POST', signal: AbortSignal.timeout(20000), headers: { 'xi-api-key': apiKey }, body: form,
  })
  if (response.status === 429) return { payload: null, error: 'busy' }
  if (!response.ok) return { payload: null, error: 'upstream' }
  try {
    const body = await readBounded(response, 256_000)
    if (!body) return { payload: null, error: 'response_too_large' }
    return { payload: JSON.parse(new TextDecoder().decode(body)), error: null }
  } catch { return { payload: null, error: 'invalid_response' } }
}
