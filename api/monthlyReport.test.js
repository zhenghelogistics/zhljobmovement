const test = require('node:test')
const assert = require('node:assert')
const { deriveLeadMetrics, deriveReengagementList, pct, median } = require('./monthlyReport')

const NOW = '2026-08-31T00:00:00.000Z'
const d = (iso) => new Date(iso).toISOString()

// A representative month: 2 won, 2 lost, 3 still open.
const LEADS = [
  { ref: 'ZL-1', customer_name: 'Acme',    quoted_price: 5000, status: 'Won',  stage: 'Won',
    industry: 'Manufacturing', source: 'website', service_type: 'Sea FCL',
    origin: 'Singapore', destination: 'Jakarta', commodity_name: 'Machinery',
    created_at: d('2026-08-01T00:00:00Z'), claimed_at: d('2026-08-01T02:00:00Z'), won_at: d('2026-08-11T00:00:00Z') },
  { ref: 'ZL-2', customer_name: 'Beta',    quoted_price: 3000, status: 'Won',  stage: 'Won',
    industry: 'Retail', source: 'website', service_type: 'Air Freight',
    origin: 'Singapore', destination: 'Hong Kong', commodity_name: 'Apparel',
    created_at: d('2026-08-02T00:00:00Z'), claimed_at: d('2026-08-02T04:00:00Z'), won_at: d('2026-08-08T00:00:00Z') },
  { ref: 'ZL-3', customer_name: 'Gamma',   quoted_price: 8000, status: 'Lost', stage: 'Lost',
    industry: 'Manufacturing', source: 'website', lost_reason: 'Transit time too long',
    origin: 'Singapore', destination: 'Jakarta',
    created_at: d('2026-08-03T00:00:00Z'), claimed_at: d('2026-08-03T01:00:00Z') },
  { ref: 'ZL-4', customer_name: 'Delta',   quoted_price: 2000, status: 'Lost', stage: 'Lost',
    industry: 'Retail', source: 'manual', lost_reason: 'Price',
    created_at: d('2026-08-04T00:00:00Z'), claimed_at: d('2026-08-04T03:00:00Z') },
  { ref: 'ZL-5', customer_name: 'Epsilon', quoted_price: 4000, status: 'Quoted', stage: 'Quoted',
    industry: 'Pharmaceuticals', source: 'website', claimed_by: 'a@zhenghe.com.sg',
    created_at: d('2026-08-20T00:00:00Z'), claimed_at: d('2026-08-20T01:00:00Z') },
  { ref: 'ZL-6', customer_name: 'Zeta',    quoted_price: 0, status: 'RFQ Received', stage: 'RFQ Received',
    industry: 'Retail', source: 'website',
    created_at: d('2026-08-01T00:00:00Z') },   // never claimed, 30 days old
  { ref: 'ZL-7', customer_name: 'Eta',     quoted_price: 0, status: 'RFQ Received', stage: 'RFQ Received',
    industry: '', source: 'website',
    created_at: d('2026-08-29T00:00:00Z') },   // never claimed, only 2 days old
]

// ── counts and rates ──────────────────────────────────────────────────────────

test('counts each stage of the funnel', () => {
  const m = deriveLeadMetrics(LEADS, { now: NOW })
  assert.strictEqual(m.counts.received, 7)
  assert.strictEqual(m.counts.won, 2)
  assert.strictEqual(m.counts.lost, 2)
  assert.strictEqual(m.counts.open, 3)
})

test('win rate is measured against closed deals, not everything received', () => {
  const m = deriveLeadMetrics(LEADS, { now: NOW })
  // 2 won of 4 closed. Dividing by all 7 would understate the team's performance
  // by counting deals that are still live as losses.
  assert.strictEqual(m.rates.winRate, 50)
  assert.strictEqual(m.rates.overallConversion, 28.6) // 2/7, reported separately
})

test('a lead that was quoted counts as quoted even after it closes', () => {
  const m = deriveLeadMetrics(LEADS, { now: NOW })
  assert.strictEqual(m.counts.quoted, 5) // 2 won + 2 lost + 1 open with a price
})

// ── money ─────────────────────────────────────────────────────────────────────

test('separates won, open and lost value', () => {
  const m = deriveLeadMetrics(LEADS, { now: NOW })
  assert.strictEqual(m.value.won, 8000)
  assert.strictEqual(m.value.open, 4000)
  assert.strictEqual(m.lostValue, 10000)
})

test('average deal size uses won deals only', () => {
  const m = deriveLeadMetrics(LEADS, { now: NOW })
  assert.strictEqual(m.value.avgWonDeal, 4000) // 8000 / 2
})

// ── speed ─────────────────────────────────────────────────────────────────────

test('measures how long leads waited to be picked up', () => {
  const m = deriveLeadMetrics(LEADS, { now: NOW })
  assert.strictEqual(m.speed.avgResponseHours, 2.2) // (2+4+1+3+1)/5
  assert.strictEqual(m.speed.medianResponseHours, 2)
})

test('median response resists a single forgotten lead', () => {
  const withOutlier = [...LEADS, {
    ref: 'ZL-8', quoted_price: 0, status: 'Quoted', stage: 'Quoted',
    created_at: d('2026-08-05T00:00:00Z'), claimed_at: d('2026-08-25T00:00:00Z'), // 480h
  }]
  const m = deriveLeadMetrics(withOutlier, { now: NOW })
  assert.ok(m.speed.avgResponseHours > 80, 'mean is dragged up by the outlier')
  assert.strictEqual(m.speed.medianResponseHours, 2.5, 'median stays representative')
})

test('sales cycle is measured only on deals that actually closed', () => {
  const m = deriveLeadMetrics(LEADS, { now: NOW })
  assert.strictEqual(m.speed.avgCycleDays, 8) // (10 + 6) / 2
})

test('flags unclaimed leads older than a fortnight, not recent ones', () => {
  const m = deriveLeadMetrics(LEADS, { now: NOW })
  assert.strictEqual(m.speed.unclaimed14d, 1) // ZL-6 only; ZL-7 is 2 days old
})

// ── breakdowns ────────────────────────────────────────────────────────────────

test('ranks breakdowns by value, biggest first', () => {
  const m = deriveLeadMetrics(LEADS, { now: NOW })
  assert.strictEqual(m.breakdown.byIndustry[0].key, 'Manufacturing') // 5000 + 8000
  assert.strictEqual(m.breakdown.byIndustry[0].value, 13000)
  assert.strictEqual(m.breakdown.byIndustry[0].count, 2)
})

test('groups trade lanes and skips leads with no route', () => {
  const m = deriveLeadMetrics(LEADS, { now: NOW })
  const jakarta = m.breakdown.byLane.find(x => x.key === 'Singapore to Jakarta')
  assert.strictEqual(jakarta.count, 2)
  assert.strictEqual(jakarta.value, 13000)
  assert.ok(!m.breakdown.byLane.some(x => x.key.includes('?')), 'no half-empty lanes')
})

test('blank fields are labelled rather than dropped or shown empty', () => {
  const m = deriveLeadMetrics(LEADS, { now: NOW })
  assert.ok(m.breakdown.byIndustry.some(x => x.key === 'Unspecified'))
})

// ── wins and losses ───────────────────────────────────────────────────────────

test('top wins are ordered by value', () => {
  const m = deriveLeadMetrics(LEADS, { now: NOW })
  assert.deepStrictEqual(m.topWins.map(w => w.ref), ['ZL-1', 'ZL-2'])
  assert.strictEqual(m.topWins[0].lane, 'Singapore to Jakarta')
})

test('lost reasons are passed through as raw text for clustering', () => {
  const m = deriveLeadMetrics(LEADS, { now: NOW })
  assert.strictEqual(m.lostReasons.length, 2)
  assert.ok(m.lostReasons.some(r => r.reason === 'Transit time too long'))
})

test('a lost lead with no stated reason is omitted rather than shown blank', () => {
  const m = deriveLeadMetrics([
    { ref: 'X', status: 'Lost', stage: 'Lost', quoted_price: 100, created_at: d('2026-08-01T00:00:00Z') },
  ], { now: NOW })
  assert.strictEqual(m.lostReasons.length, 0)
  assert.strictEqual(m.counts.lost, 1, 'still counted as a loss')
})

// ── re-engagement ─────────────────────────────────────────────────────────────

test('re-engagement list favours value and requires a way to make contact', () => {
  const out = deriveReengagementList([
    { ref: 'D1', customer_name: 'Big',   quoted_price: 9000, customer_email: 'a@x.com', dormant_at: d('2026-07-01T00:00:00Z') },
    { ref: 'D2', customer_name: 'Small', quoted_price: 100,  phone_number: '+65', dormant_at: d('2026-07-02T00:00:00Z') },
    { ref: 'D3', customer_name: 'NoWay', quoted_price: 5000 },                       // unreachable
    { ref: 'D4', customer_name: 'Closed', quoted_price: 7000, customer_email: 'b@x.com', status: 'Won' },
  ])
  assert.deepStrictEqual(out.map(x => x.ref), ['D1', 'D2'])
})

// ── degenerate input ──────────────────────────────────────────────────────────

test('an empty month produces zeros, never NaN', () => {
  const m = deriveLeadMetrics([], { now: NOW })
  assert.strictEqual(m.counts.received, 0)
  assert.strictEqual(m.rates.winRate, 0)
  assert.strictEqual(m.value.avgWonDeal, 0)
  assert.strictEqual(m.speed.avgResponseHours, null) // absent, not a misleading 0
  for (const v of Object.values(m.rates)) assert.ok(!Number.isNaN(v))
})

test('NUMERIC prices arriving as strings still add up', () => {
  const m = deriveLeadMetrics([
    { ref: 'A', status: 'Won', stage: 'Won', quoted_price: '1500.50', created_at: d('2026-08-01T00:00:00Z') },
    { ref: 'B', status: 'Won', stage: 'Won', quoted_price: '2499.50', created_at: d('2026-08-01T00:00:00Z') },
  ], { now: NOW })
  assert.strictEqual(m.value.won, 4000)
})

test('helpers guard division by zero', () => {
  assert.strictEqual(pct(5, 0), 0)
  assert.strictEqual(median([]), 0)
  assert.strictEqual(median([3, 1, 2]), 2)
})
