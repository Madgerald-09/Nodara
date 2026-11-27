import { supabase } from '../lib/supabase'
import type { EventRow, EventView } from '../types/database'
import { mapEvent } from './eventService'

export type SavedExperience = { event: EventView; savedAt: string }
export type PersonalEventCollection = { id: string; name: string; created_at: string; eventIds: string[] }

function unavailable() { return new Error('Supabase is not configured.') }

async function requireUserId() {
  if (!supabase) return { id: null, error: unavailable() }
  const { data, error } = await supabase.auth.getUser()
  if (error) return { id: null, error }
  if (!data.user) return { id: null, error: new Error('Sign in to view your saved experiences.') }
  return { id: data.user.id, error: null }
}

export async function fetchPersonalCollections() {
  const { id, error: authError } = await requireUserId()
  if (!id || authError) return { collections: [] as PersonalEventCollection[], error: authError }
  const { data, error } = await supabase!.from('event_collections')
    .select('id,name,created_at').eq('user_id', id).order('created_at', { ascending: false }).limit(100)
  if (error) return { collections: [], error }
  const rows = data ?? []
  if (!rows.length) return { collections: [], error: null }
  const { data: items, error: itemsError } = await supabase!.from('event_collection_items')
    .select('collection_id,event_id').in('collection_id', rows.map(row => row.id))
  if (itemsError) return { collections: [], error: itemsError }
  return {
    collections: rows.map(row => ({
      ...row,
      eventIds: (items ?? []).filter(item => item.collection_id === row.id).map(item => item.event_id),
    })) as PersonalEventCollection[],
    error: null,
  }
}

export async function fetchOwnSavedExperiences() {
  const { id, error: authError } = await requireUserId()
  if (!id || authError) return { experiences: [] as SavedExperience[], unavailableIds: [] as string[], unavailableCount: 0, error: authError }
  const { data: savedRows, error } = await supabase!.from('saved_events')
    .select('event_id,created_at').eq('user_id', id).order('created_at', { ascending: false }).limit(200)
  if (error) return { experiences: [], unavailableIds: [], unavailableCount: 0, error }
  const rows = savedRows ?? []
  if (!rows.length) return { experiences: [], unavailableIds: [], unavailableCount: 0, error: null }
  const { data: eventRows, error: eventsError } = await supabase!.from('events')
    .select('*').in('id', rows.map(row => row.event_id)).eq('status', 'published')
  if (eventsError) return { experiences: [], unavailableIds: [], unavailableCount: 0, error: eventsError }
  const eventsById = new Map<string, EventRow>((eventRows ?? []).map(row => [row.id, row as EventRow]))
  return {
    experiences: rows.flatMap(row => {
      const event = eventsById.get(row.event_id)
      return event ? [{ event: mapEvent(event), savedAt: row.created_at }] : []
    }),
    unavailableIds: rows.filter(row => !eventsById.has(row.event_id)).map(row => row.event_id),
    unavailableCount: rows.filter(row => !eventsById.has(row.event_id)).length,
    error: null,
  }
}

export async function createPersonalCollection(name: string) {
  const { id, error: authError } = await requireUserId()
  if (!id || authError) return { error: authError }
  const normalized = name.trim().replace(/\s+/g, ' ')
  if (normalized.length < 1 || normalized.length > 60) return { error: new Error('Collection names must be between 1 and 60 characters.') }
  const { error } = await supabase!.from('event_collections').insert({ user_id: id, name: normalized })
  return { error: error?.code === '23505' ? new Error('You already have a collection with that name.') : error }
}

export async function renamePersonalCollection(collectionId: string, name: string) {
  const { id, error: authError } = await requireUserId()
  if (!id || authError) return { error: authError }
  const normalized = name.trim().replace(/\s+/g, ' ')
  if (normalized.length < 1 || normalized.length > 60) return { error: new Error('Collection names must be between 1 and 60 characters.') }
  const { data, error } = await supabase!.from('event_collections').update({ name: normalized })
    .eq('id', collectionId).eq('user_id', id).select('id').maybeSingle()
  if (error) return { error: error.code === '23505' ? new Error('You already have a collection with that name.') : error }
  return { error: data ? null : new Error('Collection not found or unavailable.') }
}

export async function deletePersonalCollection(collectionId: string) {
  const { id, error: authError } = await requireUserId()
  if (!id || authError) return { error: authError }
  const { error } = await supabase!.from('event_collections').delete().eq('id', collectionId).eq('user_id', id)
  return { error }
}

export async function addSavedEventToCollection(collectionId: string, eventId: string) {
  const { error: authError } = await requireUserId()
  if (authError) return { error: authError }
  const { error } = await supabase!.from('event_collection_items').insert({ collection_id: collectionId, event_id: eventId })
  if (error?.code === '23505') return { error: null }
  return { error }
}

export async function removeEventFromCollection(collectionId: string, eventId: string) {
  const { error: authError } = await requireUserId()
  if (authError) return { error: authError }
  const { error } = await supabase!.from('event_collection_items').delete()
    .eq('collection_id', collectionId).eq('event_id', eventId)
  return { error }
}

export async function removeOwnSavedEvent(eventId: string) {
  const { id, error: authError } = await requireUserId()
  if (!id || authError) return { error: authError }
  const { error } = await supabase!.from('saved_events').delete().eq('user_id', id).eq('event_id', eventId)
  return { error }
}
