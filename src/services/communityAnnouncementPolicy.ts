export type CommunityAnnouncementVisibility = {
  status: string
  published_at: string | null
}

/** Client-side display guard; database RLS independently enforces the same boundary. */
export function isPublicCommunityAnnouncement(item: CommunityAnnouncementVisibility, now = Date.now()) {
  const publishedAt = item.published_at ? Date.parse(item.published_at) : Number.NaN
  return item.status === 'published' && Number.isFinite(publishedAt) && publishedAt <= now
}

export function isSafeCommunityHttpsUrl(value: string) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password
  } catch { return false }
}
