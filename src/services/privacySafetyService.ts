import { supabase } from '../lib/supabase'

export type ReportReason = 'misleading_information' | 'incorrect_details' | 'inappropriate_content' | 'impersonation' | 'other'
export type ReportTarget = { type: 'event' | 'community' | 'announcement'; id: string }

function unavailable() { return new Error('Sign in to use this account safety feature.') }

export async function submitPrivateReport(target: ReportTarget, reason: ReportReason, description: string) {
  if (!supabase) return { id: null, error: unavailable() }
  if (!['event', 'community', 'announcement'].includes(target.type) || !/^[0-9a-f-]{36}$/i.test(target.id)) return { id: null, error: new Error('This item cannot be reported.') }
  if (description.trim().length > 1000) return { id: null, error: new Error('Please keep the explanation under 1,000 characters.') }
  const { data, error } = await supabase.rpc('submit_platform_report', {
    p_target_type: target.type, p_target_id: target.id, p_reason: reason, p_description: description.trim() || null,
  })
  return { id: typeof data === 'string' ? data : null, error }
}

export async function getOwnReports() {
  if (!supabase) return { reports: [], error: unavailable() }
  const { data, error } = await supabase.from('platform_reports')
    .select('id,target_type,target_id,reason,status,created_at,updated_at')
    .order('created_at', { ascending: false }).limit(50)
  return { reports: data ?? [], error }
}

export async function getOwnDeletionRequests() {
  if (!supabase) return { requests: [], error: unavailable() }
  const { data, error } = await supabase.from('account_deletion_requests')
    .select('id,status,requested_at,updated_at,cancelled_at,completed_at')
    .order('requested_at', { ascending: false }).limit(10)
  return { requests: data ?? [], error }
}

export async function requestOwnDeletion(confirmation: string) {
  if (!supabase) return { id: null, error: unavailable() }
  const { data, error } = await supabase.rpc('request_account_deletion', { p_confirmation: confirmation })
  return { id: typeof data === 'string' ? data : null, error }
}

export async function cancelOwnDeletion(requestId: string) {
  if (!supabase) return { cancelled: false, error: unavailable() }
  const { data, error } = await supabase.rpc('cancel_account_deletion', { p_request_id: requestId })
  return { cancelled: data === true, error }
}

export async function isCurrentUserPlatformModerator() {
  if (!supabase) return { moderator: false, error: unavailable() }
  const { data, error } = await supabase.rpc('is_platform_moderator')
  return { moderator: data === true, error }
}

export async function getModerationQueue() {
  if (!supabase) return { reports: [], error: unavailable() }
  const { data, error } = await supabase.from('platform_reports')
    .select('id,reporter_id,target_type,target_id,community_id,reason,description,status,created_at,updated_at')
    .order('created_at', { ascending: true }).limit(100)
  return { reports: data ?? [], error }
}

export async function getModerationAudit(reportId: string) {
  if (!supabase) return { actions: [], error: unavailable() }
  const { data, error } = await supabase.from('platform_report_actions')
    .select('id,moderator_id,previous_status,new_status,decision,internal_note,created_at')
    .eq('report_id', reportId).order('created_at', { ascending: false }).limit(30)
  return { actions: data ?? [], error }
}

export async function reviewPrivateReport(input: { reportId: string; status: string; decision: string; internalNote: string }) {
  if (!supabase) return { error: unavailable() }
  const { error } = await supabase.rpc('review_platform_report', {
    p_report_id: input.reportId, p_new_status: input.status,
    p_decision: input.decision, p_internal_note: input.internalNote.trim() || null,
  })
  return { error }
}
