import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSafeCsv, formatMinorAmount } from '../src/services/organiserAnalyticsPresentation.ts'
import { readFile } from 'node:fs/promises'

test('CSV exports use UTF-8 BOM, quote delimiters, quotes, and line breaks', () => {
  const csv = buildSafeCsv(['Event', 'Note'], [['Meetup, Lagos', 'A "quoted"\nline']])
  assert.ok(csv.startsWith('\uFEFF'))
  assert.match(csv, /"Meetup, Lagos"/)
  assert.match(csv, /"A ""quoted""\nline"/)
})

test('CSV export neutralizes spreadsheet formulas, including whitespace-prefixed values', () => {
  const csv = buildSafeCsv(['Title'], [[' =HYPERLINK("https://example.invalid")']])
  assert.match(csv, /"' =HYPERLINK\(""https:\/\/example\.invalid""\)"/)
})

test('minor currency units use the currency exponent rather than assuming two digits', () => {
  assert.equal(formatMinorAmount(1234, 'JPY'), '¥1,234')
  assert.equal(formatMinorAmount(1234, 'NGN'), 'NGN 12.34')
})

test('analytics SQL scopes every aggregate to the authenticated organiser and returns no raw payment rows', async () => {
  const sql = await readFile(new URL('../supabase/migrations/202611270013_organiser_analytics.sql', import.meta.url), 'utf8')
  assert.match(sql, /security definer[\s\S]*set search_path = ''/i)
  assert.match(sql, /v_user_id uuid := auth\.uid\(\)/i)
  assert.match(sql, /e\.organizer_id = v_user_id/i)
  assert.match(sql, /provider_transaction_id is not null/i)
  assert.match(sql, /status='succeeded'/i)
  assert.match(sql, /revoke all on function[\s\S]*from public, anon/i)
  assert.doesNotMatch(sql, /select\s+p\.\*|select\s+t\.qr_token|auth\.users\s+au/i)
})
