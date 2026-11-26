import type { AuthError, Session, User } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'

export type AuthResult = { user: User | null; error: AuthError | Error | null }

export async function signUp(email: string, password: string, fullName: string): Promise<AuthResult> {
  if (!supabase) return { user: null, error: new Error('Supabase is not configured.') }
  const { data, error } = await supabase.auth.signUp({ email, password, options: { data: { full_name: fullName } } })
  return { user: data.user, error }
}

export async function signIn(email: string, password: string): Promise<AuthResult> {
  if (!supabase) return { user: null, error: new Error('Supabase is not configured.') }
  const { data, error } = await supabase.auth.signInWithPassword({ email, password })
  return { user: data.user, error }
}

export async function signOut(): Promise<{ error: AuthError | Error | null }> {
  if (!supabase) return { error: new Error('Supabase is not configured.') }
  const { error } = await supabase.auth.signOut()
  return { error }
}

export async function getCurrentSession(): Promise<Session | null> {
  if (!supabase) return null
  const { data } = await supabase.auth.getSession()
  return data.session
}
