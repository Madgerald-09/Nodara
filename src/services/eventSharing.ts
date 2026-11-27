import type { EventView } from '../types/database'

export function publicEventPath(slug: string) {
  return `/events/${encodeURIComponent(slug)}`
}

export function publicEventUrl(slug: string, origin: string) {
  return new URL(publicEventPath(slug), origin).toString()
}

function escapeCalendarText(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;')
}

function calendarDate(value: string) {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) throw new Error('This event has an invalid start date.')
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

function foldCalendarLine(line: string) {
  const segments: string[] = []
  let current = ''
  let byteLength = 0
  for (const character of line) {
    const size = new TextEncoder().encode(character).length
    if (byteLength + size > 73 && current) {
      segments.push(current)
      current = ` ${character}`
      byteLength = 1 + size
    } else {
      current += character
      byteLength += size
    }
  }
  segments.push(current)
  return segments.join('\r\n')
}

export function buildEventCalendar(event: EventView, origin: string) {
  const start = new Date(event.startDate)
  if (!Number.isFinite(start.getTime())) throw new Error('This event has an invalid start date.')
  const end = event.endDate ? new Date(event.endDate) : new Date(start.getTime() + 60 * 60 * 1000)
  if (!Number.isFinite(end.getTime()) || end <= start) throw new Error('This event has an invalid end date.')
  const location = [event.venue, event.city, event.country].filter(Boolean).join(', ')
  const description = [event.shortDescription, event.description].filter(Boolean).join('\n\n')
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//NODARA//Experience Calendar//EN', 'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT', `UID:${event.id}@nodara`, `DTSTAMP:${calendarDate(event.createdAt)}`,
    `DTSTART:${calendarDate(start.toISOString())}`, `DTEND:${calendarDate(end.toISOString())}`,
    `SUMMARY:${escapeCalendarText(event.title)}`, `DESCRIPTION:${escapeCalendarText(description)}`,
    `LOCATION:${escapeCalendarText(location)}`, `URL:${publicEventUrl(event.slug, origin)}`,
    'END:VEVENT', 'END:VCALENDAR',
  ]
  return `${lines.map(foldCalendarLine).join('\r\n')}\r\n`
}

export function downloadEventCalendar(event: EventView, origin: string) {
  const content = buildEventCalendar(event, origin)
  const blob = new Blob([content], { type: 'text/calendar;charset=utf-8' })
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = `${event.slug || 'nodara-event'}.ics`
  document.body.append(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(link.href), 1000)
}
