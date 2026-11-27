import test from 'node:test'
import assert from 'node:assert/strict'
import { buildEventCalendar, publicEventPath, publicEventUrl } from '../src/services/eventSharing.ts'

const fixture = {
  id: 'a1', slug: 'evening-market', title: 'Music, Market; Night', shortDescription: 'Meet, discover',
  description: 'Doors open\\\nBring a friend', city: 'Lagos', country: 'Nigeria', venue: 'Freedom Park',
  startDate: '2026-12-10T17:00:00.000Z', endDate: '2026-12-10T20:00:00.000Z', createdAt: '2026-11-27T12:00:00.000Z',
}

test('shareable event URLs contain only the public event slug', () => {
  assert.equal(publicEventPath('evening-market'), '/events/evening-market')
  assert.equal(publicEventUrl('evening-market', 'https://nodara.example'), 'https://nodara.example/events/evening-market')
})

test('calendar export contains public event details and escaped ICS text', () => {
  const calendar = buildEventCalendar(fixture, 'https://nodara.example')
  assert.match(calendar, /BEGIN:VCALENDAR\r\n/)
  assert.match(calendar, /SUMMARY:Music\\, Market\\; Night/)
  assert.match(calendar, /DESCRIPTION:Meet\\, discover\\n\\nDoors open\\\\\\nBring a friend/)
  assert.match(calendar, /DTSTART:20261210T170000Z/)
  assert.match(calendar, /DTEND:20261210T200000Z/)
  assert.match(calendar, /LOCATION:Freedom Park\\, Lagos\\, Nigeria/)
  assert.match(calendar, /URL:https:\/\/nodara\.example\/events\/evening-market/)
  assert.doesNotMatch(calendar, /attendee|booking|ticket/i)
})

test('calendar export uses a one-hour default when no event end is supplied', () => {
  const calendar = buildEventCalendar({ ...fixture, endDate: null }, 'https://nodara.example')
  assert.match(calendar, /DTEND:20261210T180000Z/)
})

test('invalid event times are rejected rather than generating a broken calendar file', () => {
  assert.throws(() => buildEventCalendar({ ...fixture, startDate: 'invalid' }, 'https://nodara.example'), /invalid start date/i)
  assert.throws(() => buildEventCalendar({ ...fixture, endDate: '2026-12-10T16:00:00Z' }, 'https://nodara.example'), /invalid end date/i)
})
