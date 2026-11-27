import { useEffect, useMemo, useState } from 'react'
import type { NavigateFunction } from './OrganiserApp'
import { getOrganiserAnalytics } from '../services/organiserAnalyticsService'
import type { CurrencyFinancials, OrganiserAnalytics } from '../services/organiserAnalyticsService'
import { buildSafeCsv, downloadCsv, formatMinorAmount } from '../services/organiserAnalyticsPresentation'
import './OrganiserAnalytics.css'

type Props = { navigate: NavigateFunction; mode: 'overview' | 'financials' | 'event'; eventId?: string }
const today = new Date()
const initialTo = today.toISOString().slice(0, 10)
const defaultFromDate = new Date(today.getTime() - 89 * 86_400_000)
const initialFrom = defaultFromDate.toISOString().slice(0, 10)
const EMPTY_EVENT_OPTIONS: OrganiserAnalytics['eventOptions'] = []
const midnight = (date: string) => `${date}T00:00:00.000Z`
const endExclusive = (date: string) => {
  const value = new Date(`${date}T00:00:00.000Z`)
  value.setUTCDate(value.getUTCDate() + 1)
  return value.toISOString()
}
const asNumber = (value: number | string | null | undefined) => Number(value ?? 0)

export function OrganiserAnalyticsPage({ navigate, mode, eventId }: Props) {
  const [from, setFrom] = useState(initialFrom)
  const [to, setTo] = useState(initialTo)
  const [selectedEventId, setSelectedEventId] = useState(eventId ?? '')
  const [selectedCurrency, setSelectedCurrency] = useState('')
  const [data, setData] = useState<OrganiserAnalytics | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const filterError = !from || !to || new Date(from) > new Date(to) ? 'Choose a valid date range.' : ''

  useEffect(() => {
    let active = true
    if (filterError) return
    void Promise.resolve().then(async () => {
      if (!active) return
      setLoading(true)
      setError('')
      try {
        const result = await getOrganiserAnalytics(midnight(from), endExclusive(to), mode === 'event' ? eventId : selectedEventId)
        if (!active) return
        setData(result.data)
        setError(result.error ? analyticsError(result.error) : '')
      } catch {
        if (!active) return
        setData(null)
        setError('Analytics could not be loaded. Check your connection and retry.')
      } finally {
        if (active) setLoading(false)
      }
    })
    return () => { active = false }
  }, [from, to, selectedEventId, eventId, mode, reload, filterError])

  const eventOptions = data?.eventOptions ?? EMPTY_EVENT_OPTIONS
  const event = useMemo(() => eventOptions.find(item => item.id === (eventId || selectedEventId)), [eventOptions, eventId, selectedEventId])
  const allFinancials = data?.financeByCurrency ?? []
  const financials = selectedCurrency ? allFinancials.filter(row => row.currency === selectedCurrency) : allFinancials
  const pendingPaymentCount = allFinancials.reduce((sum, row) => sum + asNumber(row.pending_count), 0)
  const exportFinancials = () => {
    if (!data) return
    const csv = buildSafeCsv(
      ['Currency', 'Gross verified minor units', 'Completed refunds minor units', 'Net verified minor units', 'Successful payments', 'Pending payments', 'Failed payments', 'Expired payments', 'Completed refunds', 'Pending refunds', 'Failed refunds', 'Cancelled refunds'],
      financials.map(row => [row.currency, row.gross_minor, row.refunded_minor, asNumber(row.gross_minor) - asNumber(row.refunded_minor), row.successful_count, row.pending_count, row.failed_count, row.expired_count, row.completed_refund_count, row.pending_refund_count, row.failed_refund_count, row.cancelled_refund_count]),
    )
    downloadCsv(`nodara-financial-summary-${from}-to-${to}.csv`, csv)
  }
  const exportRefunds = () => {
    if (!data) return
    downloadCsv(`nodara-refund-summary-${from}-to-${to}.csv`, buildSafeCsv(
      ['Currency', 'Completed refund minor units', 'Completed refunds', 'Pending refunds', 'Failed refunds', 'Cancelled refunds'],
      financials.map(row => [row.currency, row.refunded_minor, row.completed_refund_count, row.pending_refund_count, row.failed_refund_count, row.cancelled_refund_count]),
    ))
  }
  const exportPerformance = () => {
    if (!data) return
    const csv = buildSafeCsv(
      ['Event', 'Status', 'Start date', 'Bookings', 'Confirmed bookings', 'Pending bookings', 'Failed bookings', 'Issued tickets', 'Checked-in tickets', 'Capacity', 'Sold', 'Reserved', 'Available'],
      data.eventsBreakdown.map(row => [row.title, row.status, row.start_date, row.bookings, row.confirmed_bookings, row.pending_bookings, row.failed_bookings, row.issued_tickets, row.checked_in_tickets, row.capacity ?? 'Unlimited', row.sold, row.reserved, row.capacity == null ? 'Unlimited' : Math.max(0, row.capacity - row.sold - row.reserved)]),
    )
    downloadCsv(`nodara-event-performance-${from}-to-${to}.csv`, csv)
  }
  const exportInventory = () => {
    if (!data) return
    downloadCsv(`nodara-ticket-inventory-${from}-to-${to}.csv`, buildSafeCsv(
      ['Ticket type', 'Capacity', 'Sold', 'Reserved', 'Issued'],
      data.ticketTypes.map(row => [row.name, row.capacity ?? 'Unlimited', row.sold, row.reserved, row.issued]),
    ))
  }
  const exportAttendance = () => {
    if (!data) return
    downloadCsv(`nodara-attendance-${from}-to-${to}.csv`, buildSafeCsv(
      ['Date', 'Verified distinct check-ins'], data.checkinTrend.map(row => [row.day, row.checked_in]),
    ))
  }

  return <div className="organiser-analytics">
    <div className="analytics-heading-row">
      <div><span className="tiny-label">ORGANISER INTELLIGENCE</span><h1>{mode === 'financials' ? 'Financials' : mode === 'event' ? 'Event performance' : 'Analytics'}</h1>
        <p>{mode === 'event' && event ? `${event.title} · ${event.location}, ${event.country}` : 'Aggregate performance from your events and verified platform records.'}</p></div>
      <button className="organiser-button" onClick={() => setReload(value => value + 1)} disabled={loading}>↻ Refresh</button>
    </div>
    <section className="organiser-panel analytics-filters" aria-label="Analytics filters">
      <label>From<input type="date" value={from} max={to} onChange={e => setFrom(e.target.value)}/></label>
      <label>Through<input type="date" value={to} min={from} max={initialTo} onChange={e => setTo(e.target.value)}/></label>
      {mode !== 'event' && <label>Event<select aria-label="Filter by event" value={selectedEventId} disabled={!data} onChange={e => setSelectedEventId(e.target.value)}><option value="">All my events</option>{eventOptions.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>}
      {mode === 'financials' && <label>Currency<select aria-label="Filter by currency" value={selectedCurrency} disabled={!data} onChange={e => setSelectedCurrency(e.target.value)}><option value="">All currencies (separate totals)</option>{allFinancials.map(row => <option key={row.currency} value={row.currency}>{row.currency}</option>)}</select></label>}
      <span className="analytics-period-note">Default period: last 90 days. Counts follow the date of the recorded activity.</span>
    </section>
    {(error || filterError) && <div className="form-error inline-organiser-error" role="alert">{filterError || error}<button onClick={() => setReload(value => value + 1)}>Retry</button></div>}
    {!error && !filterError && loading && <div className="organiser-loading"><span className="organiser-spinner"/>Loading private analytics…</div>}
    {!error && !filterError && !loading && data && <>
      {mode === 'financials' ? <>
        <div className="analytics-definition">Revenue is shown in integer minor units grouped by currency. Gross includes independently verified Paystack payments only; net subtracts completed refunds. No currency conversion is applied.</div>
        <section className="analytics-currency-grid" aria-label="Verified financial totals">
          {financials.length ? financials.map(row => <article className="organiser-panel analytics-currency-card" key={row.currency}>
            <span className="tiny-label">{row.currency}</span><h2>{formatMinorAmount(asNumber(row.gross_minor), row.currency)}</h2><p>Gross verified payments</p>
            <dl><div><dt>Completed refunds</dt><dd>{formatMinorAmount(asNumber(row.refunded_minor), row.currency)}</dd></div><div><dt>Net verified</dt><dd>{formatMinorAmount(asNumber(row.gross_minor) - asNumber(row.refunded_minor), row.currency)}</dd></div><div><dt>Payments · successful / pending / failed / expired</dt><dd>{row.successful_count} / {row.pending_count} / {row.failed_count} / {row.expired_count}</dd></div><div><dt>Refunds · completed / pending / failed / cancelled</dt><dd>{row.completed_refund_count} / {row.pending_refund_count} / {row.failed_refund_count} / {row.cancelled_refund_count}</dd></div></dl>
          </article>) : <div className="organiser-empty"><h2>No payment activity for this period</h2><p>Verified payments and refund records will appear here after they are recorded.</p></div>}
        </section>
        <section className="organiser-panel analytics-chart-panel"><div className="panel-heading"><div><span className="tiny-label">VERIFIED TRANSACTION ACTIVITY</span><h2>Payments and completed refunds over time</h2></div><span className="analytics-muted">Minor units · grouped by currency</span></div>{financials.map(row => <div className="analytics-currency-trend" key={row.currency}><h3>{row.currency}</h3><DailyBars rows={data.paymentTrend.filter(day => day.currency === row.currency).map(day => ({ day: day.day, primary: asNumber(day.gross_minor), secondary: asNumber(day.refunded_minor), tertiary: 0 }))} labels={['Verified gross', 'Completed refunds']} ariaLabel={`${row.currency} daily verified payments and completed refund amounts in minor units`}/></div>)}</section>
        <section className="organiser-panel analytics-table-panel"><div className="panel-heading"><div><span className="tiny-label">REPORTS</span><h2>Financial and refund reports</h2></div><div className="analytics-report-actions"><button className="organiser-button organiser-button-primary" disabled={!financials.length} onClick={exportFinancials}>Financial CSV</button><button className="organiser-button" disabled={!financials.length} onClick={exportRefunds}>Refund CSV</button></div></div><p className="analytics-muted">Contains aggregate amounts and counts only. It excludes customer identities, provider references, and webhook data.</p>{financials.length > 0 && <><FinancialTable rows={financials}/><h3 className="analytics-subheading">Verified totals by event and currency</h3><EventFinancialTable rows={data.financeByEventCurrency}/></>}</section>
      </> : <>
        <div className="organiser-stats analytics-stats">
          <Metric label="Events" value={data.events.total} detail={`${data.events.published} published · ${data.events.draft} drafts`}/>
          <Metric label="Bookings" value={data.bookings.total} detail={`${data.bookings.confirmed} confirmed · ${data.bookings.pending} pending · ${data.bookings.failed} failed`}/>
          <Metric label="Tickets issued" value={data.tickets.issued} detail={`${data.tickets.validRemaining} issued and not checked in`}/>
          <Metric label="Verified check-ins" value={data.tickets.checkedIn} detail={data.tickets.issued ? `${Math.round(data.tickets.checkedIn / data.tickets.issued * 100)}% of tickets issued in this period` : 'No valid issued tickets in this period'}/>
        </div>
        <div className="organiser-stats analytics-stats analytics-stats-secondary">
          <Metric label="Upcoming events" value={data.events.upcoming} detail={`${data.events.past} past events`}/>
          <Metric label="Cancelled / expired bookings" value={data.bookings.cancelled + data.bookings.expired} detail={`${data.bookings.cancelled} cancelled · ${data.bookings.expired} expired`}/>
          <Metric label="Available inventory" value={data.inventory.available == null ? 'Unlimited' : data.inventory.available} detail={`${data.inventory.sold} sold · ${data.inventory.reserved} reserved`}/>
          <Metric label="Pending payments" value={pendingPaymentCount} detail="Payment attempts; not counted as revenue"/>
        </div>
        <div className="analytics-report-actions"><button className="organiser-button" disabled={!data.eventsBreakdown.length} onClick={exportPerformance}>Event performance CSV</button><button className="organiser-button" disabled={!data.ticketTypes.length} onClick={exportInventory}>Ticket inventory CSV</button><button className="organiser-button" disabled={!data.checkinTrend.length} onClick={exportAttendance}>Attendance CSV</button><button className="organiser-button" disabled={!financials.length} onClick={exportFinancials}>Financial summary CSV</button></div>
        <section className="organiser-panel analytics-chart-panel"><div className="panel-heading"><div><span className="tiny-label">ACTIVITY</span><h2>Bookings over time</h2></div><span className="analytics-muted">Daily totals · selected period</span></div>
          <DailyBars rows={data.bookingTrend.map(row => ({ day: row.day, primary: asNumber(row.confirmed), secondary: asNumber(row.pending), tertiary: asNumber(row.cancelled) }))} labels={['Confirmed', 'Pending', 'Cancelled']} ariaLabel="Daily confirmed, pending and cancelled booking counts"/>
        </section>
        <section className="organiser-panel analytics-chart-panel"><div className="panel-heading"><div><span className="tiny-label">ATTENDANCE</span><h2>Verified check-ins</h2></div><span className="analytics-muted">Distinct tickets · duplicate scans excluded</span></div>
          <DailyBars rows={data.checkinTrend.map(row => ({ day: row.day, primary: asNumber(row.checked_in), secondary: 0, tertiary: 0 }))} labels={['Check-ins']} ariaLabel="Daily distinct verified ticket check-ins"/>
        </section>
        <section className="organiser-panel analytics-table-panel"><div className="panel-heading"><div><span className="tiny-label">PERFORMANCE</span><h2>{mode === 'event' ? 'Ticket categories' : 'Events'}</h2></div></div>
          {mode === 'event' ? <TicketTypeTable types={data.ticketTypes}/> : <EventTable rows={data.eventsBreakdown} navigate={navigate}/>}
        </section>
        {mode === 'event' && <section className="organiser-panel analytics-table-panel"><div className="panel-heading"><div><span className="tiny-label">FINANCIAL SUMMARY</span><h2>Verified payments by currency</h2></div></div>{financials.length ? <><FinancialTable rows={financials}/><EventFinancialTable rows={data.financeByEventCurrency.filter(row => !selectedCurrency || row.currency === selectedCurrency)}/></> : <p className="analytics-muted">No verified payment activity in this period.</p>}</section>}
        <Insights data={data} pendingPaymentCount={pendingPaymentCount}/>
      </>}
      <p className="analytics-freshness">Data generated {new Date(data.generatedAt).toLocaleString()} · aggregate report · no attendee identities included</p>
    </>}
  </div>
}

function analyticsError(message: string) {
  const lower = message.toLowerCase()
  if (lower.includes('sign in')) return 'Sign in to access organiser analytics.'
  if (lower.includes('event not found') || lower.includes('access denied')) return 'This event is unavailable in your organiser workspace.'
  if (lower.includes('reporting period') || lower.includes('date range')) return 'Choose a valid reporting period of 366 days or less.'
  return 'Analytics could not be loaded. Check your connection and retry.'
}

function Metric({ label, value, detail }: { label: string; value: number | string; detail: string }) {
  return <div className="organiser-stat"><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>
}

function DailyBars({ rows, labels, ariaLabel }: { rows: Array<{ day: string; primary: number; secondary: number; tertiary: number }>; labels: string[]; ariaLabel: string }) {
  const max = Math.max(1, ...rows.flatMap(row => [row.primary, row.secondary, row.tertiary]))
  return <div className="analytics-bars-wrap">
    <div className="analytics-legend">{labels.map((label, i) => <span key={label}><i className={`analytics-dot analytics-series-${i}`}/>{label}</span>)}</div>
    {rows.every(row => row.primary + row.secondary + row.tertiary === 0) ? <div className="analytics-empty-chart">No recorded activity in this period.</div> : <div className="analytics-bars">{rows.map(row => <div className="analytics-bar-day" key={row.day} title={`${row.day}: ${labels.map((label, i) => `${label} ${[row.primary,row.secondary,row.tertiary][i]}`).join(', ')}`}><div className="analytics-bar-stack">{[row.primary,row.secondary,row.tertiary].map((value, i) => value ? <i key={i} className={`analytics-series-${i}`} style={{ height: `${Math.max(2, value / max * 100)}%` }}/> : null)}</div><small>{new Date(`${row.day}T00:00:00`).toLocaleDateString('en', { month: 'short', day: 'numeric' })}</small></div>)}</div>}
    <table className="analytics-accessible-table"><caption>{ariaLabel}</caption><thead><tr><th>Date</th>{labels.map(label => <th key={label}>{label}</th>)}</tr></thead><tbody>{rows.map(row => <tr key={row.day}><th>{row.day}</th><td>{row.primary}</td>{labels.length > 1 && <td>{row.secondary}</td>}{labels.length > 2 && <td>{row.tertiary}</td>}</tr>)}</tbody></table>
  </div>
}

function EventTable({ rows, navigate }: { rows: OrganiserAnalytics['eventsBreakdown']; navigate: NavigateFunction }) {
  if (!rows.length) return <p className="analytics-muted">No owned events are available in this report.</p>
  return <div className="analytics-overflow"><table className="event-table"><thead><tr><th>Event</th><th>Status</th><th>Bookings</th><th>Tickets issued</th><th>Check-ins</th><th>Capacity</th><th>Sold</th><th>Reserved</th><th>Available</th><th/></tr></thead><tbody>{rows.map(row => <tr key={row.id}><td>{row.title}<small className="table-event-meta">{new Date(row.start_date).toLocaleDateString()}</small></td><td>{row.status}</td><td>{row.confirmed_bookings} confirmed · {row.pending_bookings} pending · {row.failed_bookings} failed</td><td>{row.issued_tickets}</td><td>{row.checked_in_tickets}</td><td>{row.capacity ?? 'Unlimited'}</td><td>{row.sold}</td><td>{row.reserved}</td><td>{row.capacity == null ? 'Unlimited' : Math.max(0,row.capacity-row.sold-row.reserved)}</td><td><button className="analytics-link-button" onClick={() => navigate(`/organiser/events/${row.id}/analytics`)}>Details</button></td></tr>)}</tbody></table><p className="analytics-muted">Maximum 200 events per report. Use the event filter for a focused report.</p></div>
}

function TicketTypeTable({ types }: { types: OrganiserAnalytics['ticketTypes'] }) {
  return types.length ? <div className="analytics-overflow"><table className="event-table"><thead><tr><th>Ticket category</th><th>Capacity</th><th>Sold</th><th>Reserved</th><th>Issued</th><th>Available</th></tr></thead><tbody>{types.map(type => <tr key={type.id}><td>{type.name}</td><td>{type.capacity ?? 'Unlimited'}</td><td>{type.sold}</td><td>{type.reserved}</td><td>{type.issued}</td><td>{type.capacity == null ? 'Unlimited' : Math.max(0,type.capacity-type.sold-type.reserved)}</td></tr>)}</tbody></table><p className="analytics-muted">Ticket categories are limited to the 100 highest issued counts in this report.</p></div> : <p className="analytics-muted">No ticket categories are available for this event.</p>
}

function FinancialTable({ rows }: { rows: CurrencyFinancials[] }) {
  return <div className="analytics-overflow"><table className="event-table"><thead><tr><th>Currency</th><th>Gross verified</th><th>Completed refunds</th><th>Net verified</th><th>Successful payments</th></tr></thead><tbody>{rows.map(row => <tr key={row.currency}><td>{row.currency}</td><td>{formatMinorAmount(asNumber(row.gross_minor),row.currency)}</td><td>{formatMinorAmount(asNumber(row.refunded_minor),row.currency)}</td><td>{formatMinorAmount(asNumber(row.gross_minor)-asNumber(row.refunded_minor),row.currency)}</td><td>{row.successful_count}</td></tr>)}</tbody></table></div>
}

function EventFinancialTable({ rows }: { rows: OrganiserAnalytics['financeByEventCurrency'] }) {
  return rows.length ? <div className="analytics-overflow"><table className="event-table"><thead><tr><th>Event</th><th>Currency</th><th>Gross verified</th><th>Completed refunds</th><th>Net verified</th></tr></thead><tbody>{rows.map(row => <tr key={`${row.event_id}:${row.currency}`}><td>{row.title}</td><td>{row.currency}</td><td>{formatMinorAmount(asNumber(row.gross_minor),row.currency)}</td><td>{formatMinorAmount(asNumber(row.refunded_minor),row.currency)}</td><td>{formatMinorAmount(asNumber(row.gross_minor)-asNumber(row.refunded_minor),row.currency)}</td></tr>)}</tbody></table></div> : <p className="analytics-muted">No verified payment or completed refund amounts were recorded in this period.</p>
}

function Insights({ data, pendingPaymentCount }: { data: OrganiserAnalytics; pendingPaymentCount: number }) {
  const best = [...data.eventsBreakdown].sort((a,b) => b.confirmed_bookings - a.confirmed_bookings)[0]
  const lowInventory = data.eventsBreakdown.filter(row => row.capacity != null && row.capacity > 0 && row.capacity-row.sold-row.reserved <= Math.max(1, Math.ceil(row.capacity * .1)))
  const pastWithAttendanceGap = data.eventsBreakdown.filter(row => new Date(row.start_date) < new Date() && row.issued_tickets > row.checked_in_tickets)
  return <section className="organiser-panel analytics-insights"><span className="tiny-label">OBSERVATIONS</span><h2>What the records show</h2>
    {!best && pendingPaymentCount === 0 && !lowInventory.length && !pastWithAttendanceGap.length ? <p className="analytics-muted">There is not enough activity in this period to show observations.</p> : <ul>
      {best && best.confirmed_bookings > 0 && <li><strong>{best.title}</strong> has the highest confirmed booking count in this report ({best.confirmed_bookings}).</li>}
      {pendingPaymentCount > 0 && <li>{pendingPaymentCount} payment attempt{pendingPaymentCount === 1 ? ' is' : 's are'} pending. These amounts are excluded from verified revenue.</li>}
      {lowInventory.map(row => <li key={row.id}><strong>{row.title}</strong> is at or near its recorded ticket capacity ({Math.max(0,row.capacity! - row.sold - row.reserved)} remaining).</li>)}
      {pastWithAttendanceGap.map(row => <li key={row.id}><strong>{row.title}</strong> has fewer distinct check-ins than issued tickets ({row.checked_in_tickets} of {row.issued_tickets}). This is a count comparison, not an attendance forecast.</li>)}
    </ul>}
  </section>
}
