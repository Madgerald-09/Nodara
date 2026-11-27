import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { NodaraLogo } from '../components/NodaraLogo'
import './AccountProfileSettings.css'
import { supabase } from '../lib/supabase'
import { fetchOwnProfile, profileInterestCategories, saveOwnPrivacyPreferences, saveOwnProfile } from '../services/accountProfileService'
import type { OwnProfile } from '../services/accountProfileService'
import { defaultProfilePrivacyPreferences, readProfilePrivacyPreferences } from '../services/profilePrivacyPreferences'
import type { ProfilePrivacyPreferences } from '../services/profilePrivacyPreferences'
import type { NavigateFunction } from './OrganiserApp'

const describeError = (error: unknown) => error instanceof Error ? error.message : 'Could not save settings. Please try again.'

export function AccountProfileSettings({ navigate }: { navigate: NavigateFunction }) {
  const [profile, setProfile] = useState<OwnProfile | null>(null)
  const [form, setForm] = useState({ full_name: '', username: '', avatar_url: '', bio: '', location: '', interest_categories: [] as string[] })
  const [privacy, setPrivacy] = useState<ProfilePrivacyPreferences>({ ...defaultProfilePrivacyPreferences })
  const [loading, setLoading] = useState(true)
  const [savingProfile, setSavingProfile] = useState(false)
  const [savingPrivacy, setSavingPrivacy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [interestsNotice, setInterestsNotice] = useState('')

  useEffect(() => {
    let active = true
    Promise.all([fetchOwnProfile(), supabase?.auth.getUser() ?? Promise.resolve({ data: { user: null }, error: null })])
      .then(([result, authResult]) => {
        if (!active) return
        if (result.error) setError(describeError(result.error))
        if (result.profile) {
          setProfile(result.profile)
          setForm({
            full_name: result.profile.full_name ?? '', username: result.profile.username ?? '',
            avatar_url: result.profile.avatar_url ?? '', bio: result.profile.bio ?? '',
            location: result.profile.location ?? '', interest_categories: result.profile.interest_categories,
          })
          setInterestsNotice(result.interestsNotice ?? '')
        }
        setPrivacy(readProfilePrivacyPreferences(authResult.data.user?.user_metadata?.profile_privacy_preferences))
        setLoading(false)
      })
      .catch((loadError: unknown) => { if (active) { setError(describeError(loadError)); setLoading(false) } })
    return () => { active = false }
  }, [])

  const setField = (key: keyof typeof form, value: string | string[]) => setForm(current => ({ ...current, [key]: value }))
  const toggleInterest = (category: string) => setForm(current => ({
    ...current,
    interest_categories: current.interest_categories.includes(category)
      ? current.interest_categories.filter(item => item !== category)
      : [...current.interest_categories, category],
  }))

  const submitProfile = async (event: FormEvent) => {
    event.preventDefault()
    if (!profile) return
    setSavingProfile(true); setError(''); setNotice('')
    const result = await saveOwnProfile({ ...form }, profile.interestsAvailable)
    setSavingProfile(false)
    if (result.error) setError(describeError(result.error))
    else setNotice('Your private profile settings have been saved.')
  }

  const submitPrivacy = async () => {
    setSavingPrivacy(true); setError(''); setNotice('')
    const result = await saveOwnPrivacyPreferences(privacy)
    setSavingPrivacy(false)
    if (result.error) setError(describeError(result.error))
    else setNotice('Your recommendation privacy preferences have been saved.')
  }

  return <main className="account-settings-page">
    <header className="account-settings-header"><button className="account-settings-brand" aria-label="NODARA home" onClick={() => navigate('/')}><NodaraLogo/></button><button className="account-settings-back" onClick={() => navigate('/')}>Back to discovery</button></header>
    <div className="account-settings-content">
      <div className="account-settings-heading"><span>YOUR ACCOUNT · PRIVATE</span><h1>Profile settings<span>.</span></h1><p>Review and update the information attached to your NODARA account.</p></div>
      {error && <div className="account-settings-message account-settings-error" role="alert">{error}<button onClick={() => { setError(''); setLoading(true); void fetchOwnProfile().then(result => { if (result.profile) { setProfile(result.profile); setForm({ full_name: result.profile.full_name ?? '', username: result.profile.username ?? '', avatar_url: result.profile.avatar_url ?? '', bio: result.profile.bio ?? '', location: result.profile.location ?? '', interest_categories: result.profile.interest_categories }); setError('') } else setError(describeError(result.error)); setLoading(false) }) }}>Retry</button></div>}
      {notice && <div className="account-settings-message account-settings-success" role="status">{notice}</div>}
      {loading ? <div className="account-settings-loading" aria-live="polite">Loading your private profile…</div> : !profile ? <section className="account-settings-panel"><h2>Profile unavailable</h2><p>Sign in through the NODARA homepage and return to account settings.</p><button onClick={() => navigate('/')}>Go to NODARA</button></section> : <>
        <form className="account-settings-panel account-profile-form" onSubmit={event => void submitProfile(event)}>
          <div className="account-panel-title"><div><h2>Your profile information</h2><p>Only your signed-in account can read or edit these profile fields.</p></div><span className="private-pill">PRIVATE</span></div>
          <label>Display name<input value={form.full_name} onChange={event => setField('full_name', event.target.value)} maxLength={120} required autoComplete="name"/></label>
          <label>Username <span className="optional-label">optional</span><input value={form.username} onChange={event => setField('username', event.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))} maxLength={30} minLength={form.username ? 3 : undefined} autoComplete="off"/><small>Kept private in this experience. Use 3–30 lowercase letters, numbers, or underscores.</small></label>
          <label>Profile image URL <span className="optional-label">optional</span><input type="url" value={form.avatar_url} onChange={event => setField('avatar_url', event.target.value)} placeholder="https://…"/><small>Secure HTTPS URLs only. File uploads are not configured.</small></label>
          {form.avatar_url && <div className="account-avatar-preview"><img src={form.avatar_url} alt="Your profile preview" onError={event => { event.currentTarget.hidden = true }}/><span>Private profile image preview</span></div>}
          <label>Biography <span className="optional-label">optional</span><textarea value={form.bio} onChange={event => setField('bio', event.target.value)} maxLength={500} rows={4}/><small>{form.bio.length}/500 characters</small></label>
          <label>Location <span className="optional-label">optional</span><input value={form.location} onChange={event => setField('location', event.target.value)} maxLength={160} autoComplete="off"/><small>Used only if you enable location-based discovery below. It is not shown on a public profile.</small></label>
          <fieldset className="account-interest-fieldset"><legend>Event interests</legend><p>Select categories for your personal recommendations. These are stored on your own profile row.</p>{interestsNotice&&<p className="account-settings-inline-warning">{interestsNotice}</p>}{profile.interestsAvailable ? <div className="account-interest-options">{profileInterestCategories.map(category => <label key={category} className={form.interest_categories.includes(category) ? 'account-interest-option selected' : 'account-interest-option'}><input type="checkbox" checked={form.interest_categories.includes(category)} onChange={() => toggleInterest(category)}/>{category}</label>)}</div> : <p className="account-settings-inline-warning">Interests are unavailable until the existing profile interest migration is installed.</p>}</fieldset>
          <button className="account-settings-primary" disabled={savingProfile}>{savingProfile ? 'Saving profile…' : 'Save profile'}</button>
        </form>
        <form className="account-settings-panel account-privacy-form" onSubmit={event => { event.preventDefault(); void submitPrivacy() }}>
          <div className="account-panel-title"><div><h2>Privacy preferences</h2><p>These controls affect personal recommendations only. NODARA does not expose a public user directory or public profile from this page.</p></div><span className="private-pill">ACCOUNT ONLY</span></div>
          <label className="account-privacy-option"><input type="checkbox" checked={privacy.useInterestsForRecommendations} onChange={event => setPrivacy(current => ({ ...current, useInterestsForRecommendations: event.target.checked }))}/><span><strong>Use my selected interests for recommendations</strong><small>Your category choices can influence the event suggestions shown to you.</small></span></label>
          <label className="account-privacy-option"><input type="checkbox" checked={privacy.useLocationForNearbyDiscovery} onChange={event => setPrivacy(current => ({ ...current, useLocationForNearbyDiscovery: event.target.checked }))}/><span><strong>Use my saved location for nearby discovery</strong><small>Your saved location is used only to find nearby events for your account.</small></span></label>
          <p className="account-privacy-assurance">Profile rows remain protected by Supabase Row Level Security. These settings do not make your profile discoverable.</p>
          <button className="account-settings-primary" disabled={savingPrivacy}>{savingPrivacy ? 'Saving preferences…' : 'Save privacy preferences'}</button>
        </form>
      </>}
    </div>
  </main>
}
