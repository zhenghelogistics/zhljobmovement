// Metrics for the job movement report: monthly, quarterly or yearly.
//
// This is the performance report. Leads measure what might come in; movements measure
// what was actually delivered and what it earned, which is what a management meeting
// is really asking about.
//
// Pure functions, unit-tested, because these figures are presented to company
// leadership. The route does the querying; this file only does arithmetic.

const DAY = 1000 * 60 * 60 * 24

const num = (v) => {
  if (v === null || v === undefined || v === '') return 0
  const n = typeof v === 'number' ? v : parseFloat(v)
  return Number.isFinite(n) ? n : 0
}
const round2 = (n) => Math.round(n * 100) / 100
const pct1 = (part, whole) => (whole ? Math.round((part / whole) * 1000) / 10 : 0)

// Dates on jobs are stored as plain YYYY-MM-DD text, so compare them as calendar days
// rather than instants. Parsing them as UTC would shift every comparison by the local
// offset and mislabel jobs delivered on the deadline itself as late.
function asDay(value) {
  if (!value) return null
  const s = String(value).slice(0, 10)
  const [y, m, d] = s.split('-').map(Number)
  if (!y || !m || !d) return null
  return Date.UTC(y, m - 1, d)
}

/**
 * Resolve a reporting period into a window plus the equivalent preceding window.
 * Accepts 'YYYY-MM' (month), 'YYYY-Qn' (quarter) or 'YYYY' (year).
 */
function periodWindow(ref, today = new Date()) {
  let kind, start, end, label

  const asMonth = /^(\d{4})-(\d{2})$/.exec(ref || '')
  const asQuarter = /^(\d{4})-?Q([1-4])$/i.exec(ref || '')
  const asYear = /^(\d{4})$/.exec(ref || '')

  if (asQuarter) {
    kind = 'quarter'
    const y = +asQuarter[1], q = +asQuarter[2]
    start = new Date(y, (q - 1) * 3, 1)
    end = new Date(y, q * 3, 1)
    label = `Q${q} ${y}`
  } else if (asYear) {
    kind = 'year'
    const y = +asYear[1]
    start = new Date(y, 0, 1)
    end = new Date(y + 1, 0, 1)
    label = String(y)
  } else if (asMonth) {
    kind = 'month'
    const y = +asMonth[1], m = +asMonth[2] - 1
    start = new Date(y, m, 1)
    end = new Date(y, m + 1, 1)
    label = start.toLocaleDateString('en-SG', { month: 'long', year: 'numeric' })
  } else {
    kind = 'month'
    start = new Date(today.getFullYear(), today.getMonth(), 1)
    end = new Date(today.getFullYear(), today.getMonth() + 1, 1)
    label = start.toLocaleDateString('en-SG', { month: 'long', year: 'numeric' })
  }

  // The comparable preceding window: previous month, previous quarter, previous year.
  const span = { month: 1, quarter: 3, year: 12 }[kind]
  const prevStart = new Date(start.getFullYear(), start.getMonth() - span, 1)

  return { kind, start, end, prevStart, label }
}

function rank(rows, keyFn, valueFn, { limit = 8, label = 'Unspecified' } = {}) {
  const acc = new Map()
  for (const r of rows) {
    const raw = keyFn(r)
    const key = (raw == null || String(raw).trim() === '') ? label : String(raw).trim()
    const cur = acc.get(key) || { key, jobs: 0, value: 0 }
    cur.jobs++
    cur.value += num(valueFn(r))
    acc.set(key, cur)
  }
  return [...acc.values()]
    .sort((a, b) => b.value - a.value || b.jobs - a.jobs)
    .slice(0, limit)
    .map(x => ({ ...x, value: round2(x.value) }))
}

/**
 * @param jobs rows for the period, each carrying `sale` and `cost` already summed
 *             from its billing and cost lines by the query.
 */
function deriveMovementMetrics(jobs = []) {
  // Voided jobs are cancelled work. They are reported as a count because a rising
  // void rate is worth discussing, but they are excluded from every revenue, volume
  // and delivery figure — counting them would overstate what was actually moved.
  const voided = jobs.filter(j => j.status === 'Voided')
  const live = jobs.filter(j => j.status !== 'Voided')

  const sale = live.reduce((s, j) => s + num(j.sale), 0)
  const cost = live.reduce((s, j) => s + num(j.cost), 0)
  const profit = sale - cost

  const completed = live.filter(j => j.status === 'Completed')

  // Only jobs with both a promised date and an actual delivery can be judged. Saying
  // nothing is better than scoring a job that was never given a deadline.
  const judgeable = live.filter(j => asDay(j.deadline_date) && asDay(j.date_delivered))
  const onTime = judgeable.filter(j => asDay(j.date_delivered) <= asDay(j.deadline_date))
  const lateDays = judgeable
    .filter(j => asDay(j.date_delivered) > asDay(j.deadline_date))
    .map(j => (asDay(j.date_delivered) - asDay(j.deadline_date)) / DAY)

  const transitDays = live
    .filter(j => asDay(j.date_out) && asDay(j.date_delivered))
    .map(j => (asDay(j.date_delivered) - asDay(j.date_out)) / DAY)
    .filter(d => d >= 0)

  // Jobs carrying revenue but no recorded cost. Every one of these overstates profit
  // until somebody enters the supplier invoice, so it is a number worth surfacing.
  const missingCosting = live.filter(j => num(j.sale) > 0 && num(j.cost) === 0)

  const byCustomer = rank(live, j => j.customer_name || j.shipper, j => j.sale, { limit: 8 })
  const topShare = sale > 0 && byCustomer.length ? pct1(byCustomer[0].value, sale) : 0

  return {
    volume: {
      jobs: live.length,
      completed: completed.length,
      voided: voided.length,
      voidRate: pct1(voided.length, jobs.length),
      weightKg: round2(live.reduce((s, j) => s + num(j.weight), 0)),
      cbm: round2(live.reduce((s, j) => s + num(j.cbm), 0)),
      packages: live.reduce((s, j) => s + num(j.packages), 0),
    },
    money: {
      sale: round2(sale),
      cost: round2(cost),
      profit: round2(profit),
      gpPercent: sale > 0 ? Math.round((profit / sale) * 1000) / 10 : 0,
      avgJobValue: live.length ? round2(sale / live.length) : 0,
      avgJobProfit: live.length ? round2(profit / live.length) : 0,
    },
    delivery: {
      judged: judgeable.length,
      onTime: onTime.length,
      late: judgeable.length - onTime.length,
      onTimeRate: pct1(onTime.length, judgeable.length),
      avgDaysLate: lateDays.length ? Math.round((lateDays.reduce((a, b) => a + b, 0) / lateDays.length) * 10) / 10 : 0,
      avgTransitDays: transitDays.length
        ? Math.round((transitDays.reduce((a, b) => a + b, 0) / transitDays.length) * 10) / 10 : null,
    },
    risk: {
      // Concentration is a standing question for leadership: how exposed are we if the
      // biggest account walks.
      topCustomerShare: topShare,
      topCustomerName: byCustomer[0]?.key || null,
      missingCosting: missingCosting.length,
      missingCostingValue: round2(missingCosting.reduce((s, j) => s + num(j.sale), 0)),
    },
    byMode: rank(live, j => j.mode, j => j.sale, { limit: 9 }).map(m => {
      const rows = live.filter(j => (j.mode || 'Unspecified') === m.key)
      const s = rows.reduce((a, j) => a + num(j.sale), 0)
      const c = rows.reduce((a, j) => a + num(j.cost), 0)
      return { ...m, profit: round2(s - c), gpPercent: s > 0 ? Math.round(((s - c) / s) * 1000) / 10 : 0 }
    }),
    byCustomer,
    byStatus: rank(live, j => j.status, j => j.sale, { limit: 6, label: 'New' }),
    byTeam: rank(live, j => j.salesperson || j.created_by, j => j.sale, { limit: 8, label: 'Unassigned' })
      .map(t => {
        const rows = live.filter(j => (j.salesperson || j.created_by || 'Unassigned') === t.key)
        const s = rows.reduce((a, j) => a + num(j.sale), 0)
        const c = rows.reduce((a, j) => a + num(j.cost), 0)
        return { ...t, profit: round2(s - c), gpPercent: s > 0 ? Math.round(((s - c) / s) * 1000) / 10 : 0 }
      }),
    topJobs: [...live]
      .sort((a, b) => num(b.sale) - num(a.sale))
      .slice(0, 8)
      .map(j => ({
        job_number: j.job_number,
        customer: j.customer_name || j.shipper || 'Unnamed',
        mode: j.mode || '',
        sale: round2(num(j.sale)),
        profit: round2(num(j.sale) - num(j.cost)),
        gpPercent: num(j.sale) > 0 ? Math.round(((num(j.sale) - num(j.cost)) / num(j.sale)) * 1000) / 10 : 0,
      })),
  }
}

/** Buckets jobs into calendar months so a quarter or year shows its shape over time. */
function deriveTrend(jobs = []) {
  const acc = new Map()
  for (const j of jobs) {
    if (j.status === 'Voided' || !j.created_at) continue
    const d = new Date(j.created_at)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    const cur = acc.get(key) || { month: key, jobs: 0, sale: 0, cost: 0 }
    cur.jobs++
    cur.sale += num(j.sale)
    cur.cost += num(j.cost)
    acc.set(key, cur)
  }
  return [...acc.values()]
    .sort((a, b) => a.month.localeCompare(b.month))
    .map(x => ({
      ...x,
      sale: round2(x.sale), cost: round2(x.cost),
      profit: round2(x.sale - x.cost),
      gpPercent: x.sale > 0 ? Math.round(((x.sale - x.cost) / x.sale) * 1000) / 10 : 0,
      label: new Date(+x.month.slice(0, 4), +x.month.slice(5, 7) - 1, 1)
        .toLocaleDateString('en-SG', { month: 'short' }),
    }))
}

module.exports = { periodWindow, deriveMovementMetrics, deriveTrend, asDay, rank }
