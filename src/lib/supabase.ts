import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL?.trim()
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim()

export const supabaseConfigError = !url || !publishableKey
  ? 'Supabase is not configured. Add VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY to .env.local.'
  : !/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url)
    ? 'VITE_SUPABASE_URL must be a valid Supabase project URL.'
    : !publishableKey.startsWith('sb_publishable_') && !publishableKey.startsWith('eyJ')
      ? 'VITE_SUPABASE_PUBLISHABLE_KEY must be a Supabase publishable (or legacy anon) key.'
      : null

export const supabase = supabaseConfigError ? null : createClient(url!, publishableKey!, {
  auth: { autoRefreshToken: true, persistSession: true, detectSessionInUrl: true },
})
