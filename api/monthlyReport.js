// Metrics for the monthly BD report, kept as pure functions so every figure that goes
// in front of leadership is unit-tested — same approach as rateCalc.js and
// splitInvoicing.js. The route handler does the querying; this file only does maths.
//
// Deliberately computed here rather than in SQL: a month's leads are a small set
// (tens, not millions), and having the raw rows in JS makes derived figures like
// response time, sales-cycle length and lane concentration testable without a
// database, which a pile of GROUP BY clauses would not be.

const HOUR = 1000 * 60 * 60
const DAY = HOUR * 24

const num = (v) => {
  if (v === null || v === undefined || v === '') return 0
  const n = typeof v === 'number' ? v : parseFloat(v)
  return Number.isFinite(n) ? n : 0
}

const isWon = (l) => l.status === 'Won' || l.stage === 'Won' || l.converted_job_id != null
const isLost = (l) => l.status === 'Lost' || l.stage === 'Lost'
// "Quoted" means a price actually went out, whether or not it closed. Won and Lost
// both imply we quoted, so they count too.
const wasQuoted = (l) => isWon(l) || isLost(l) || num(l.quoted_price) > 0 ||
  ['Quoted', 'Negotiating', 'Follow-Up'].includes(l.stage)

function pct(part, whole) {
  if (!whole) return 0
  return Math.round((part / whole) * 1000) / 10   // one decimal
}

function median(xs) {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

// Groups rows by a key, sums their value, and returns the biggest first. Used for
// every "top N" breakdown so they all behave identically.
function rank(rows, keyFn, { valueFn = () => 0, limit = 8, label = 'Unspecified' } = {}) {
  const acc = new Map()
  for (const r of rows) {
    const raw = keyFn(r)
    const key = (raw == null || String(raw).trim() === '') ? label : String(raw).trim()
    const cur = acc.get(key) || { key, count: 0, value: 0 }
    cur.count++
    cur.value += num(valueFn(r))
    acc.set(key, cur)
  }
  return [...acc.values()]
    .sort((a, b) => b.value - a.value || b.count - a.count)
    .slice(0, limit)
    .map(x => ({ ...x, value: Math.round(x.value * 100) / 100 }))
}

/**
 * Everything the deck needs about a month's leads.
 * @param leads rows from the leads table created within the month
 * @param opts.now used by the aging calculation; injectable so tests are deterministic
 */
function deriveLeadMetrics(leads = [], opts = {}) {
  const now = opts.now ? new Date(opts.now) : new Date()

  const won = leads.filter(isWon)
  const lost = leads.filter(isLost)
  const quoted = leads.filter(wasQuoted)
  const open = leads.filter(l => !isWon(l) && !isLost(l))

  const wonValue = won.reduce((s, l) => s + num(l.quoted_price), 0)
  const quotedValue = quoted.reduce((s, l) => s + num(l.quoted_price), 0)
  const openValue = open.reduce((s, l) => s + num(l.quoted_price), 0)

  // How long a lead waited before someone took ownership. This is the number that
  // tends to predict winning, and nobody looks at it.
  const responseHours = leads
    .filter(l => l.claimed_at && l.created_at)
    .map(l => (new Date(l.claimed_at) - new Date(l.created_at)) / HOUR)
    .filter(h => h >= 0)

  // Time from enquiry to closing it. Only won deals have a meaningful end date.
  const cycleDays = won
    .filter(l => l.won_at && l.created_at)
    .map(l => (new Date(l.won_at) - new Date(l.created_at)) / DAY)
    .filter(d => d >= 0)

  const stale = leads.filter(l =>
    !isWon(l) && !isLost(l) && !l.claimed_by &&
    (now - new Date(l.created_at)) / DAY >= 14)

  return {
    counts: {
      received: leads.length,
      quoted: quoted.length,
      won: won.length,
      lost: lost.length,
      open: open.length,
    },
    rates: {
      // of everything received, how much got a price out
      quoteRate: pct(quoted.length, leads.length),
      // of everything quoted, how much closed — the number leadership asks about
      winRate: pct(won.length, won.length + lost.length),
      // end to end, enquiry to win
      overallConversion: pct(won.length, leads.length),
    },
    value: {
      quoted: Math.round(quotedValue * 100) / 100,
      won: Math.round(wonValue * 100) / 100,
      open: Math.round(openValue * 100) / 100,
      avgWonDeal: won.length ? Math.round((wonValue / won.length) * 100) / 100 : 0,
    },
    speed: {
      avgResponseHours: responseHours.length
        ? Math.round((responseHours.reduce((a, b) => a + b, 0) / responseHours.length) * 10) / 10 : null,
      // median matters more than mean here: one lead forgotten over a long weekend
      // drags the average somewhere unrepresentative
      medianResponseHours: responseHours.length ? Math.round(median(responseHours) * 10) / 10 : null,
      avgCycleDays: cycleDays.length
        ? Math.round((cycleDays.reduce((a, b) => a + b, 0) / cycleDays.length) * 10) / 10 : null,
      unclaimed14d: stale.length,
    },
    breakdown: {
      byIndustry: rank(leads, l => l.industry, { valueFn: l => l.quoted_price }),
      bySource: rank(leads, l => l.source, { valueFn: l => l.quoted_price, label: 'Direct' }),
      byServiceType: rank(leads, l => l.service_type || l.load_type || l.simple_mode, { valueFn: l => l.quoted_price }),
      byLane: rank(
        leads.filter(l => l.origin || l.destination),
        l => `${(l.origin || '?').trim()} to ${(l.destination || '?').trim()}`,
        { valueFn: l => l.quoted_price, limit: 6 }
      ),
      byCommodity: rank(leads, l => l.commodity_name, { valueFn: l => l.quoted_price, limit: 6 }),
    },
    topWins: won
      .slice()
      .sort((a, b) => num(b.quoted_price) - num(a.quoted_price))
      .slice(0, 6)
      .map(l => ({
        ref: l.ref, customer: l.customer_name || l.contact_person || 'Unnamed',
        value: num(l.quoted_price), industry: l.industry || '',
        lane: l.origin && l.destination ? `${l.origin} to ${l.destination}` : '',
      })),
    // Raw text, deliberately not pre-bucketed: these are free-form and clustering them
    // into themes is the one part of this report a language model does better than SQL.
    lostReasons: lost
      .map(l => ({
        ref: l.ref,
        customer: l.customer_name || '',
        value: num(l.quoted_price),
        reason: (l.lost_reason || '').trim(),
      }))
      .filter(x => x.reason),
    lostValue: Math.round(lost.reduce((s, l) => s + num(l.quoted_price), 0) * 100) / 100,
  }
}

/**
 * Leads that went quiet and are worth another call. Drawn from the dormant pool the
 * nightly sweep archives, which otherwise nobody ever looks at again.
 */
function deriveReengagementList(dormantLeads = [], limit = 10) {
  return dormantLeads
    .filter(l => !isWon(l) && (l.customer_email || l.phone_number))
    .sort((a, b) => num(b.quoted_price) - num(a.quoted_price))
    .slice(0, limit)
    .map(l => ({
      ref: l.ref,
      customer: l.customer_name || l.contact_person || 'Unnamed',
      value: num(l.quoted_price),
      wentQuiet: l.dormant_at || l.created_at,
      lane: l.origin && l.destination ? `${l.origin} to ${l.destination}` : '',
    }))
}

module.exports = { deriveLeadMetrics, deriveReengagementList, rank, pct, median }
