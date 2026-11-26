import type { EventRow, EventView } from '../types/database'
import { supabase } from '../lib/supabase'

export type EventFilters = { query?: string; category?: string; location?: string }
export type EventStatus = EventRow['status']
export type EventWriteInput = Pick<EventRow,
  'title' | 'short_description' | 'description' | 'category' | 'cover_image' | 'location' | 'address' | 'venue' | 'country' |
  'start_date' | 'end_date' | 'price' | 'currency' | 'capacity' | 'status'
>

type EventMutationResult = { event: EventRow | null; error: string | null }

async function requireUserId() {
  if (!supabase) return { userId: null, error: 'Supabase is not configured.' }
  const { data, error } = await supabase.auth.getUser()
  if (error) return { userId: null, error: error.message }
  if (!data.user) return { userId: null, error: 'Sign in to manage events.' }
  return { userId: data.user.id, error: null }
}

export async function createEvent(input: EventWriteInput): Promise<EventMutationResult> {
  if (!supabase) return { event: null, error: 'Supabase is not configured.' }
  const { userId, error: authError } = await requireUserId()
  if (!userId) return { event: null, error: authError }
  const slugBase = input.title.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 72) || 'experience'
  const payload = { ...input, organizer_id: userId, slug: `${slugBase}-${crypto.randomUUID().slice(0, 8)}` }
  const { data, error } = await supabase.from('events').insert(payload).select('*').single()
  return { event: data as EventRow | null, error: error?.message ?? null }
}

export async function updateEvent(eventId: string, updates: Partial<EventWriteInput>): Promise<EventMutationResult> {
  if (!supabase) return { event: null, error: 'Supabase is not configured.' }
  const { userId, error: authError } = await requireUserId()
  if (!userId) return { event: null, error: authError }
  const { data, error } = await supabase.from('events').update(updates).eq('id', eventId).eq('organizer_id', userId).select('*').maybeSingle()
  if (error) return { event: null, error: error.message }
  if (!data) return { event: null, error: 'Event not found or you do not have permission to manage it.' }
  return { event: data as EventRow, error: null }
}

export async function getMyEvents(): Promise<{ events: EventRow[]; error: string | null }> {
  if (!supabase) return { events: [], error: 'Supabase is not configured.' }
  const { userId, error: authError } = await requireUserId()
  if (!userId) return { events: [], error: authError }
  const { data, error } = await supabase.from('events').select('*').eq('organizer_id', userId).order('created_at', { ascending: false })
  return { events: (data ?? []) as EventRow[], error: error?.message ?? null }
}

export async function getEventById(eventId: string): Promise<EventMutationResult> {
  if (!supabase) return { event: null, error: 'Supabase is not configured.' }
  const { userId, error: authError } = await requireUserId()
  if (!userId) return { event: null, error: authError }
  const { data, error } = await supabase.from('events').select('*').eq('id', eventId).eq('organizer_id', userId).maybeSingle()
  if (error) return { event: null, error: error.message }
  if (!data) return { event: null, error: 'Event not found or you do not have permission to view it.' }
  return { event: data as EventRow, error: null }
}

export async function publishEvent(eventId: string) {
  return updateEvent(eventId, { status: 'published' })
}

export async function cancelEvent(eventId: string) {
  return updateEvent(eventId, { status: 'cancelled' })
}

export async function fetchEvents(filters: EventFilters = {}) {
  if (!supabase) return { events: [] as EventView[], error: new Error('Supabase is not configured.') }
  let request = supabase.from('events').select('*').eq('status', 'published').order('start_date', { ascending: true })
  if (filters.category && filters.category !== 'All' && filters.category !== 'Any category') request = request.eq('category', filters.category)
  if (filters.location && filters.location !== 'Anywhere') request = request.ilike('location', `%${filters.location}%`)
  if (filters.query?.trim()) {
    const term = filters.query.trim().replace(/[^\p{L}\p{N}\s-]/gu, ' ').trim()
    if (term) request = request.or(`title.ilike.%${term}%,category.ilike.%${term}%,location.ilike.%${term}%,country.ilike.%${term}%`)
  }
  const { data, error } = await request
  return { events: (data ?? []).map(mapEvent), error }
}

export async function fetchEventById(id: string) {
  if (!supabase) return { event: null, error: new Error('Supabase is not configured.') }
  const { data, error } = await supabase.from('events').select('*').eq('id', id).eq('status', 'published').maybeSingle()
  return { event: data ? mapEvent(data) : null, error }
}

export async function fetchSavedEventIds(userId: string) {
  if (!supabase) return { ids: [] as string[], error: new Error('Supabase is not configured.') }
  const { data, error } = await supabase.from('saved_events').select('event_id').eq('user_id', userId)
  return { ids: (data ?? []).map(row => row.event_id), error }
}

export async function setSavedEvent(userId: string, eventId: string, save: boolean) {
  if (!supabase) return { error: new Error('Supabase is not configured.') }
  const result = save
    ? await supabase.from('saved_events').insert({ user_id: userId, event_id: eventId })
    : await supabase.from('saved_events').delete().eq('user_id', userId).eq('event_id', eventId)
  return { error: result.error }
}

function mapEvent(row: EventRow): EventView {
  const date = new Date(row.start_date)
  const dateLabel = date.toLocaleDateString('en', { month: 'short', day: '2-digit' }).toUpperCase()
  const timeLabel = date.toLocaleTimeString('en', { hour: 'numeric', minute: '2-digit' }).toUpperCase()
  return {
    id: row.id,
    title: row.title,
    shortDescription: row.short_description ?? '',
    category: row.category,
    date: `${dateLabel} · ${timeLabel}`,
    city: row.location,
    country: row.country,
    price: row.price === 0 ? 'Free' : `From ${new Intl.NumberFormat('en', { style: 'currency', currency: row.currency }).format(row.price)}`,
    image: row.cover_image ?? 'https://images.unsplash.com/photo-1523580494863-6f3031224c94?auto=format&fit=crop&w=900&q=85',
    coverImage: row.cover_image,
    tag: row.category.toUpperCase(),
    description: row.description,
    address: row.address ?? '',
    amount: Number(row.price),
    currency: row.currency,
  }
}
