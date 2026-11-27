import { createClient } from 'npm:@supabase/supabase-js@2'
import { buildPersonalExport } from '../_shared/personal_export.mjs'

const headers = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'private, no-store, max-age=0',
  'access-control-allow-origin': Deno.env.get('NODARA_APP_ORIGIN') ?? 'https://nodara-sigma.vercel.app',
  'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info, x-supabase-api-version',
  'access-control-allow-methods': 'POST, OPTIONS',
  'vary': 'origin',
}

function respond(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers }) }
function optionalTableMissing(error: { code?: string; message?: string } | null) {
  return Boolean(error && (error.code === '42P01' || error.code === 'PGRST205' || /relation .* does not exist/i.test(error.message ?? '')))
}

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers })
  if (request.method !== 'POST') return respond({ error: 'Use POST to request your data export.' }, 405)
  const origin = request.headers.get('origin')
  const allowedOrigin = Deno.env.get('NODARA_APP_ORIGIN') ?? 'https://nodara-sigma.vercel.app'
  if (origin && origin !== allowedOrigin) return respond({ error: 'Origin is not allowed.' }, 403)
  if (Number(request.headers.get('content-length') ?? '0') > 2048) return respond({ error: 'Request is too large.' }, 413)

  const url = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !anonKey || !serviceKey) return respond({ error: 'Data export is not configured.' }, 503)
  const token = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
  if (!token) return respond({ error: 'Sign in to request your data export.' }, 401)
  const userClient = createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data: auth, error: authError } = await userClient.auth.getUser(token)
  if (authError || !auth.user) return respond({ error: 'Your account could not be verified.' }, 401)
  const userId = auth.user.id
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const warnings: string[] = []
  try {
    let profileQuery = await admin.from('profiles').select('id,full_name,username,avatar_url,bio,location,interest_categories,created_at,updated_at').eq('id', userId).maybeSingle()
    if (profileQuery.error?.code === '42703' || profileQuery.error?.code === 'PGRST204') {
      profileQuery = await admin.from('profiles').select('id,full_name,username,avatar_url,bio,location,created_at,updated_at').eq('id', userId).maybeSingle() as typeof profileQuery
      warnings.push('Profile interests were unavailable in the current database schema.')
    }
    if (profileQuery.error) throw new Error('Profile information could not be loaded.')

    const [savedResult, bookingResult, ticketResult, memberResult, collectionResult, reportResult, deletionResult] = await Promise.all([
      admin.from('saved_events').select('user_id,event_id,created_at,event:events(id,title,slug,category,location,country,start_date,cover_image,status)').eq('user_id', userId).order('created_at', { ascending: false }).limit(500),
      admin.from('bookings').select('id,user_id,booking_reference,event_id,quantity,total_amount,currency,status,payment_status,created_at,expires_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(500),
      admin.from('tickets').select('id,booking_id,event_id,ticket_type_id,user_id,holder_user_id,status,checked_in_at,created_at,blockchain_status').or(`user_id.eq.${userId},holder_user_id.eq.${userId}`).order('created_at', { ascending: false }).limit(500),
      admin.from('community_members').select('user_id,community_id,role,joined_at,community:communities(id,name,slug,category,location)').eq('user_id', userId).order('joined_at', { ascending: false }).limit(500),
      admin.from('event_collections').select('id,user_id,name,created_at,updated_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(200),
      admin.from('platform_reports').select('id,reporter_id,target_type,target_id,community_id,reason,description,status,created_at,updated_at').eq('reporter_id', userId).order('created_at', { ascending: false }).limit(200),
      admin.from('account_deletion_requests').select('id,user_id,status,requested_at,updated_at,cancelled_at,completed_at').eq('user_id', userId).order('requested_at', { ascending: false }).limit(20),
    ])

    for (const [name, result] of [['saved events', savedResult], ['bookings', bookingResult], ['tickets', ticketResult], ['community memberships', memberResult]] as const) {
      if (result.error) throw new Error(`Your ${name} could not be loaded.`)
    }
    let collections = collectionResult.data ?? []
    let collectionItems: unknown[] = []
    if (collectionResult.error) {
      if (optionalTableMissing(collectionResult.error)) warnings.push('Personal collections are not available in the current database schema.')
      else throw new Error('Your personal collections could not be loaded.')
    } else if (collections.length) {
      const items = await admin.from('event_collection_items').select('collection_id,event_id,created_at').in('collection_id', collections.map(row => row.id)).limit(1000)
      if (items.error) {
        if (optionalTableMissing(items.error)) { collections = []; warnings.push('Personal collection items are not available in the current database schema.') }
        else throw new Error('Your collection items could not be loaded.')
      } else collectionItems = items.data ?? []
    }

    if (reportResult.error && !optionalTableMissing(reportResult.error)) throw new Error('Your private report history could not be loaded.')
    if (reportResult.error) warnings.push('Private report history is not available in the current database schema.')
    if (deletionResult.error && !optionalTableMissing(deletionResult.error)) throw new Error('Your deletion request history could not be loaded.')
    if (deletionResult.error) warnings.push('Deletion request history is not available in the current database schema.')

    return respond(buildPersonalExport(userId, {
      email: auth.user.email,
      profile: profileQuery.data,
      profilePrivacyPreferences: auth.user.user_metadata?.profile_privacy_preferences ?? null,
      savedEvents: savedResult.data,
      bookings: bookingResult.data,
      tickets: ticketResult.data,
      memberships: memberResult.data,
      collections,
      collectionItems,
      reports: reportResult.data,
      deletionRequests: deletionResult.data,
      warnings,
    }))
  } catch (error) {
    console.error('Private data export failed', error instanceof Error ? error.message : 'unknown error')
    return respond({ error: error instanceof Error ? error.message : 'Your export could not be prepared.' }, 500)
  }
})
