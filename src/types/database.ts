export type EventRow = {
  id: string
  organizer_id: string
  title: string
  slug: string
  short_description: string | null
  description: string
  category: string
  cover_image: string | null
  source_url?: string | null
  registration_url?: string | null
  location: string
  address: string | null
  venue: string | null
  country: string
  start_date: string
  end_date: string | null
  price: number
  currency: string
  capacity: number | null
  status: 'draft' | 'published' | 'cancelled' | 'completed'
  created_at: string
  updated_at: string
}

export type CommunityRow = {
  id: string
  creator_id: string
  name: string
  slug: string
  description: string
  category: string
  cover_image: string | null
  location: string | null
  created_at: string
  member_count: number
}

export type ProfileRow = {
  id: string
  full_name: string | null
  username: string | null
  avatar_url: string | null
  bio: string | null
  location: string | null
  interest_categories: string[]
  created_at: string
  updated_at: string
}

export type EventView = {
  id: string
  slug: string
  title: string
  shortDescription: string
  category: string
  date: string
  city: string
  country: string
  price: string
  image: string
  coverImage: string | null
  tag: string
  description: string
  address: string
  amount: number
  currency: string
  status: EventRow['status']
  startDate: string
  createdAt: string
  endDate: string | null
  venue: string | null
  sourceUrl?: string | null
  registrationUrl?: string | null
}
