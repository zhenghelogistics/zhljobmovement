const test = require('node:test')
const assert = require('node:assert')
const { periodWindow, deriveMovementMetrics, deriveTrend, asDay } = require('./movementReport')

// A representative month of movements. Sale/cost arrive pre-summed from the query.
const JOBS = [
  { job_number:'ZHL-001/26', mode:'Sea FCL', status:'Completed', customer_name:'Amandari',
    weight:1200, cbm:14, packages:20, sale:9000, cost:6500,
    date_out:'2026-08-02', date_delivered:'2026-08-09', deadline_date:'2026-08-10',
    salesperson:'brandon@zhenghe.com.sg', created_at:'2026-08-01T00:00:00Z' },
  { job_number:'ZHL-002/26', mode:'Air Freight', status:'Completed', customer_name:'Jooyi',
    weight:300, cbm:2, packages:8, sale:6000, cost:4000,
    date_out:'2026-08-04', date_delivered:'2026-08-12', deadline_date:'2026-08-08',  // 4 days late
    salesperson:'brandon@zhenghe.com.sg', created_at:'2026-08-03T00:00:00Z' },
  { job_number:'ZHL-003/26', mode:'Sea FCL', status:'In Progress', customer_name:'Amandari',
    weight:800, cbm:9, packages:12, sale:5000, cost:0,                                // no costing yet
    created_at:'2026-08-10T00:00:00Z' },
  { job_number:'ZHL-004/26', mode:'Local Delivery', status:'Completed', customer_name:'Delta',
    weight:150, cbm:1, packages:4, sale:1000, cost:700,
    date_out:'2026-08-14', date_delivered:'2026-08-14', deadline_date:'2026-08-14',   // exactly on time
    salesperson:'ops@zhenghe.com.sg', created_at:'2026-08-13T00:00:00Z' },
  { job_number:'ZHL-005/26', mode:'Sea FCL', status:'Voided', customer_name:'Ghost',
    weight:9999, cbm:99, packages:99, sale:50000, cost:40000, created_at:'2026-08-15T00:00:00Z' },
]

// ── period resolution ─────────────────────────────────────────────────────────

test('resolves a month, quarter and year', () => {
  const m = periodWindow('2026-08')
  assert.strictEqual(m.kind, 'month')
  assert.strictEqual(m.label, 'August 2026')

  const q = periodWindow('2026-Q3')
  assert.strictEqual(q.kind, 'quarter')
  assert.strictEqual(q.label, 'Q3 2026')
  assert.strictEqual(q.start.getMonth(), 6)  // July
  assert.strictEqual(q.end.getMonth(), 9)    // exclusive October

  const y = periodWindow('2026')
  assert.strictEqual(y.kind, 'year')
  assert.strictEqual(y.label, '2026')
})

test('the comparison window matches the length of the period', () => {
  assert.strictEqual(periodWindow('2026-08').prevStart.getMonth(), 6)   // July
  assert.strictEqual(periodWindow('2026-Q3').prevStart.getMonth(), 3)   // April, i.e. Q2
  assert.strictEqual(periodWindow('2026').prevStart.getFullYear(), 2025)
})

test('an unrecognised period falls back to the current month rather than failing', () => {
  const p = periodWindow('nonsense', new Date(2026, 7, 15))
  assert.strictEqual(p.kind, 'month')
  assert.strictEqual(p.start.getMonth(), 7)
})

// ── volume and money ──────────────────────────────────────────────────────────

test('voided jobs are counted but excluded from revenue and volume', () => {
  const m = deriveMovementMetrics(JOBS)
  assert.strictEqual(m.volume.jobs, 4, 'the voided job is not counted as work done')
  assert.strictEqual(m.volume.voided, 1)
  assert.strictEqual(m.money.sale, 21000, 'the voided S$50,000 is excluded')
  assert.strictEqual(m.volume.weightKg, 2450, 'its 9,999kg is excluded too')
})

test('reports profit and margin off live jobs only', () => {
  const m = deriveMovementMetrics(JOBS)
  assert.strictEqual(m.money.cost, 11200)
  assert.strictEqual(m.money.profit, 9800)
  assert.strictEqual(m.money.gpPercent, 46.7)
})

test('average job value ignores voided work', () => {
  const m = deriveMovementMetrics(JOBS)
  assert.strictEqual(m.money.avgJobValue, 5250) // 21000 / 4
})

// ── delivery performance ──────────────────────────────────────────────────────

test('scores on-time delivery only where both dates exist', () => {
  const m = deriveMovementMetrics(JOBS)
  assert.strictEqual(m.delivery.judged, 3, 'the in-progress job has no delivery date')
  assert.strictEqual(m.delivery.onTime, 2)
  assert.strictEqual(m.delivery.late, 1)
  assert.strictEqual(m.delivery.onTimeRate, 66.7)
})

test('delivery on the deadline itself counts as on time', () => {
  // ZHL-004 was delivered on its deadline. Treating that as late would be wrong, and
  // is exactly what a UTC-parsed comparison would do from a UTC+8 machine.
  const m = deriveMovementMetrics([JOBS[3]])
  assert.strictEqual(m.delivery.onTime, 1)
  assert.strictEqual(m.delivery.onTimeRate, 100)
})

test('measures how late the late ones were, and transit time', () => {
  const m = deriveMovementMetrics(JOBS)
  assert.strictEqual(m.delivery.avgDaysLate, 4)
  assert.strictEqual(m.delivery.avgTransitDays, 5) // (7 + 8 + 0) / 3
})

test('says nothing rather than 100% when no job can be judged', () => {
  const m = deriveMovementMetrics([{ job_number:'X', status:'New', sale:100, cost:50 }])
  assert.strictEqual(m.delivery.judged, 0)
  assert.strictEqual(m.delivery.onTimeRate, 0)
  assert.strictEqual(m.delivery.avgTransitDays, null)
})

// ── risk ──────────────────────────────────────────────────────────────────────

test('flags customer concentration', () => {
  const m = deriveMovementMetrics(JOBS)
  assert.strictEqual(m.risk.topCustomerName, 'Amandari')
  assert.strictEqual(m.risk.topCustomerShare, 66.7) // 14000 of 21000
})

test('flags revenue with no cost recorded against it', () => {
  const m = deriveMovementMetrics(JOBS)
  assert.strictEqual(m.risk.missingCosting, 1)
  assert.strictEqual(m.risk.missingCostingValue, 5000)
})

// ── breakdowns ────────────────────────────────────────────────────────────────

test('breaks revenue down by mode with its own margin', () => {
  const m = deriveMovementMetrics(JOBS)
  const fcl = m.byMode.find(x => x.key === 'Sea FCL')
  assert.strictEqual(fcl.jobs, 2, 'the voided FCL job is excluded')
  assert.strictEqual(fcl.value, 14000)
  // (14000 - 6500) / 14000. Inflated by ZHL-003 carrying revenue with no cost yet,
  // which is exactly what the missingCosting figure exists to warn about.
  assert.strictEqual(fcl.gpPercent, 53.6)
})

test('attributes jobs to salesperson, falling back to unassigned', () => {
  const m = deriveMovementMetrics(JOBS)
  assert.strictEqual(m.byTeam[0].key, 'brandon@zhenghe.com.sg')
  assert.ok(m.byTeam.some(t => t.key === 'Unassigned'))
})

test('top jobs are ordered by revenue', () => {
  const m = deriveMovementMetrics(JOBS)
  assert.strictEqual(m.topJobs[0].job_number, 'ZHL-001/26')
  assert.ok(!m.topJobs.some(j => j.job_number === 'ZHL-005/26'), 'voided job never appears')
})

// ── trend ─────────────────────────────────────────────────────────────────────

test('buckets a longer period into months in order', () => {
  const t = deriveTrend([
    { status:'Completed', sale:100, cost:60, created_at:'2026-07-05T00:00:00Z' },
    { status:'Completed', sale:200, cost:100, created_at:'2026-08-05T00:00:00Z' },
    { status:'Completed', sale:300, cost:150, created_at:'2026-08-20T00:00:00Z' },
    { status:'Voided',    sale:999, cost:0,   created_at:'2026-08-21T00:00:00Z' },
  ])
  assert.deepStrictEqual(t.map(x => x.month), ['2026-07', '2026-08'])
  assert.strictEqual(t[1].jobs, 2, 'voided excluded from the trend too')
  assert.strictEqual(t[1].sale, 500)
  assert.strictEqual(t[1].gpPercent, 50)
})

// ── degenerate input ──────────────────────────────────────────────────────────

test('an empty period produces zeros, never NaN', () => {
  const m = deriveMovementMetrics([])
  assert.strictEqual(m.volume.jobs, 0)
  assert.strictEqual(m.money.gpPercent, 0)
  assert.strictEqual(m.risk.topCustomerName, null)
  for (const v of Object.values(m.money)) assert.ok(!Number.isNaN(v))
})

test('NUMERIC values arriving as strings still add up', () => {
  const m = deriveMovementMetrics([
    { job_number:'A', status:'Completed', sale:'1500.50', cost:'500.25', weight:'100.5', cbm:'2.5' },
  ])
  assert.strictEqual(m.money.sale, 1500.5)
  assert.strictEqual(m.money.profit, 1000.25)
  assert.strictEqual(m.volume.weightKg, 100.5)
})

test('asDay ignores a time component and rejects junk', () => {
  assert.strictEqual(asDay('2026-08-14'), asDay('2026-08-14T18:30:00Z'))
  assert.strictEqual(asDay(''), null)
  assert.strictEqual(asDay('not-a-date'), null)
})
