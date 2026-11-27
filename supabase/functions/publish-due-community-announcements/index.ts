import { createClient } from 'npm:@supabase/supabase-js@2'

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

// Intended only for Supabase Cron or another trusted scheduler. Configure that
// scheduler with the service-role bearer token stored in Supabase Vault.
Deno.serve(async request => {
  if (request.method !== 'POST') return response({ error: 'Use POST.' }, 405)
  const url = Deno.env.get('SUPABASE_URL')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !serviceRoleKey) return response({ error: 'Scheduled publisher is not configured.' }, 503)
  const bearer = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
  if (!bearer || bearer !== serviceRoleKey) return response({ error: 'Service authorization required.' }, 401)

  const admin = createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data, error } = await admin.rpc('publish_due_community_announcements')
  if (error) {
    console.error('Scheduled announcement publication failed', error.code ?? 'database_error')
    return response({ error: 'Due announcements could not be published.' }, 500)
  }
  return response({ publishedCount: Number(data ?? 0) })
})
