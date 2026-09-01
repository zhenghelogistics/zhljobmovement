require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool, types: pgTypes } = require('pg');
const Anthropic = require('@anthropic-ai/sdk');
const multer = require('multer');
const { mapLeadToJobFields } = require('./leadConversion');
const { extractCargoLines } = require('./cargoLines');
const { deriveMetrics, computeRateAmount } = require('./rateCalc');
const { deriveLeadMetrics, deriveReengagementList } = require('./monthlyReport');
const { periodWindow, deriveMovementMetrics, deriveTrend } = require('./movementReport');
const app = express();

// Return NUMERIC/DECIMAL (type OID 1700) as a JS number instead of a string.
//
// node-postgres hands NUMERIC back as a string by default, because NUMERIC is
// arbitrary-precision and a JS double cannot represent every possible value. That is
// the right default in general — but it silently broke this app when the money columns
// were migrated REAL -> NUMERIC(14,4): REAL came back as a number, NUMERIC comes back
// as a string, and every `sum + line.amount` in the frontend started concatenating
// strings ("0" + "123.45" + "466.75" = "0123.45466.75" -> NaN). Multiplication still
// coerced, so sale totals looked fine while cost totals showed $NaN — including on
// customer-facing invoice PDFs.
//
// A double is comfortably exact for NUMERIC(14,4) money (14 digits < 2^53) and is
// strictly more precise than the REAL these columns used to be, so nothing is lost
// versus the pre-migration behaviour. The DB still stores and SUMs them exactly, which
// was the point of the migration.
pgTypes.setTypeParser(pgTypes.builtins.NUMERIC, parseFloat);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 2,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 5000,
});

// ─── REQUEST TIMING ──────────────────────────────────────────────────────────
// Answers "why did that feel slow?" with a number instead of a guess. Each request
// logs one line splitting its time into auth / database / everything else, so a slow
// page can be traced to the actual culprit from Vercel's function logs.
//
// AsyncLocalStorage is what makes this possible: pool.query is a single shared
// object, so there is no other way to attribute a query to the request that fired it.
const { AsyncLocalStorage } = require('async_hooks');
const reqCtx = new AsyncLocalStorage();

// Whether this specific function instance has served anything yet. A cold start pays
// for module load, the first DB connection and (on a schema change) the DDL, so it is
// worth knowing which timings are cold — they are the ones users notice.
let _servedARequest = false;

// Wrap pool.query so every query is counted and timed against the current request.
const _poolQuery = pool.query.bind(pool);
pool.query = function (...args) {
  const ctx = reqCtx.getStore();
  if (!ctx) return _poolQuery(...args);           // startup/cron work, outside a request
  const t0 = process.hrtime.bigint();
  ctx.dbCount++;
  const out = _poolQuery(...args);
  if (out && typeof out.then === 'function') {
    return out.finally(() => { ctx.dbMs += Number(process.hrtime.bigint() - t0) / 1e6; });
  }
  return out;                                      // callback style, not used here
};

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// claude-sonnet-5 runs adaptive thinking by default, so content[0] may be a
// thinking block rather than text — find the actual text block instead of
// assuming position.
function getResponseText(msg) {
  const block = msg.content.find(b => b.type === 'text');
  return block ? block.text : '';
}

// Memory storage — no disk in serverless
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// ─── AUTH MIDDLEWARE ─────────────────────────────────────────────────────────
const SUPABASE_URL = 'https://wwaupgxlzardsrxikuvj.supabase.co'

// Validated sessions, cached in the function instance's memory.
//
// Every authenticated request used to make its own outbound HTTPS call to Supabase
// to ask "is this token still good?" — so opening a page that fires five API calls
// paid five round-trips to a third-party service before a single row was read. That
// is the largest single source of latency in the app.
//
// Caching the ANSWER is safe in a way that verifying the token ourselves is not: we
// still rely entirely on Supabase's verdict, we just remember it briefly. The cost
// is that a session revoked mid-window stays usable until the entry expires, so the
// window is deliberately short and is also capped by the token's own expiry.
const AUTH_CACHE_TTL_MS = 60_000
const AUTH_CACHE_MAX = 500
const authCache = new Map()

// Read a JWT's own expiry without verifying it. Used ONLY to shorten the cache
// window, never to decide whether a token is valid — an attacker editing this claim
// could make us cache for less time, which is harmless.
function tokenExpiryMs(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString())
    return payload.exp ? payload.exp * 1000 : null
  } catch { return null }
}

async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) return res.status(401).json({ error: 'Unauthorized — no token' })

  const now = Date.now()
  const timing = reqCtx.getStore()
  const authStart = process.hrtime.bigint()
  const recordAuth = (source) => {
    if (!timing) return
    timing.authMs += Number(process.hrtime.bigint() - authStart) / 1e6
    timing.authSource = source
  }

  const hit = authCache.get(token)
  if (hit && hit.expiresAt > now) {
    req.user = hit.user
    recordAuth('cached')
    return next()
  }
  if (hit) authCache.delete(token)

  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'apikey': process.env.SUPABASE_SERVICE_KEY
      }
    })
    if (!r.ok) { recordAuth('remote'); return res.status(401).json({ error: 'Unauthorized — invalid or expired session' }) }
    const user = await r.json()
    if (!user.email?.toLowerCase().endsWith('@zhenghe.com.sg')) {
      return res.status(403).json({ error: 'Forbidden — company account required' })
    }

    // Simple size cap so a long-lived warm instance can't grow this without bound.
    if (authCache.size >= AUTH_CACHE_MAX) authCache.clear()
    const exp = tokenExpiryMs(token)
    authCache.set(token, {
      user,
      expiresAt: Math.min(now + AUTH_CACHE_TTL_MS, exp ?? Infinity),
    })

    req.user = user
    recordAuth('remote')
    next()
  } catch (e) {
    recordAuth('remote-failed')
    console.error('[ZHL] requireAuth error:', e.message)
    res.status(401).json({ error: 'Unauthorized' })
  }
}

// ─── DB INIT (lazy, once per cold start) ────────────────────────────────────
let _dbReady = false;
let _dbPromise = null;

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS jobs (
      id SERIAL PRIMARY KEY,
      job_number TEXT UNIQUE NOT NULL,
      year INTEGER NOT NULL,
      sequence INTEGER NOT NULL,
      shipper TEXT DEFAULT '',
      consignee TEXT DEFAULT '',
      weight REAL,
      packages INTEGER,
      dimensions TEXT DEFAULT '',
      cbm REAL,
      pickup_address TEXT DEFAULT '',
      pickup_contact_name TEXT DEFAULT '',
      pickup_contact_number TEXT DEFAULT '',
      delivery_address TEXT DEFAULT '',
      delivery_contact_name TEXT DEFAULT '',
      delivery_contact_number TEXT DEFAULT '',
      date_out TEXT,
      date_delivered TEXT,
      agent TEXT DEFAULT '',
      mode TEXT DEFAULT 'Local Delivery',
      status TEXT DEFAULT 'New',
      customer_ref TEXT DEFAULT '',
      deadline_date TEXT,
      commodity TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      gp_override REAL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS customer_name TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS customer_contact_name TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS customer_contact_number TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS customer_email TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS void_reason TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS zhl_invoice_no TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS created_by TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS salesperson TEXT DEFAULT ''`);
  // The company a driver collects FROM, which is not always the shipper — cargo is
  // often staged at a third party (a supplier, a warehouse, a forwarder's dock), and
  // the Pickup Request Order has to name that place, not the shipper of record.
  await pool.query(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS pickup_company TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE billing_lines ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'SGD'`);
  await pool.query(`ALTER TABLE billing_lines ADD COLUMN IF NOT EXISTS rate_local REAL`);
  await pool.query(`ALTER TABLE cost_lines ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'SGD'`);
  await pool.query(`ALTER TABLE cost_lines ADD COLUMN IF NOT EXISTS amount_local REAL`);
  await pool.query(`ALTER TABLE cost_lines ADD COLUMN IF NOT EXISTS total_payable REAL`);
  await pool.query(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS inventory_movement_id TEXT DEFAULT NULL`);
  await pool.query(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS eta TEXT DEFAULT NULL`);
  await pool.query(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS inventory_movement_no TEXT DEFAULT NULL`);
  await pool.query(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS packing_list_items JSONB DEFAULT '[]'`);
  await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS next_follow_up TIMESTAMP`);
  await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS is_archived BOOLEAN DEFAULT FALSE`);
  await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS claimed_by TEXT`);
  await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMP`);
  await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS follow_up_note TEXT`);
  await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS lost_reason TEXT`);
  await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS quote_ref TEXT`);
  await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS source_ref TEXT`);
  // Structured RFQ fields — captured from the estimator webhook as separate columns
  // instead of only being baked into the free-text `notes` blob, so a lead can later
  // be converted into a job without a human having to re-type or re-parse anything.
  await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS contact_person TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS phone_number TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS simple_mode TEXT DEFAULT ''`); // 'SEA' or 'AIR'
  await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS load_type TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS origin TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS destination TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS service_type TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS incoterm TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS container_size TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS lead_dimensions TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS commodity_name TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS hs_code TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS lead_quantity TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS lead_weight TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS packaging_type TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS pickup_address TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS delivery_address TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS special_handling_notes TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS addons TEXT DEFAULT ''`);
  // Itemized cargo lines for multi-cargo-type quotes (e.g. LCL + a container + a reefer
  // in one booking) — see extractCargoLines(). Empty array for single-cargo leads.
  await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS cargo_lines JSONB DEFAULT '[]'::jsonb`);
  // Set once this lead has been turned into a real job — blocks converting twice.
  await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS converted_job_id INTEGER REFERENCES jobs(id)`);
  // Indexes for leads — the app had zero indexes anywhere, so GET /api/leads (filters on
  // is_archived, sorts by created_at) and the RFQ dedup check (filters on source_ref) were
  // both doing a full sequential scan on every call, which gets slower as the table grows.
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_leads_active_created ON leads (created_at DESC) WHERE (is_archived IS NULL OR is_archived = FALSE)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_leads_status ON leads (status)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_leads_source_ref ON leads (source_ref) WHERE source_ref IS NOT NULL`);
  // jobs/cost_lines/billing_lines had zero indexes beyond primary keys — job_id is joined/
  // grouped on constantly (enrichJob, dashboard, company stats) and status/mode/created_at
  // are filtered on every list view, same class of slowness the leads table had.
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs (status)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_jobs_mode ON jobs (mode)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs (created_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cost_lines_job_id ON cost_lines (job_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_billing_lines_job_id ON billing_lines (job_id)`);
  // Tracks when a lead actually turned into a won deal, so "won this month" can be based
  // on the real close date instead of the lead's original creation date (a deal that took
  // 6 weeks to close was previously excluded from every month's count).
  await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS won_at TIMESTAMP`);
  // Stamped when the nightly job archives a stale lead. Kept separate from created_at so
  // the team can tell how long a lead has been dormant and run "still need this shipped?"
  // follow-up campaigns off it. Leads archived by hand (via the lead card) leave this null.
  await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS dormant_at TIMESTAMP`);
  // Money/quantity columns were REAL (single-precision float, ~7 significant digits) —
  // switched to NUMERIC so amounts don't accumulate floating-point rounding error on
  // large sums (a real risk for a billing/invoicing system where totals must tie out
  // to the cent). ALTER COLUMN TYPE is safe/idempotent to re-run — Postgres skips the
  // rewrite once a column is already the target type.
  await pool.query(`ALTER TABLE jobs ALTER COLUMN weight TYPE NUMERIC(14,4)`);
  await pool.query(`ALTER TABLE jobs ALTER COLUMN cbm TYPE NUMERIC(14,4)`);
  await pool.query(`ALTER TABLE jobs ALTER COLUMN gp_override TYPE NUMERIC(14,4)`);
  await pool.query(`ALTER TABLE leads ALTER COLUMN quoted_price TYPE NUMERIC(14,4)`);
  await pool.query(`ALTER TABLE fx_rates ALTER COLUMN rate TYPE NUMERIC(14,6)`);
  await pool.query(`ALTER TABLE cost_lines ALTER COLUMN amount TYPE NUMERIC(14,4)`);
  await pool.query(`ALTER TABLE cost_lines ALTER COLUMN amount_local TYPE NUMERIC(14,4)`);
  await pool.query(`ALTER TABLE cost_lines ALTER COLUMN total_payable TYPE NUMERIC(14,4)`);
  await pool.query(`ALTER TABLE billing_lines ALTER COLUMN rate TYPE NUMERIC(14,4)`);
  await pool.query(`ALTER TABLE billing_lines ALTER COLUMN qty TYPE NUMERIC(14,4)`);
  await pool.query(`ALTER TABLE billing_lines ALTER COLUMN rate_local TYPE NUMERIC(14,4)`);
  await pool.query(`ALTER TABLE split_entities ALTER COLUMN default_share TYPE NUMERIC(14,4)`);
  await pool.query(`ALTER TABLE billing_line_splits ALTER COLUMN amount TYPE NUMERIC(14,4)`);
  await pool.query(`ALTER TABLE cost_line_splits ALTER COLUMN amount TYPE NUMERIC(14,4)`);
  await pool.query(`ALTER TABLE fx_rates ADD COLUMN IF NOT EXISTS is_manual BOOLEAN DEFAULT FALSE`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_profiles (
      email         TEXT PRIMARY KEY,
      display_name  TEXT DEFAULT '',
      designation   TEXT DEFAULT '',
      signature_data TEXT DEFAULT '',
      updated_at    TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS marketing_contacts (
      id            SERIAL PRIMARY KEY,
      email         TEXT NOT NULL,
      customer_name TEXT DEFAULT '',
      industry      TEXT DEFAULT '',
      source        TEXT DEFAULT '',
      lead_ref      TEXT DEFAULT '',
      archived_at   TIMESTAMP DEFAULT NOW(),
      UNIQUE(email)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS leads (
      id            SERIAL PRIMARY KEY,
      ref           TEXT UNIQUE NOT NULL,
      customer_name TEXT DEFAULT '',
      customer_email TEXT DEFAULT '',
      quoted_price  REAL DEFAULT 0,
      industry      TEXT DEFAULT '',
      lead_score    INTEGER DEFAULT 5,
      status        TEXT DEFAULT '',
      stage         TEXT DEFAULT '',
      risk_level    TEXT DEFAULT '',
      source        TEXT DEFAULT '',
      notes         TEXT DEFAULT '',
      created_at    TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fx_rates (
      currency TEXT PRIMARY KEY,
      rate REAL NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW(),
      updated_by TEXT DEFAULT ''
    )
  `);
  await pool.query(`
    INSERT INTO fx_rates (currency, rate) VALUES
      ('USD', 0.745), ('IDR', 11900), ('EUR', 0.688),
      ('CNY', 5.35), ('MYR', 3.35), ('HKD', 5.8), ('THB', 26.5),
      ('VND', 18500), ('INR', 63), ('JPY', 112), ('GBP', 0.58),
      ('AUD', 1.12), ('KRW', 1010), ('PHP', 43), ('TWD', 23.5), ('AED', 2.74)
    ON CONFLICT (currency) DO NOTHING
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cost_lines (
      id SERIAL PRIMARY KEY,
      job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      vendor TEXT DEFAULT '',
      amount REAL DEFAULT 0,
      invoice_no TEXT DEFAULT '',
      invoice_date TEXT,
      service TEXT DEFAULT '',
      remarks TEXT DEFAULT ''
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS billing_lines (
      id SERIAL PRIMARY KEY,
      job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      service TEXT DEFAULT '',
      unit TEXT DEFAULT '',
      rate REAL DEFAULT 0,
      qty REAL DEFAULT 1,
      remarks TEXT DEFAULT ''
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS split_entities (
      id SERIAL PRIMARY KEY,
      job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      name TEXT NOT NULL DEFAULT '',
      billing_address TEXT DEFAULT '',
      contact_name TEXT DEFAULT '',
      contact_number TEXT DEFAULT '',
      contact_email TEXT DEFAULT '',
      invoice_no TEXT DEFAULT '',
      default_share REAL DEFAULT 1,
      sort_order INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS billing_line_splits (
      id SERIAL PRIMARY KEY,
      job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      billing_line_id INTEGER NOT NULL REFERENCES billing_lines(id) ON DELETE CASCADE,
      entity_id INTEGER NOT NULL REFERENCES split_entities(id) ON DELETE CASCADE,
      amount REAL NOT NULL DEFAULT 0,
      UNIQUE(billing_line_id, entity_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cost_line_splits (
      id SERIAL PRIMARY KEY,
      job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      cost_line_id INTEGER NOT NULL REFERENCES cost_lines(id) ON DELETE CASCADE,
      entity_id INTEGER NOT NULL REFERENCES split_entities(id) ON DELETE CASCADE,
      amount REAL NOT NULL DEFAULT 0,
      UNIQUE(cost_line_id, entity_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS documents (
      id SERIAL PRIMARY KEY,
      job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      file_name TEXT NOT NULL,
      doc_type TEXT DEFAULT 'Other',
      upload_date TIMESTAMP DEFAULT NOW(),
      file_url TEXT NOT NULL
    )
  `);
  // Atomic per-year counter for job numbers — generateJobNumber() used to read
  // MAX(sequence) and add 1 in application code, which two concurrent job creations
  // could both read before either wrote, producing a duplicate job_number. This table
  // + an INSERT ... ON CONFLICT DO UPDATE ... RETURNING makes the increment atomic.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS job_number_counters (
      year INTEGER PRIMARY KEY,
      seq INTEGER NOT NULL DEFAULT 0
    )
  `);
  // Backfill/reconcile from existing jobs on every startup so the counter is never
  // behind the highest sequence already in use (safe to re-run — GREATEST never lowers it).
  await pool.query(`
    INSERT INTO job_number_counters (year, seq)
    SELECT year, MAX(sequence) FROM jobs GROUP BY year
    ON CONFLICT (year) DO UPDATE SET seq = GREATEST(job_number_counters.seq, EXCLUDED.seq)
  `);

  // Vendor rate cards — the negotiated rates partners give us, kept in the app so
  // coordinators stop re-keying them off a PDF. One card per vendor per freight mode
  // (e.g. Quality Transport for Air, Cargohub for Sea); the mode is what decides which
  // card gets offered on a given job.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rate_cards (
      id SERIAL PRIMARY KEY,
      vendor_name TEXT NOT NULL,
      title TEXT DEFAULT '',
      mode TEXT DEFAULT '',
      currency TEXT DEFAULT 'SGD',
      volumetric_divisor NUMERIC(10,2),
      valid_from TEXT,
      valid_to TEXT,
      notes TEXT DEFAULT '',
      source_file_url TEXT DEFAULT '',
      is_active BOOLEAN DEFAULT TRUE,
      created_by TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  // The individual charges on a card. `bands` holds weight/count tiers as JSONB
  // ([{from,to,amount,basis}]) because a tier can carry its own basis — real cards
  // switch the top tier from a flat amount to a per-kg rate. Same JSONB-for-line-items
  // approach already used by leads.cargo_lines and jobs.packing_list_items.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rate_lines (
      id SERIAL PRIMARY KEY,
      card_id INTEGER NOT NULL REFERENCES rate_cards(id) ON DELETE CASCADE,
      charge_name TEXT NOT NULL DEFAULT '',
      category TEXT DEFAULT 'optional',
      basis TEXT DEFAULT 'flat',
      rate NUMERIC(14,4),
      min_charge NUMERIC(14,4),
      min_qty NUMERIC(14,4),
      bands JSONB,
      band_metric TEXT,
      currency TEXT,
      auto_apply BOOLEAN DEFAULT FALSE,
      condition_note TEXT DEFAULT '',
      remarks TEXT DEFAULT '',
      sort_order INTEGER DEFAULT 0
    )
  `);
  // Files a customer sends with their enquiry — packing lists, commercial invoices,
  // product photos. Mirrors the `documents` table used by jobs, and the files live in
  // the same Supabase Storage bucket, so a lead's paperwork can be carried straight
  // onto the job when the deal is won rather than being re-sent by the customer.
  // `source` records how it arrived ('website' | 'manual') because a file the customer
  // attached themselves carries different weight to one a colleague typed in later.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lead_documents (
      id SERIAL PRIMARY KEY,
      lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      file_name TEXT NOT NULL,
      doc_type TEXT DEFAULT 'Other',
      file_url TEXT NOT NULL,
      source TEXT DEFAULT 'manual',
      uploaded_by TEXT DEFAULT '',
      upload_date TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_lead_documents_lead_id ON lead_documents (lead_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_rate_lines_card_id ON rate_lines (card_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_rate_cards_lookup ON rate_cards (is_active, mode)`);
}

// initDB() is ~90 sequential statements. They are all idempotent, but they are also
// 90 separate round-trips to Postgres, and they run in front of the first request
// after every cold start — which is exactly when the app already feels slowest.
//
// So we fingerprint the DDL and record it in the database. If the fingerprint still
// matches, the schema is already what this build expects and all 90 statements are
// skipped in favour of a single SELECT. The fingerprint is derived from the source of
// initDB itself, so it updates automatically whenever the schema changes — there is
// no version number for anyone to forget to bump.
const DDL_FINGERPRINT = require('crypto')
  .createHash('sha1').update(initDB.toString()).digest('hex')

async function runSchema() {
  try {
    const r = await pool.query(`SELECT value FROM schema_meta WHERE key = 'ddl_fingerprint'`)
    if (r.rows[0]?.value === DDL_FINGERPRINT) return  // already current, nothing to do
  } catch {
    // schema_meta doesn't exist yet (first deploy against this database) — fall
    // through and build everything.
  }

  await initDB()

  await pool.query(`CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`)
  await pool.query(
    `INSERT INTO schema_meta (key, value) VALUES ('ddl_fingerprint', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [DDL_FINGERPRINT]
  )
  console.log(`[ZHL] schema applied, fingerprint ${DDL_FINGERPRINT.slice(0, 8)}`)
}

async function ensureDB() {
  if (_dbReady) return;
  if (!_dbPromise) _dbPromise = runSchema().then(() => { _dbReady = true; });
  await _dbPromise;
}

// ─── HELPERS ────────────────────────────────────────────────────────────────
async function enrichJob(job) {
  const [costs, billing] = await Promise.all([
    pool.query('SELECT COALESCE(SUM(amount),0) as total FROM cost_lines WHERE job_id=$1', [job.id]),
    pool.query('SELECT COALESCE(SUM(rate*qty),0) as total FROM billing_lines WHERE job_id=$1', [job.id]),
  ]);
  const cost_sgd = parseFloat(Number(costs.rows[0].total || 0).toFixed(2));
  const sale_sgd = parseFloat(Number(billing.rows[0].total || 0).toFixed(2));
  const profit_sgd = parseFloat((sale_sgd - cost_sgd).toFixed(2));
  const computed_gp = sale_sgd > 0 ? parseFloat(((profit_sgd / sale_sgd) * 100).toFixed(1)) : 0;
  const gp_percent = job.gp_override != null ? parseFloat(Number(job.gp_override).toFixed(1)) : computed_gp;
  return { ...job, cost_sgd, sale_sgd, profit_sgd, gp_percent, computed_gp };
}

async function generateJobNumber() {
  const year = new Date().getFullYear() % 100;
  // Atomic increment — INSERT ... ON CONFLICT DO UPDATE ... RETURNING is a single
  // statement Postgres serializes at the row level, so two concurrent calls can never
  // both receive the same seq (unlike the old read-MAX-then-add-1 approach).
  const result = await pool.query(
    `INSERT INTO job_number_counters (year, seq) VALUES ($1, 1)
     ON CONFLICT (year) DO UPDATE SET seq = job_number_counters.seq + 1
     RETURNING seq`,
    [year]
  );
  const seq = result.rows[0].seq;
  const job_number = `ZHL-${String(seq).padStart(3, '0')}/${String(year).padStart(2, '0')}`;
  return { job_number, year, sequence: seq };
}

let _bucketReady = false
async function ensureBucket() {
  if (_bucketReady) return
  const key = process.env.SUPABASE_SERVICE_KEY
  // Try to create the bucket — if it already exists Supabase returns a 409, which is fine
  await fetch(`${SUPABASE_URL}/storage/v1/bucket`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, apikey: key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'Documents', name: 'Documents', public: true })
  })
  _bucketReady = true
}

async function uploadToSupabaseStorage(buffer, filename, contentType) {
  const supabaseUrl = SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!key) throw new Error('SUPABASE_SERVICE_KEY not configured');
  await ensureBucket()

  const res = await fetch(`${supabaseUrl}/storage/v1/object/Documents/${filename}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      apikey: key,
      'Content-Type': contentType || 'application/octet-stream',
      'x-upsert': 'true'
    },
    body: buffer
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Storage upload failed: ${err}`);
  }
  return `${supabaseUrl}/storage/v1/object/public/Documents/${filename}`;
}

// ─── REMOTE ATTACHMENT FETCH ─────────────────────────────────────────────────
// Pulls a customer's attachment from a URL supplied by the public RFQ webhook and
// re-stores it in our own bucket, so the file survives whatever the sender's storage
// does later.
//
// This fetches a URL chosen by an unauthenticated caller, which is a server-side
// request forgery risk: without checks, anyone could point it at an address only our
// server can reach and use us as a proxy into private infrastructure. Hence the
// scheme check, the resolved-IP check on every redirect hop, and hard caps on size,
// hops and time.
const dnsp = require('dns').promises
const net = require('net')

// Larger than the ~4.5MB cap on the multipart upload routes, because that cap is
// Vercel's limit on an incoming request BODY and this path has no incoming body: we
// fetch the file ourselves, bounded only by function memory (1GB) and the 30s duration.
//
// Set to 10MB rather than higher because the binding constraint is not Vercel, it is
// our Supabase plan: the free tier allows 1GB of storage in TOTAL, shared with job
// documents. At 10MB a single worst-case attachment costs 1% of everything we have,
// which is a sane blast radius; at 25MB it would be 2.5%. 10MB still covers scanned
// packing lists and photos, which is what actually arrives. Raise this if the storage
// plan is ever upgraded.
const ATTACH_MAX_BYTES = 10 * 1024 * 1024
const ATTACH_MAX_FILES = 10
const ATTACH_HOP_LIMIT = 4
// Per-file and whole-batch ceilings, sized so a slow or oversized host can never push
// the webhook near the 30s function limit — a timeout there would look to the sender
// like a failed submission and risk a duplicate lead.
const ATTACH_TIMEOUT_MS = 15000
const ATTACH_TOTAL_BUDGET_MS = 22000

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number)
    return a === 0 || a === 10 || a === 127 ||
           (a === 172 && b >= 16 && b <= 31) ||
           (a === 192 && b === 168) ||
           (a === 169 && b === 254) ||
           a >= 224
  }
  const v = ip.toLowerCase().replace(/^\[|\]$/g, '')
  return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80')
}

async function assertPublicUrl(u) {
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(`unsupported scheme ${u.protocol}`)
  const { address } = await dnsp.lookup(u.hostname)
  if (isPrivateAddress(address)) throw new Error(`refusing to fetch private address ${address}`)
}

async function fetchAttachment(rawUrl) {
  let url
  try { url = new URL(rawUrl) } catch { throw new Error('not a valid URL') }

  // Follow redirects by hand so every hop is re-checked — following automatically
  // would let a public URL bounce us to an internal one.
  let res
  for (let hop = 0; ; hop++) {
    if (hop >= ATTACH_HOP_LIMIT) throw new Error('too many redirects')
    await assertPublicUrl(url)
    res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(ATTACH_TIMEOUT_MS) })
    const location = res.headers.get('location')
    if (res.status >= 300 && res.status < 400 && location) { url = new URL(location, url); continue }
    break
  }
  if (!res.ok) throw new Error(`responded ${res.status}`)

  const declared = Number(res.headers.get('content-length') || 0)
  if (declared > ATTACH_MAX_BYTES) throw new Error('file is too large')

  // Read incrementally and abort the moment it exceeds the cap, rather than trusting
  // content-length (which a sender can understate or omit).
  const reader = res.body.getReader()
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > ATTACH_MAX_BYTES) { await reader.cancel(); throw new Error('file is too large') }
    chunks.push(value)
  }

  return {
    buffer: Buffer.concat(chunks),
    contentType: (res.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim(),
    urlPath: url.pathname,
  }
}

// Accepts what the sending site actually gives us rather than demanding one shape:
// a bare URL string, or an object using any of the obvious key names.
function normaliseAttachments(body) {
  const raw = body.attachments || body.files || body.documents || []
  if (!Array.isArray(raw)) return []
  return raw.map(a => {
    if (typeof a === 'string') return { url: a, name: '' }
    if (a && typeof a === 'object') {
      return {
        url: a.url || a.href || a.link || a.file_url || a.downloadUrl || '',
        name: a.name || a.filename || a.file_name || a.title || '',
      }
    }
    return { url: '', name: '' }
  }).filter(a => a.url)
}

// Stores a lead's attachments, best-effort. An attachment that fails must never cost
// us the lead itself — a lost enquiry is far more expensive than a missing PDF, and
// the sender is unlikely to retry just because one file 404'd.
async function ingestLeadAttachments(leadId, items) {
  const deadline = Date.now() + ATTACH_TOTAL_BUDGET_MS
  const saved = []
  for (const item of items.slice(0, ATTACH_MAX_FILES)) {
    if (Date.now() > deadline) {
      console.error(`[ZHL] rfq attachments: budget exhausted, ${items.length - saved.length} not fetched for lead ${leadId}`)
      break
    }
    try {
      const { buffer, contentType, urlPath } = await fetchAttachment(item.url)
      const original = item.name || decodeURIComponent(urlPath.split('/').pop() || '') || 'attachment'
      const stored = `lead-${leadId}-${Date.now()}-${Math.round(Math.random() * 1e9)}-${original}`.replace(/\s+/g, '_')
      const file_url = await uploadToSupabaseStorage(buffer, stored, contentType)
      const r = await pool.query(
        `INSERT INTO lead_documents (lead_id, file_name, doc_type, file_url, source)
         VALUES ($1,$2,'Other',$3,'website') RETURNING *`,
        [leadId, original, file_url]
      )
      saved.push(r.rows[0])
    } catch (err) {
      console.error(`[ZHL] rfq attachment failed (${item.url}): ${err.message}`)
    }
  }
  return saved
}

// Deleting a job (or a single document) used to only remove the database row, leaving
// the actual uploaded file sitting in Supabase Storage forever — this cleans that up.
// Best-effort: a failure here is logged but never blocks the DB delete from succeeding,
// since an orphaned file is a minor cleanup issue, not a reason to fail the user's action.
async function deleteFromSupabaseStorage(fileUrl) {
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!key || !fileUrl) return;
  const marker = '/storage/v1/object/public/Documents/';
  const idx = fileUrl.indexOf(marker);
  if (idx === -1) return;
  const filename = fileUrl.slice(idx + marker.length);
  try {
    const res = await fetch(`${SUPABASE_URL}/storage/v1/object/Documents/${filename}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${key}`, apikey: key },
    });
    if (!res.ok) console.error(`[ZHL] Storage delete failed for ${filename}: ${res.status}`);
  } catch (e) {
    console.error('[ZHL] Storage delete error:', e.message);
  }
}

// ─── MIDDLEWARE ──────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// Vercel rewrites /api/foo → /api/index?path=foo — restore the original path
app.use((req, res, next) => {
  if (req.query.path !== undefined) {
    const slug = Array.isArray(req.query.path) ? req.query.path.join('/') : req.query.path;
    const rest = { ...req.query };
    delete rest.path;
    const qs = new URLSearchParams(rest).toString();
    req.url = '/api/' + slug + (qs ? '?' + qs : '');
  }
  const ctx = { t0: process.hrtime.bigint(), dbMs: 0, dbCount: 0, authMs: 0, authSource: null };
  const wasCold = !_servedARequest;
  _servedARequest = true;

  res.on('finish', () => {
    const total = Number(process.hrtime.bigint() - ctx.t0) / 1e6;
    const other = total - ctx.dbMs - ctx.authMs;
    const ms = n => `${n.toFixed(0)}ms`;
    console.log(
      `[ZHL:timing] ${req.method} ${req.path} ${res.statusCode} ` +
      `total=${ms(total)} auth=${ms(ctx.authMs)}${ctx.authSource ? `(${ctx.authSource})` : ''} ` +
      `db=${ms(ctx.dbMs)}/${ctx.dbCount}q other=${ms(other)}${wasCold ? ' COLD' : ''}`
    );
  });

  reqCtx.run(ctx, next);
});

app.use(async (req, res, next) => {
  try { await ensureDB(); next(); }
  catch (err) {
    console.error('[ZHL] DB init error:', err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ─── AUTH GUARD (all /api/* except health checks) ───────────────────────────
app.use('/api', (req, res, next) => {
  if (req.url === '/health' || req.url === '/dbtest' || req.url === '/fx-rates/sync' || req.url === '/rfq' || req.url === '/leads/purge-old' || req.path === '/track' || req.path === '/customer/documents' || req.path === '/customer/invoices'
      // the website pushing a file onto a lead it just created — gated by the same
      // shared secret as /rfq rather than by a staff session
      || /^\/rfq\/[^/]+\/documents$/.test(req.path)) return next()
  requireAuth(req, res, next)
})

// ─── HEALTH ─────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', db_url_set: !!process.env.DATABASE_URL });
});

app.get('/api/dbtest', async (req, res) => {
  try {
    const r = await pool.query('SELECT NOW() as time');
    res.json({ ok: true, time: r.rows[0].time });
  } catch (e) {
    // This route is unauthenticated by design (a public connectivity check), so the raw
    // driver/Postgres error is logged server-side only — never handed to the caller.
    console.error('[ZHL] /api/dbtest error:', e.message);
    res.json({ ok: false, error: 'Database check failed' });
  }
});

// ─── JOBS ───────────────────────────────────────────────────────────────────
app.get('/api/jobs', async (req, res) => {
  try {
    const { search, status, mode, agent, created_by } = req.query;
    // Single query with aggregated cost/billing via subquery joins — no N+1
    let where = 'WHERE 1=1';
    const p = [];
    let i = 1;
    if (search) {
      const s = `%${search}%`;
      where += ` AND (j.job_number ILIKE $${i} OR j.shipper ILIKE $${i+1} OR j.consignee ILIKE $${i+2} OR j.customer_ref ILIKE $${i+3} OR j.agent ILIKE $${i+4} OR j.created_by ILIKE $${i+5})`;
      p.push(s, s, s, s, s, s); i += 6;
    }
    if (status)     { where += ` AND j.status=$${i}`;          p.push(status);            i++; }
    if (mode)       { where += ` AND j.mode=$${i}`;            p.push(mode);              i++; }
    if (agent)      { where += ` AND j.agent ILIKE $${i}`;     p.push(`%${agent}%`);      i++; }
    if (created_by)   { where += ` AND j.created_by=$${i}`;      p.push(created_by);        i++; }

    const limitVal = req.query.limit ? Math.min(Math.max(parseInt(req.query.limit) || 200, 1), 500) : null
    const limitClause = limitVal ? `LIMIT ${limitVal}` : ''
    const q = `
      SELECT j.*,
        ROUND(COALESCE(c.total,0)::numeric, 2) AS cost_sgd,
        ROUND(COALESCE(b.total,0)::numeric, 2) AS sale_sgd,
        ROUND((COALESCE(b.total,0) - COALESCE(c.total,0))::numeric, 2) AS profit_sgd,
        CASE
          WHEN j.gp_override IS NOT NULL THEN ROUND(j.gp_override::numeric, 1)
          WHEN COALESCE(b.total,0) > 0   THEN ROUND(((COALESCE(b.total,0) - COALESCE(c.total,0)) / b.total * 100)::numeric, 1)
          ELSE 0
        END AS gp_percent,
        -- The real calculated margin, ignoring any manual override — used to previously
        -- just echo gp_override back (a no-op), which showed the wrong number for exactly
        -- the jobs where an override is set, the one case where the true computed GP matters.
        CASE
          WHEN COALESCE(b.total,0) > 0 THEN ROUND(((COALESCE(b.total,0) - COALESCE(c.total,0)) / b.total * 100)::numeric, 1)
          ELSE 0
        END AS computed_gp
      FROM jobs j
      LEFT JOIN (SELECT job_id, SUM(amount)    AS total FROM cost_lines    GROUP BY job_id) c ON c.job_id = j.id
      LEFT JOIN (SELECT job_id, SUM(rate*qty)  AS total FROM billing_lines GROUP BY job_id) b ON b.job_id = j.id
      ${where}
      ORDER BY j.id DESC
      ${limitClause}
    `;
    const result = await pool.query(q, p);
    res.json(result.rows.map(r => ({
      ...r,
      cost_sgd:   parseFloat(r.cost_sgd)   || 0,
      sale_sgd:   parseFloat(r.sale_sgd)   || 0,
      profit_sgd: parseFloat(r.profit_sgd) || 0,
      gp_percent: parseFloat(r.gp_percent) || 0,
    })));
  } catch (err) {
    console.error(`[ZHL] ${req.method} ${req.url}`, err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.post('/api/jobs', async (req, res) => {
  try {
    const { job_number, year, sequence } = await generateJobNumber();
    const f = req.body;
    const result = await pool.query(`
      INSERT INTO jobs (job_number, year, sequence, shipper, consignee, weight, packages,
        dimensions, cbm, pickup_company, pickup_address, pickup_contact_name, pickup_contact_number,
        delivery_address, delivery_contact_name, delivery_contact_number,
        date_out, date_delivered, agent, mode, status, customer_ref, deadline_date, commodity, notes, created_by, packing_list_items,
        customer_name, customer_contact_name, customer_contact_number, customer_email)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31)
      RETURNING *
    `, [
      job_number, year, sequence,
      f.shipper||'', f.consignee||'', f.weight||null, f.packages||null,
      f.dimensions||'', f.cbm||null,
      f.pickup_company||'', f.pickup_address||'', f.pickup_contact_name||'', f.pickup_contact_number||'',
      f.delivery_address||'', f.delivery_contact_name||'', f.delivery_contact_number||'',
      f.date_out||null, f.date_delivered||null,
      f.agent||'', f.mode||'Local Delivery', f.status||'New',
      f.customer_ref||'', f.deadline_date||null, f.commodity||'', f.notes||'',
      req.user?.email || '',
      JSON.stringify(f.packing_list_items || []),
      f.customer_name||'', f.customer_contact_name||'', f.customer_contact_number||'', f.customer_email||''
    ]);
    const job = result.rows[0];
    if (f.billing_lines && Array.isArray(f.billing_lines)) {
      // Parallel inserts instead of one-at-a-time — a job created from an AI-parsed
      // email with many billing lines no longer waits on N sequential round-trips.
      await Promise.all(f.billing_lines.map(bl => pool.query(
        'INSERT INTO billing_lines (job_id,service,unit,rate,qty,remarks) VALUES ($1,$2,$3,$4,$5,$6)',
        [job.id, bl.service||'', bl.unit||'', bl.rate||0, bl.qty||1, bl.remarks||'']
      )));
    }
    res.status(201).json(await enrichJob(job));
  } catch (err) {
    console.error(`[ZHL] ${req.method} ${req.url}`, err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.get('/api/jobs/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM jobs WHERE id=$1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    const job = result.rows[0];
    const [costRes, billingRes, entitiesRes, billingSplitsRes, costSplitsRes, docsRes] = await Promise.all([
      pool.query('SELECT * FROM cost_lines WHERE job_id=$1 ORDER BY id', [job.id]),
      pool.query('SELECT * FROM billing_lines WHERE job_id=$1 ORDER BY id', [job.id]),
      pool.query('SELECT * FROM split_entities WHERE job_id=$1 ORDER BY sort_order, id', [job.id]),
      pool.query('SELECT * FROM billing_line_splits WHERE job_id=$1 ORDER BY id', [job.id]),
      pool.query('SELECT * FROM cost_line_splits WHERE job_id=$1 ORDER BY id', [job.id]),
      pool.query('SELECT * FROM documents WHERE job_id=$1 ORDER BY upload_date DESC', [job.id]),
    ]);
    const billing_splits = billingSplitsRes.rows;
    const cost_splits = costSplitsRes.rows;
    const billing_lines = billingRes.rows.map(b => ({
      ...b,
      total: parseFloat(((b.rate||0)*(b.qty||1)).toFixed(2)),
      splits: billing_splits.filter(s => s.billing_line_id === b.id),
    }));
    const cost_lines = costRes.rows.map(c => ({ ...c, splits: cost_splits.filter(s => s.cost_line_id === c.id) }));
    res.json({ ...await enrichJob(job), cost_lines, billing_lines, documents: docsRes.rows, split_entities: entitiesRes.rows });
  } catch (err) {
    console.error(`[ZHL] ${req.method} ${req.url}`, err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.put('/api/jobs/:id', async (req, res) => {
  try {
    const allowed = ['shipper','consignee','weight','packages','dimensions','cbm',
      'pickup_company','pickup_address','pickup_contact_name','pickup_contact_number',
      'delivery_address','delivery_contact_name','delivery_contact_number',
      'date_out','date_delivered','eta','agent','mode','status','customer_ref',
      'deadline_date','commodity','notes','gp_override',
      'customer_name','customer_contact_name','customer_contact_number','customer_email','void_reason','zhl_invoice_no','created_by','inventory_movement_id','inventory_movement_no','packing_list_items'];
    const updates = {};
    allowed.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });
    if (!Object.keys(updates).length) {
      const r = await pool.query('SELECT * FROM jobs WHERE id=$1', [req.params.id]);
      return res.json(await enrichJob(r.rows[0]));
    }
    if (updates.packing_list_items !== undefined) {
      updates.packing_list_items = JSON.stringify(updates.packing_list_items)
    }
    const cols = Object.keys(updates).map((k, i) => `${k}=$${i+1}`).join(', ');
    const vals = [...Object.values(updates), req.params.id];
    await pool.query(`UPDATE jobs SET ${cols} WHERE id=$${vals.length}`, vals);
    const updated = (await pool.query('SELECT * FROM jobs WHERE id=$1', [req.params.id])).rows[0];
    res.json(await enrichJob(updated));
  } catch (err) {
    console.error(`[ZHL] ${req.method} ${req.url}`, err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.delete('/api/jobs/:id', async (req, res) => {
  try {
    // Fetch attached documents before the cascade delete removes their DB rows, so their
    // actual files in Supabase Storage can be cleaned up too (previously left orphaned).
    const docs = (await pool.query('SELECT file_url FROM documents WHERE job_id=$1', [req.params.id])).rows;
    await pool.query('DELETE FROM jobs WHERE id=$1', [req.params.id]);
    Promise.all(docs.map(d => deleteFromSupabaseStorage(d.file_url))).catch(() => {});
    res.json({ success: true });
  } catch (err) {
    console.error(`[ZHL] ${req.method} ${req.url}`, err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ─── COST LINES ─────────────────────────────────────────────────────────────
app.post('/api/jobs/:id/costs', async (req, res) => {
  try {
    const { vendor='', amount=0, invoice_no='', invoice_date=null, service='', remarks='', currency='SGD', amount_local=null, total_payable=null } = req.body;
    const r = await pool.query(
      'INSERT INTO cost_lines (job_id,vendor,amount,invoice_no,invoice_date,service,remarks,currency,amount_local,total_payable) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
      [req.params.id, vendor, amount, invoice_no, invoice_date, service, remarks, currency, amount_local, total_payable]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    console.error(`[ZHL] ${req.method} ${req.url}`, err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ─── INVENTORY INTEGRATION ───────────────────────────────────────────────────
app.post('/api/jobs/:id/inventory-link', async (req, res) => {
  try {
    await ensureDB()
    const job = (await pool.query('SELECT * FROM jobs WHERE id=$1', [req.params.id])).rows[0]
    if (!job) return res.status(404).json({ error: 'Job not found' })
    if (job.mode !== 'Warehousing') return res.status(400).json({ error: 'Job is not a Warehousing job' })
    if (job.inventory_movement_id) {
      // Movement already exists — still push stock lines if there are any
      const items = job.packing_list_items || []
      if (Array.isArray(items) && items.length > 0) {
        const invUrl = process.env.INVENTORY_SUPABASE_URL
        const invKey = process.env.INVENTORY_SUPABASE_SERVICE_KEY
        if (invUrl && invKey) {
          try { await pushStockLines(invUrl, invKey, job.inventory_movement_id, job.job_number, items) } catch (_) {}
        }
      }
      return res.json({ inventory_movement_id: job.inventory_movement_id, inventory_movement_no: job.inventory_movement_no, already_linked: true })
    }

    const invUrl = process.env.INVENTORY_SUPABASE_URL
    const invKey = process.env.INVENTORY_SUPABASE_SERVICE_KEY
    if (!invUrl || !invKey) return res.status(500).json({ error: 'Inventory Supabase credentials not configured' })

    const payload = {
      type:         'Inbound',
      company_name: job.customer_name || job.shipper || job.consignee || '',
      contact_name: job.customer_contact_name || '',
      phone:        job.customer_contact_number || '',
      email:        job.customer_email || '',
      customer_ref: job.customer_ref || '',
      date_in:      job.date_out || new Date().toISOString().slice(0, 10),
      nexus_job_no: job.job_number,
      nexus_job_id: String(job.id),
    }

    const invRes = await fetch(`${invUrl}/rest/v1/movements`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${invKey}`,
        'apikey': invKey,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
      },
      body: JSON.stringify(payload),
    })

    if (!invRes.ok) {
      const err = await invRes.text()
      console.error('[ZHL] Inventory insert failed:', err)
      return res.status(502).json({ error: `Inventory insert failed: ${err}` })
    }

    const [movement] = await invRes.json()
    const movementId = String(movement.id)
    const movementNo = movement.movement_no ? String(movement.movement_no) : movementId

    await pool.query(
      'UPDATE jobs SET inventory_movement_id=$1, inventory_movement_no=$2 WHERE id=$3',
      [movementId, movementNo, job.id]
    )
    console.log(`[ZHL] Linked ${job.job_number} → Inventory movement ${movementNo} (id: ${movementId})`)

    // Push stock lines if packing list items exist
    const items = job.packing_list_items || []
    if (Array.isArray(items) && items.length > 0) {
      await pushStockLines(invUrl, invKey, movementId, job.job_number, items)
    }

    res.json({ inventory_movement_id: movementId, inventory_movement_no: movementNo })
  } catch (err) {
    console.error(`[ZHL] POST /api/jobs/:id/inventory-link`, err.message)
    res.status(500).json({ error: 'Something went wrong. Please try again.' })
  }
})

async function pushStockLines(invUrl, invKey, movementId, nexusJobNo, items) {
  // Replace all lines for this movement
  await fetch(`${invUrl}/rest/v1/stock_lines?movement_id=eq.${movementId}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${invKey}`, 'apikey': invKey },
  })
  const lines = items.map(item => ({
    movement_id:  movementId,
    nexus_job_no: nexusJobNo,
    line_type:    'Inbound',
    sku:          item.sku || null,
    description:  item.description || '',
    qty_actual:   item.qty_actual ? Number(item.qty_actual) : null,
    unit:         item.unit || null,
    num_packages: item.num_packages ? Number(item.num_packages) : null,
    length_cm:    item.length_cm ? Number(item.length_cm) : null,
    breadth_cm:   item.breadth_cm ? Number(item.breadth_cm) : null,
    height_cm:    item.height_cm ? Number(item.height_cm) : null,
  }))
  const linesRes = await fetch(`${invUrl}/rest/v1/stock_lines`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${invKey}`,
      'apikey': invKey,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify(lines),
  })
  if (!linesRes.ok) {
    const err = await linesRes.text()
    console.error('[ZHL] Stock lines insert failed:', err)
    throw new Error(`Stock lines insert failed: ${err}`)
  }
  console.log(`[ZHL] Pushed ${lines.length} stock line(s) for movement ${movementId}`)
}

app.put('/api/jobs/:id/inventory-void', async (req, res) => {
  try {
    await ensureDB()
    const job = (await pool.query('SELECT inventory_movement_id FROM jobs WHERE id=$1', [req.params.id])).rows[0]
    if (!job) return res.status(404).json({ error: 'Job not found' })
    if (!job.inventory_movement_id) return res.status(400).json({ error: 'No linked inventory movement' })

    const invUrl = process.env.INVENTORY_SUPABASE_URL
    const invKey = process.env.INVENTORY_SUPABASE_SERVICE_KEY
    if (!invUrl || !invKey) return res.status(500).json({ error: 'Inventory Supabase credentials not configured' })

    const invRes = await fetch(`${invUrl}/rest/v1/movements?id=eq.${job.inventory_movement_id}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${invKey}`,
        'apikey': invKey,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({ status: 'Voided' }),
    })

    if (!invRes.ok) {
      const err = await invRes.text()
      console.error('[ZHL] Inventory void failed:', err)
      return res.status(502).json({ error: `Inventory void failed: ${err}` })
    }

    console.log(`[ZHL] Voided Inventory movement ${job.inventory_movement_id}`)
    res.json({ ok: true })
  } catch (err) {
    console.error(`[ZHL] PUT /api/jobs/:id/inventory-void`, err.message)
    res.status(500).json({ error: 'Something went wrong. Please try again.' })
  }
})

app.post('/api/jobs/:id/inventory-sync-lines', async (req, res) => {
  try {
    await ensureDB()
    const job = (await pool.query('SELECT * FROM jobs WHERE id=$1', [req.params.id])).rows[0]
    if (!job) return res.status(404).json({ error: 'Job not found' })
    if (!job.inventory_movement_id) return res.status(400).json({ error: 'No linked inventory movement' })
    const items = job.packing_list_items || []
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'No packing list items to sync' })

    const invUrl = process.env.INVENTORY_SUPABASE_URL
    const invKey = process.env.INVENTORY_SUPABASE_SERVICE_KEY
    if (!invUrl || !invKey) return res.status(500).json({ error: 'Inventory credentials not configured' })

    await pushStockLines(invUrl, invKey, job.inventory_movement_id, job.job_number, items)
    res.json({ ok: true, synced: items.length })
  } catch (err) {
    console.error(`[ZHL] POST /api/jobs/:id/inventory-sync-lines`, err.message)
    res.status(500).json({ error: err.message || 'Sync failed. Please try again.' })
  }
})

app.put('/api/jobs/:id/costs/:lid', async (req, res) => {
  try {
    // Partial update — only touch fields actually present in the request body, matching
    // PUT /api/jobs/:id's pattern. This used to unconditionally overwrite every column
    // with a defaulted value even if the caller only sent one field, which today's React
    // UI happens to avoid (it always sends the full row) but silently resets currency to
    // 'SGD' and nulls out amount_local/total_payable for any future caller that doesn't.
    const allowed = ['vendor','amount','invoice_no','invoice_date','service','remarks','currency','amount_local','total_payable']
    const updates = {}
    allowed.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f] })
    if (!Object.keys(updates).length) {
      const existing = (await pool.query('SELECT * FROM cost_lines WHERE id=$1 AND job_id=$2', [req.params.lid, req.params.id])).rows[0]
      return res.json(existing)
    }
    const cols = Object.keys(updates).map((k, i) => `${k}=$${i + 1}`).join(', ')
    const vals = [...Object.values(updates), req.params.lid, req.params.id]
    const r = await pool.query(
      `UPDATE cost_lines SET ${cols} WHERE id=$${vals.length - 1} AND job_id=$${vals.length} RETURNING *`,
      vals
    );
    res.json(r.rows[0]);
  } catch (err) {
    console.error(`[ZHL] ${req.method} ${req.url}`, err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.delete('/api/jobs/:id/costs/:lid', async (req, res) => {
  try {
    await pool.query('DELETE FROM cost_lines WHERE id=$1 AND job_id=$2', [req.params.lid, req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(`[ZHL] ${req.method} ${req.url}`, err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ─── BILLING LINES ──────────────────────────────────────────────────────────
app.post('/api/jobs/:id/billing', async (req, res) => {
  try {
    const { service='', unit='', rate=0, qty=1, remarks='', currency='SGD', rate_local=null } = req.body;
    const r = await pool.query(
      'INSERT INTO billing_lines (job_id,service,unit,rate,qty,remarks,currency,rate_local) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [req.params.id, service, unit, rate, qty, remarks, currency, rate_local]
    );
    const line = r.rows[0];
    res.status(201).json({ ...line, total: parseFloat(((line.rate||0)*(line.qty||1)).toFixed(2)) });
  } catch (err) {
    console.error(`[ZHL] ${req.method} ${req.url}`, err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.put('/api/jobs/:id/billing/:lid', async (req, res) => {
  try {
    // Partial update — see the matching comment on PUT /api/jobs/:id/costs/:lid above.
    const allowed = ['service','unit','rate','qty','remarks','currency','rate_local']
    const updates = {}
    allowed.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f] })
    let line
    if (!Object.keys(updates).length) {
      line = (await pool.query('SELECT * FROM billing_lines WHERE id=$1 AND job_id=$2', [req.params.lid, req.params.id])).rows[0]
    } else {
      const cols = Object.keys(updates).map((k, i) => `${k}=$${i + 1}`).join(', ')
      const vals = [...Object.values(updates), req.params.lid, req.params.id]
      const r = await pool.query(
        `UPDATE billing_lines SET ${cols} WHERE id=$${vals.length - 1} AND job_id=$${vals.length} RETURNING *`,
        vals
      );
      line = r.rows[0];
    }
    res.json({ ...line, total: parseFloat(((line.rate||0)*(line.qty||1)).toFixed(2)) });
  } catch (err) {
    console.error(`[ZHL] ${req.method} ${req.url}`, err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.delete('/api/jobs/:id/billing/:lid', async (req, res) => {
  try {
    await pool.query('DELETE FROM billing_lines WHERE id=$1 AND job_id=$2', [req.params.lid, req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(`[ZHL] ${req.method} ${req.url}`, err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ─── SPLIT INVOICING (multi-entity billing) ────────────────────────────────
app.post('/api/jobs/:id/split-entities', async (req, res) => {
  try {
    const { name='', billing_address='', contact_name='', contact_number='', contact_email='', invoice_no='', default_share=1 } = req.body;
    const countRes = await pool.query('SELECT COUNT(*) FROM split_entities WHERE job_id=$1', [req.params.id]);
    const sortOrder = parseInt(countRes.rows[0].count, 10);
    const r = await pool.query(
      'INSERT INTO split_entities (job_id,name,billing_address,contact_name,contact_number,contact_email,invoice_no,default_share,sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
      [req.params.id, name, billing_address, contact_name, contact_number, contact_email, invoice_no, default_share, sortOrder]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    console.error(`[ZHL] ${req.method} ${req.url}`, err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.put('/api/jobs/:id/split-entities/:eid', async (req, res) => {
  try {
    const { name='', billing_address='', contact_name='', contact_number='', contact_email='', invoice_no='', default_share=1 } = req.body;
    const r = await pool.query(
      'UPDATE split_entities SET name=$1,billing_address=$2,contact_name=$3,contact_number=$4,contact_email=$5,invoice_no=$6,default_share=$7 WHERE id=$8 AND job_id=$9 RETURNING *',
      [name, billing_address, contact_name, contact_number, contact_email, invoice_no, default_share, req.params.eid, req.params.id]
    );
    res.json(r.rows[0]);
  } catch (err) {
    console.error(`[ZHL] ${req.method} ${req.url}`, err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.delete('/api/jobs/:id/split-entities/:eid', async (req, res) => {
  try {
    await pool.query('DELETE FROM split_entities WHERE id=$1 AND job_id=$2', [req.params.eid, req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(`[ZHL] ${req.method} ${req.url}`, err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.put('/api/jobs/:id/billing/:lid/splits', async (req, res) => {
  try {
    const splits = Array.isArray(req.body.splits) ? req.body.splits : [];
    await pool.query('DELETE FROM billing_line_splits WHERE billing_line_id=$1', [req.params.lid]);
    let rows = [];
    if (splits.length) {
      const values = [];
      const params = [];
      splits.forEach((s, i) => {
        const base = i * 4;
        values.push(`($${base+1},$${base+2},$${base+3},$${base+4})`);
        params.push(req.params.id, req.params.lid, s.entity_id, s.amount || 0);
      });
      const r = await pool.query(
        `INSERT INTO billing_line_splits (job_id,billing_line_id,entity_id,amount) VALUES ${values.join(',')} RETURNING *`,
        params
      );
      rows = r.rows;
    }
    res.json(rows);
  } catch (err) {
    console.error(`[ZHL] ${req.method} ${req.url}`, err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.put('/api/jobs/:id/costs/:lid/splits', async (req, res) => {
  try {
    const splits = Array.isArray(req.body.splits) ? req.body.splits : [];
    await pool.query('DELETE FROM cost_line_splits WHERE cost_line_id=$1', [req.params.lid]);
    let rows = [];
    if (splits.length) {
      const values = [];
      const params = [];
      splits.forEach((s, i) => {
        const base = i * 4;
        values.push(`($${base+1},$${base+2},$${base+3},$${base+4})`);
        params.push(req.params.id, req.params.lid, s.entity_id, s.amount || 0);
      });
      const r = await pool.query(
        `INSERT INTO cost_line_splits (job_id,cost_line_id,entity_id,amount) VALUES ${values.join(',')} RETURNING *`,
        params
      );
      rows = r.rows;
    }
    res.json(rows);
  } catch (err) {
    console.error(`[ZHL] ${req.method} ${req.url}`, err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ─── DOCUMENTS ──────────────────────────────────────────────────────────────
app.post('/api/jobs/:id/documents', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const { doc_type = 'Other' } = req.body;
    const filename = `${Date.now()}-${Math.round(Math.random()*1e9)}-${req.file.originalname}`;
    const file_url = await uploadToSupabaseStorage(req.file.buffer, filename, req.file.mimetype);
    const r = await pool.query(
      'INSERT INTO documents (job_id,file_name,doc_type,file_url) VALUES ($1,$2,$3,$4) RETURNING *',
      [req.params.id, req.file.originalname, doc_type, file_url]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    console.error(`[ZHL] ${req.method} ${req.url}`, err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.delete('/api/jobs/:id/documents/:did', async (req, res) => {
  try {
    const doc = (await pool.query('SELECT file_url FROM documents WHERE id=$1 AND job_id=$2', [req.params.did, req.params.id])).rows[0];
    await pool.query('DELETE FROM documents WHERE id=$1 AND job_id=$2', [req.params.did, req.params.id]);
    if (doc) deleteFromSupabaseStorage(doc.file_url).catch(() => {});
    res.json({ success: true });
  } catch (err) {
    console.error(`[ZHL] ${req.method} ${req.url}`, err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ─── CUSTOMERS ──────────────────────────────────────────────────────────────
app.get('/api/staff', async (req, res) => {
  try {
    const r = await pool.query(`SELECT DISTINCT created_by FROM jobs WHERE created_by != '' ORDER BY created_by`)
    res.json(r.rows.map(r => r.created_by))
  } catch (err) {
    console.error(`[ZHL] ${req.method} ${req.url}`, err.message)
    res.status(500).json({ error: 'Something went wrong. Please try again.' })
  }
});

app.get('/api/customers', async (req, res) => {
  try {
    const { search } = req.query
    const p = search ? [`%${search}%`] : []
    const whereExtra = search
      ? `AND (COALESCE(NULLIF(j.customer_name,''), j.shipper) ILIKE $1)`
      : ''
    const r = await pool.query(`
      SELECT DISTINCT ON (COALESCE(NULLIF(j.customer_name,''), j.shipper))
        j.customer_name, j.customer_email, j.customer_contact_name, j.customer_contact_number,
        COALESCE(NULLIF(j.customer_name,''), j.shipper) AS display_name
      FROM jobs j
      WHERE COALESCE(NULLIF(j.customer_name,''), j.shipper) IS NOT NULL
        AND COALESCE(NULLIF(j.customer_name,''), j.shipper) != ''
        ${whereExtra}
      ORDER BY COALESCE(NULLIF(j.customer_name,''), j.shipper), j.id DESC
      LIMIT 15
    `, p)
    res.json(r.rows)
  } catch (err) {
    console.error(`[ZHL] ${req.method} ${req.url}`, err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
})

// ─── PARSE EMAIL ────────────────────────────────────────────────────────────
app.post('/api/parse-email', async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'No text provided' });
  try {
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 1500,
      system: 'You are a freight forwarding operations assistant for Zhenghe Logistics (ZHL), Singapore. Extract job details from emails and job orders. Always return valid JSON only, no other text.',
      messages: [{ role: 'user', content: `Parse this email/job order and return a JSON object with these exact fields (null for missing):
{
  "shipper": "shipper company name",
  "consignee": "consignee company name",
  "pickup_address": "full pickup address",
  "pickup_contact_name": "pickup contact person name",
  "pickup_contact_number": "pickup contact phone number",
  "delivery_address": "full delivery address",
  "delivery_contact_name": "delivery contact person name",
  "delivery_contact_number": "delivery contact phone number",
  "packages": <integer or null>,
  "dimensions": "e.g. 60x40x30 cm per box",
  "weight": <number in kg or null>,
  "cbm": <number or null>,
  "commodity": "description of goods",
  "mode": "one of: Air Express / Air Freight / LCL Express / LCL / Local Delivery / Local Clearance & Delivery / Sea FCL / Sea LCL",
  "agent": "agent name if mentioned",
  "deadline_date": "YYYY-MM-DD or null",
  "customer_ref": "customer reference number e.g. KPS1137",
  "notes": "any other relevant info",
  "billing_lines": [{ "service": "Airfreight", "unit": "kg", "rate": 28, "qty": 136, "remarks": "min 20kg" }]
}
Email/Job Order:\n${text}` }]
    });
    const content = getResponseText(msg);
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return res.status(422).json({ error: 'Could not parse AI response' });
    res.json(JSON.parse(match[0]));
  } catch (err) {
    console.error('[ZHL] POST /api/parse-email', err.message);
    res.status(500).json({ error: 'AI parsing failed. Please try again.' });
  }
});

// ─── PARSE EMAIL FILE ───────────────────────────────────────────────────────
app.post('/api/parse-email-file', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    let text = '';
    const name = req.file.originalname.toLowerCase();
    if (name.endsWith('.pdf')) {
      const pdfParse = require('pdf-parse');
      const data = await pdfParse(req.file.buffer);
      text = data.text;
    } else {
      text = req.file.buffer.toString('utf-8');
    }
    if (!text.trim()) return res.status(422).json({ error: 'Could not extract text from file' });

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 1500,
      system: 'You are a freight forwarding operations assistant for Zhenghe Logistics (ZHL), Singapore. Extract job details from emails and job orders. Always return valid JSON only, no other text.',
      messages: [{ role: 'user', content: `Parse this email/job order and return a JSON object with these exact fields (null for missing):
{
  "shipper": "shipper company name",
  "consignee": "consignee company name",
  "pickup_address": "full pickup address",
  "pickup_contact_name": "pickup contact person name",
  "pickup_contact_number": "pickup contact phone number",
  "delivery_address": "full delivery address",
  "delivery_contact_name": "delivery contact person name",
  "delivery_contact_number": "delivery contact phone number",
  "packages": <integer or null>,
  "dimensions": "e.g. 60x40x30 cm per box",
  "weight": <number in kg or null>,
  "cbm": <number or null>,
  "commodity": "description of goods",
  "mode": "one of: Air Express / Air Freight / LCL Express / LCL / Local Delivery / Local Clearance & Delivery / Sea FCL / Sea LCL",
  "agent": "agent name if mentioned",
  "deadline_date": "YYYY-MM-DD or null",
  "customer_ref": "customer reference number",
  "notes": "any other relevant info",
  "billing_lines": [{ "service": "Airfreight", "unit": "kg", "rate": 28, "qty": 136, "remarks": "" }]
}
Email/Job Order:\n${text.substring(0, 8000)}` }]
    });
    const content = getResponseText(msg);
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return res.status(422).json({ error: 'Could not parse AI response' });
    res.json(JSON.parse(match[0]));
  } catch (err) {
    console.error('[ZHL] POST /api/parse-email-file', err.message);
    res.status(500).json({ error: 'File parsing failed. Please try again.' });
  }
});

// ─── PARSE DELIVERY ORDER / PACKING LIST ────────────────────────────────────
app.post('/api/parse-do', upload.single('file'), async (req, res) => {
  const DO_PROMPT = `Extract job details from this delivery order or packing list. Return valid JSON only with these fields (null for missing):
{
  "shipper": "supplier/seller company name",
  "consignee": "buyer/recipient company name",
  "customer_name": "same as consignee",
  "customer_contact_name": "contact person name if present",
  "customer_contact_number": "contact phone if present",
  "pickup_address": "origin/seller address if present",
  "delivery_address": "full delivery address of recipient",
  "delivery_contact_name": "delivery contact name if present",
  "delivery_contact_number": "delivery contact number if present",
  "packages": <total number of cartons/packages as integer>,
  "weight": <total weight in KG as number>,
  "cbm": <total volume in CBM or M3 as number>,
  "dimensions": "carton measurements in format: LxWxH cm ×qty — comma-separated if multiple sizes, e.g. '59x34x38 cm ×16, 41x31x38 cm ×7'",
  "commodity": "short description of the goods",
  "customer_ref": "DO number or invoice number",
  "date_out": "delivery or invoice date as YYYY-MM-DD or null",
  "notes": "any special instructions or remarks",
  "mode": "Warehousing"
}
Return only the JSON object.`
  try {
    let msgContent

    if (req.body.text) {
      // Text extracted client-side — tiny payload, no size issues
      msgContent = [{ type: 'text', text: `${DO_PROMPT}\n\nDocument text:\n${req.body.text.substring(0, 8000)}` }]
    } else if (req.file) {
      // File upload fallback (scanned PDFs, must be <4.5MB due to Vercel limit)
      let extracted = ''
      try {
        const pdfParse = require('pdf-parse')
        const { text } = await pdfParse(req.file.buffer)
        if (text && text.trim().length > 100) extracted = text
      } catch (_) {}

      msgContent = extracted
        ? [{ type: 'text', text: `${DO_PROMPT}\n\nDocument text:\n${extracted.substring(0, 8000)}` }]
        : [
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: req.file.buffer.toString('base64') } },
            { type: 'text', text: DO_PROMPT }
          ]
    } else {
      return res.status(400).json({ error: 'No file or text provided' })
    }

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 1500,
      messages: [{ role: 'user', content: msgContent }]
    })
    const content = getResponseText(msg)
    const match = content.match(/\{[\s\S]*\}/)
    if (!match) return res.status(422).json({ error: 'Could not parse document' })
    const parsed = JSON.parse(match[0])
    parsed.mode = 'Warehousing'
    res.json(parsed)
  } catch (err) {
    console.error('[ZHL] POST /api/parse-do', err.message)
    res.status(500).json({ error: 'Document parsing failed. Please try again.' })
  }
})

// ─── PARSE PACKING LIST ─────────────────────────────────────────────────────
// ─── RATE CARD PDF → structured rates ────────────────────────────────────────
// Deliberately sends the PDF itself as a document block rather than extracted text.
// Rate cards are tables, and our text extraction flattens each page into one line
// (items.map(i => i.str).join(' ')), which destroys the column alignment the whole
// document depends on. Claude reads the PDF natively and keeps the layout.
// The result is always reviewed by a human before saving — real cards contain
// contradictions (one sampled card states its fuel surcharge twice, with two
// different numbers) and placeholders ("$0.00 please request quotation").
const RATE_CARD_PROMPT = `You are reading a freight vendor's rate card. Extract every chargeable item into JSON.

Return ONLY this object, no other text:
{
  "vendor_name": "the company issuing these rates",
  "title": "the document's subject line, or null",
  "currency": "3-letter code, default SGD",
  "valid_from": "YYYY-MM-DD if the card is dated, else null",
  "notes": "any overall conditions worth keeping, or null",
  "lines": [ ... ]
}

Each element of "lines" must be:
{
  "charge_name": "what the charge is called",
  "category": "main" | "surcharge" | "optional",
  "basis": "flat" | "banded" | "per_kg" | "per_chargeable_kg" | "per_cbm" | "per_rt" | "per_pallet" | "per_carton" | "per_head" | "per_hour" | "per_unit",
  "rate": <number, or null when basis is "banded">,
  "min_charge": <number or null>,
  "min_qty": <number or null>,
  "band_metric": "weight_kg" | "packages" | "cbm"   (only when basis is "banded", else null),
  "bands": [ {"from": <number>, "to": <number or null>, "amount": <number>, "basis": "flat" | "per_kg"} ]  (only when basis is "banded", else null),
  "condition_note": "when this charge applies, or null",
  "remarks": "anything else worth keeping, or null"
}

Rules that matter:
- "category": the main transport/handling charge is "main"; charges that always apply
  such as fuel surcharge are "surcharge"; anything conditional (a specific location or
  zone, dangerous goods, oversized cargo, overtime, extra manpower, cancellation,
  equipment like a tailgate) is "optional".
- A WEIGHT OR QUANTITY TABLE is one single line with basis "banded" — NOT one line per
  row. Put each row in "bands". Bands are inclusive at both ends. The final row is
  usually open-ended ("1001 & above") — give it "to": null.
- Watch for a band that changes how it is priced. A table can list flat amounts per
  band and then switch the top band to a per-unit rate, e.g. "001-50 = $17.00 ...
  1001 & above = $0.065 per kg". That last band is {"from":1001,"to":null,
  "amount":0.065,"basis":"per_kg"} while the others are "basis":"flat".
- "Min $X or $Y per kg" (whichever is greater) is ONE line: basis "per_kg", rate Y,
  min_charge X. Do not split it into two.
- "Whichever is greater, weight or volume/M3" means basis "per_rt" (revenue tonne).
  "Chargeable weight" (volumetric vs gross) means basis "per_chargeable_kg".
- "per job", "per trip", "per shipment", "per D/O" all mean basis "flat".
- A minimum number of billable units ("min 3 hours") is "min_qty", not "min_charge".
- If one line lists two variants at different prices (e.g. small crate $40 / big crate
  $50), emit two lines with distinct names.
- Use null for anything not stated. Never invent a number.
- If the same charge is stated twice with different amounts, emit it once using the
  first value and say so in "remarks".

If you find no rates at all, return {"vendor_name": null, "lines": []}.`

app.post('/api/parse-rate-card', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' })
  try {
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 8000,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: req.file.buffer.toString('base64') } },
          { type: 'text', text: RATE_CARD_PROMPT },
        ],
      }],
    })
    // A rate card can run to dozens of charges; a truncated response would fail to
    // parse and surface as a confusing 500, so check for it explicitly.
    if (msg.stop_reason === 'max_tokens') {
      console.error('[ZHL] POST /api/parse-rate-card: response hit max_tokens')
      return res.status(422).json({ error: 'This rate card is too long to read in one pass. Try splitting the PDF, or add the charges manually.' })
    }
    const content = getResponseText(msg).replace(/```json\s*|\s*```/g, '').trim()
    const match = content.match(/\{[\s\S]*\}/)
    if (!match) return res.status(422).json({ error: 'Could not read any rates from that PDF.' })
    const parsed = JSON.parse(match[0])
    res.json({ ...parsed, lines: Array.isArray(parsed.lines) ? parsed.lines : [] })
  } catch (err) {
    console.error('[ZHL] POST /api/parse-rate-card', err.message)
    res.status(500).json({ error: 'Rate card parsing failed. Please try again.' })
  }
})

app.post('/api/parse-packing-list', upload.single('file'), async (req, res) => {
  const PROMPT = `Extract all line items from this packing list. Return a JSON array only — no other text.
Each element must have these fields (use null for missing values):
[{
  "sku": "item code/SKU or null",
  "description": "product name or description",
  "qty_actual": <total quantity as number>,
  "unit": "pcs/cartons/boxes/sets/etc",
  "num_packages": <number of packages/cartons as integer or null>,
  "length_cm": <carton length in cm as number or null>,
  "breadth_cm": <carton width/breadth in cm as number or null>,
  "height_cm": <carton height in cm as number or null>
}]

Some packing lists are a per-box table (Box #, Length, Width, Height, Weight) with a single
"Contents" or "Marking" line describing what's inside, rather than a per-SKU product list.
For that format: create ONE item per distinct content description, with qty_actual set to
the total quantity stated in the Contents line (e.g. "595 pieces"), num_packages set to the
count of boxes for that content, and length_cm/breadth_cm/height_cm taken from the box
dimensions (use the most common values if they vary slightly). Do not return one row per box.

If no items are found return [].`
  try {
    let msgContent
    if (req.body.text) {
      msgContent = [{ type: 'text', text: `${PROMPT}\n\nDocument text:\n${req.body.text.substring(0, 24000)}` }]
    } else if (req.file) {
      let extracted = ''
      try {
        const pdfParse = require('pdf-parse')
        const { text } = await pdfParse(req.file.buffer)
        if (text && text.trim().length > 50) extracted = text
      } catch (_) {}
      msgContent = extracted
        ? [{ type: 'text', text: `${PROMPT}\n\nDocument text:\n${extracted.substring(0, 24000)}` }]
        : [
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: req.file.buffer.toString('base64') } },
            { type: 'text', text: PROMPT }
          ]
    } else {
      return res.status(400).json({ error: 'No file or text provided' })
    }
    // Packing lists can have many line items — give the model plenty of output
    // headroom so the JSON array isn't truncated mid-item (which breaks parsing).
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 8000,
      messages: [{ role: 'user', content: msgContent }]
    })
    if (msg.stop_reason === 'max_tokens') {
      console.error('[ZHL] POST /api/parse-packing-list: response hit max_tokens (list too long)')
      return res.status(422).json({ error: 'Packing list is too long to extract in one pass. Try splitting it or add rows manually.' })
    }
    const content = getResponseText(msg).replace(/```json\s*|\s*```/g, '').trim()
    const match = content.match(/\[[\s\S]*\]/)
    if (!match) return res.status(422).json({ error: 'Could not parse packing list' })
    res.json(JSON.parse(match[0]))
  } catch (err) {
    console.error('[ZHL] POST /api/parse-packing-list', err.message)
    res.status(500).json({ error: 'Packing list parsing failed. Please try again.' })
  }
})

// ─── PARSE INVOICE ──────────────────────────────────────────────────────────
app.post('/api/parse-invoice', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const pdfParse = require('pdf-parse');
    const data = await pdfParse(req.file.buffer);

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 800,
      system: 'You are a freight forwarding assistant. Extract invoice details and return valid JSON only.',
      messages: [{ role: 'user', content: `Extract cost line details from this vendor invoice and return JSON:
{
  "vendor": "vendor/supplier name",
  "amount": <total amount as number>,
  "invoice_no": "invoice number",
  "invoice_date": "YYYY-MM-DD or null",
  "service": "service description",
  "remarks": "any notes"
}
Invoice text:\n${data.text.substring(0, 4000)}` }]
    });
    const content = getResponseText(msg);
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return res.status(422).json({ error: 'Could not parse invoice' });
    res.json(JSON.parse(match[0]));
  } catch (err) {
    console.error('[ZHL] POST /api/parse-invoice', err.message);
    res.status(500).json({ error: 'Invoice parsing failed. Please try again.' });
  }
});

// ─── DASHBOARD ──────────────────────────────────────────────────────────────
app.get('/api/dashboard', async (req, res) => {
  try {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1);
    const today = now.toISOString().split('T')[0];
    const in7days = new Date(now.getTime() + 7*24*60*60*1000).toISOString().split('T')[0];

    // All queries run in parallel — no loops, no N+1
    const [monthRes, byModeRes, trendRes, upcomingRes, flaggedRes, statusRes, missingCountRes] = await Promise.all([
      // This month KPIs
      pool.query(`
        SELECT COUNT(DISTINCT j.id) AS jobs,
          COALESCE(SUM(b.total),0) AS revenue,
          COALESCE(SUM(c.total),0) AS cost
        FROM jobs j
        LEFT JOIN (SELECT job_id, SUM(rate*qty) AS total FROM billing_lines GROUP BY job_id) b ON b.job_id = j.id
        LEFT JOIN (SELECT job_id, SUM(amount)   AS total FROM cost_lines    GROUP BY job_id) c ON c.job_id = j.id
        WHERE j.created_at >= $1
      `, [monthStart]),

      // Jobs by mode
      pool.query(`
        SELECT j.mode,
          COUNT(j.id) AS count,
          COALESCE(SUM(b.total),0) AS revenue
        FROM jobs j
        LEFT JOIN (SELECT job_id, SUM(rate*qty) AS total FROM billing_lines GROUP BY job_id) b ON b.job_id = j.id
        GROUP BY j.mode
        ORDER BY count DESC
      `),

      // 6-month GP% trend
      pool.query(`
        SELECT DATE_TRUNC('month', j.created_at) AS month,
          COALESCE(SUM(b.total),0) AS revenue,
          COALESCE(SUM(c.total),0) AS cost
        FROM jobs j
        LEFT JOIN (SELECT job_id, SUM(rate*qty) AS total FROM billing_lines GROUP BY job_id) b ON b.job_id = j.id
        LEFT JOIN (SELECT job_id, SUM(amount)   AS total FROM cost_lines    GROUP BY job_id) c ON c.job_id = j.id
        WHERE j.created_at >= $1
        GROUP BY DATE_TRUNC('month', j.created_at)
        ORDER BY month
      `, [sixMonthsAgo]),

      // Upcoming deadlines
      pool.query(
        "SELECT id,job_number,shipper,consignee,deadline_date,status FROM jobs WHERE deadline_date >= $1 AND deadline_date <= $2 AND status != 'Completed' ORDER BY deadline_date",
        [today, in7days]
      ),

      // Flagged — no billing lines
      pool.query(
        'SELECT j.id,j.job_number,j.shipper,j.status FROM jobs j WHERE NOT EXISTS (SELECT 1 FROM billing_lines b WHERE b.job_id=j.id) ORDER BY j.id DESC LIMIT 10'
      ),

      // Status counts (for status overview widget)
      pool.query(`
        SELECT status, COUNT(id) AS count
        FROM jobs
        WHERE status != 'Voided'
        GROUP BY status
      `),

      // Total missing costing count (not limited to 10)
      pool.query(`
        SELECT COUNT(j.id) AS count
        FROM jobs j
        WHERE NOT EXISTS (SELECT 1 FROM billing_lines b WHERE b.job_id=j.id)
          AND j.status != 'Voided'
      `),
    ]);

    const m = monthRes.rows[0];
    const monthRevenue = parseFloat(m.revenue);
    const monthCost    = parseFloat(m.cost);
    const monthProfit  = monthRevenue - monthCost;
    const monthGP      = monthRevenue > 0 ? (monthProfit / monthRevenue) * 100 : 0;

    // Build full 6-month array, filling zeros for months with no jobs
    const trendMap = {};
    for (const r of trendRes.rows) {
      const key = new Date(r.month).toISOString().slice(0, 7); // "2026-04"
      trendMap[key] = { revenue: parseFloat(r.revenue), cost: parseFloat(r.cost) };
    }
    const trend = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = d.toISOString().slice(0, 7);
      const { revenue: rev = 0, cost = 0 } = trendMap[key] || {};
      const profit = rev - cost;
      const gp = rev > 0 ? parseFloat(((profit / rev) * 100).toFixed(1)) : 0;
      trend.push({ month: d.toLocaleString('default', { month: 'short', year: '2-digit' }), gp_percent: gp, revenue: parseFloat(rev.toFixed(2)) });
    }

    res.json({
      this_month: {
        jobs: parseInt(m.jobs),
        revenue: parseFloat(monthRevenue.toFixed(2)),
        cost: parseFloat(monthCost.toFixed(2)),
        profit: parseFloat(monthProfit.toFixed(2)),
        gp_percent: parseFloat(monthGP.toFixed(1))
      },
      by_mode: byModeRes.rows.map(r => ({ mode: r.mode, count: parseInt(r.count), revenue: parseFloat(r.revenue) })),
      trend,
      upcoming_deadlines: upcomingRes.rows,
      flagged_jobs: flaggedRes.rows,
      status_counts: Object.fromEntries(statusRes.rows.map(r => [r.status, parseInt(r.count)])),
      missing_costing_count: parseInt(missingCountRes.rows[0].count)
    });
  } catch (err) {
    console.error(`[ZHL] ${req.method} ${req.url}`, err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ─── FX RATES ────────────────────────────────────────────────────────────────
// Yahoo Finance tickers: 1 SGD = X [currency]
const FX_YAHOO_PAIRS = {
  USD: 'SGDUSD=X', EUR: 'SGDEUR=X', IDR: 'SGDIDR=X',
  CNY: 'SGDCNY=X', MYR: 'SGDMYR=X', HKD: 'SGDHKD=X', THB: 'SGDTHB=X',
  VND: 'SGDVND=X', INR: 'SGDINR=X', JPY: 'SGDJPY=X', GBP: 'SGDGBP=X',
  AUD: 'SGDAUD=X', KRW: 'SGDKRW=X', PHP: 'SGDPHP=X', TWD: 'SGDTWD=X', AED: 'SGDAED=X',
}

// Returns the last Mon–Fri of the previous calendar month (UTC Date object)
function lastWeekdayOfPrevMonth(now) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)) // last calendar day of prev month
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1)
  return d
}

// Fetch the closing price of the last trading day of the previous month from Yahoo Finance.
// Yahoo's API sometimes stores a date's close with a timestamp 1 day later, so we find
// the entry closest to the expected date rather than trusting the timestamp's day-of-week.
async function fetchPrevMonthEndClose(ticker) {
  const now = new Date()
  const target = lastWeekdayOfPrevMonth(now)
  const targetTs = target.getTime() / 1000
  // Fetch a 10-day window centred on the expected last trading day
  const p1 = Math.floor(targetTs - 7 * 86400)
  const p2 = Math.floor(targetTs + 3 * 86400)
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&period1=${p1}&period2=${p2}`
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
    signal: AbortSignal.timeout(9000),
  })
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status} for ${ticker}`)
  const data = await res.json()
  const result = data?.chart?.result?.[0]
  if (!result) throw new Error('No data from Yahoo Finance')
  const timestamps = result.timestamp || []
  const closes = result.indicators?.quote?.[0]?.close || []
  // Pick the entry whose timestamp is closest to the target date (within 36 hours)
  let bestIdx = -1, bestDiff = Infinity
  for (let i = 0; i < closes.length; i++) {
    if (closes[i] == null || isNaN(closes[i])) continue
    const diff = Math.abs(timestamps[i] - targetTs)
    if (diff < bestDiff && diff <= 129600) { bestDiff = diff; bestIdx = i }
  }
  if (bestIdx === -1) throw new Error(`No close price found near ${target.toISOString().split('T')[0]} for ${ticker}`)
  const date = target.toISOString().split('T')[0] // use our calculated date, not Yahoo's offset timestamp
  return { rate: parseFloat(closes[bestIdx]), date }
}

app.get('/api/fx-rates/sync', async (req, res) => {
  const auth = req.headers.authorization
  // Fail CLOSED: if CRON_SECRET is ever unset/misconfigured, refuse the request rather
  // than silently letting it through unauthenticated (this route is exempted from the
  // global requireAuth guard, so this check is the only gate it has).
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  try {
    await ensureDB()
    const results = []

    for (const [currency, ticker] of Object.entries(FX_YAHOO_PAIRS)) {
      const lockRow = await pool.query('SELECT is_manual FROM fx_rates WHERE currency=$1', [currency])
      if (lockRow.rows[0]?.is_manual) {
        results.push({ currency, skipped: true, reason: 'manually locked' })
        continue
      }
      try {
        const { rate, date } = await fetchPrevMonthEndClose(ticker)
        const updatedBy = `auto-sync (Yahoo close ${date})`
        await pool.query(
          `INSERT INTO fx_rates (currency, rate, updated_at, updated_by, is_manual)
           VALUES ($1,$2,NOW(),$3,FALSE)
           ON CONFLICT (currency) DO UPDATE SET rate=$2, updated_at=NOW(), updated_by=$3, is_manual=FALSE`,
          [currency, rate, updatedBy]
        )
        console.log(`[ZHL] FX sync: 1 SGD = ${rate} ${currency} (close ${date})`)
        results.push({ currency, rate, date, updated: true })
      } catch (e) {
        console.error(`[ZHL] FX sync failed for ${currency}:`, e.message)
        results.push({ currency, error: e.message })
      }
    }

    res.json({ success: true, results, synced_at: new Date() })
  } catch (err) {
    console.error('[ZHL] FX auto-sync error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// Release manual lock (and immediately fetch live rate)
// requireAuth is not passed as route middleware here — the global `app.use('/api', ...)`
// guard already applies it to every route except an explicit exempt list (this route
// isn't in it), so adding it again just did the same Supabase auth check twice per request.
app.put('/api/fx-rates/:currency/unlock', async (req, res) => {
  try {
    await ensureDB()
    const { currency } = req.params
    const ticker = FX_YAHOO_PAIRS[currency]
    let rate = null

    let closeDate = null
    if (ticker) {
      try {
        const result = await fetchPrevMonthEndClose(ticker)
        rate = result.rate
        closeDate = result.date
      } catch {}
    }

    if (rate) {
      await pool.query(
        `UPDATE fx_rates SET is_manual=FALSE, rate=$1, updated_at=NOW(), updated_by=$3 WHERE currency=$2`,
        [rate, currency, `auto-sync (Yahoo close ${closeDate})`]
      )
      res.json({ success: true, currency, rate, is_manual: false })
    } else {
      await pool.query('UPDATE fx_rates SET is_manual=FALSE WHERE currency=$1', [currency])
      const row = await pool.query('SELECT rate FROM fx_rates WHERE currency=$1', [currency])
      res.json({ success: true, currency, rate: row.rows[0]?.rate, is_manual: false })
    }
  } catch (err) {
    console.error(`[ZHL] ${req.method} ${req.url}`, err.message)
    res.status(500).json({ error: 'Something went wrong. Please try again.' })
  }
})

app.get('/api/fx-rates', async (req, res) => {
  try {
    await ensureDB();
    const r = await pool.query('SELECT * FROM fx_rates ORDER BY currency');
    const rates = {}, is_manual = {};
    let updated_at = null, updated_by = '';
    r.rows.forEach(row => {
      rates[row.currency] = row.rate;
      is_manual[row.currency] = !!row.is_manual;
      if (!updated_at || new Date(row.updated_at) > new Date(updated_at)) {
        updated_at = row.updated_at;
        updated_by = row.updated_by;
      }
    });
    res.json({ rates, is_manual, updated_at, updated_by });
  } catch (err) {
    console.error(`[ZHL] ${req.method} ${req.url}`, err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// See the comment on the /unlock route above — requireAuth already runs via the global guard.
app.put('/api/fx-rates', async (req, res) => {
  try {
    await ensureDB();
    const { rates } = req.body;
    const updatedBy = req.user?.email || '';
    const now = new Date();
    await Promise.all(Object.entries(rates).map(([currency, rate]) =>
      pool.query(
        `INSERT INTO fx_rates (currency, rate, updated_at, updated_by, is_manual)
         VALUES ($1,$2,$3,$4,TRUE)
         ON CONFLICT (currency) DO UPDATE SET rate=$2, updated_at=$3, updated_by=$4, is_manual=TRUE`,
        [currency, parseFloat(rate), now, updatedBy]
      )
    ));
    res.json({ success: true, updated_at: now, updated_by: updatedBy });
  } catch (err) {
    console.error(`[ZHL] ${req.method} ${req.url}`, err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ─── COMPANY STATS ───────────────────────────────────────────────────────────
app.get('/api/stats/companies', async (req, res) => {
  try {
    const [companiesRes, modesRes] = await Promise.all([
      pool.query(`
        SELECT COALESCE(NULLIF(TRIM(customer_name),''), NULLIF(TRIM(shipper),'')) AS name, COUNT(*) AS jobs
        FROM jobs
        WHERE COALESCE(NULLIF(TRIM(customer_name),''), NULLIF(TRIM(shipper),'')) IS NOT NULL
        GROUP BY 1 ORDER BY jobs DESC, name
      `),
      pool.query(`SELECT DISTINCT UPPER(TRIM(mode)) AS mode FROM jobs WHERE mode IS NOT NULL AND TRIM(mode) != '' ORDER BY 1`)
    ])
    res.json({
      companies: companiesRes.rows.filter(r => r.name).map(r => ({ name: r.name, jobs: parseInt(r.jobs) })),
      modes: modesRes.rows.map(r => r.mode)
    })
  } catch (err) {
    console.error(`[ZHL] ${req.method} ${req.url}`, err.message)
    res.status(500).json({ error: 'Something went wrong. Please try again.' })
  }
})

app.get('/api/stats/company', async (req, res) => {
  try {
    const { company, year, month, mode } = req.query
    const y = parseInt(year) || new Date().getFullYear()
    const m = month ? parseInt(month) : null
    const start = m ? new Date(y, m - 1, 1) : new Date(y, 0, 1)
    const end   = m ? new Date(y, m, 1)     : new Date(y + 1, 0, 1)

    const params = [start, end]
    const conditions = [`j.created_at >= $1 AND j.created_at < $2`]
    if (company && company !== '__all__') {
      // Exact match (no % wildcards) — this used to wrap the value in %...%, so selecting
      // "ABC Pte Ltd" would also silently pull in "New ABC Pte Ltd Holdings" or any other
      // company whose name merely contained the selected string. ILIKE with no wildcards
      // still gives a case-insensitive match without that substring bleed.
      params.push(company)
      conditions.push(`(COALESCE(NULLIF(j.customer_name,''), j.shipper) ILIKE $${params.length})`)
    }
    if (mode && mode !== '__all__') {
      params.push(mode)
      conditions.push(`UPPER(TRIM(j.mode)) = UPPER(TRIM($${params.length}))`)
    }
    const baseWhere = `WHERE ${conditions.join(' AND ')}`

    const [summaryRes, byModeRes, trendRes] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(j.id) AS jobs,
          COALESCE(SUM(j.packages), 0) AS packages,
          COALESCE(SUM(j.weight),   0) AS weight,
          COALESCE(SUM(j.cbm),      0) AS cbm,
          COALESCE(SUM(b.total),    0) AS revenue,
          COALESCE(SUM(c.total),    0) AS cost
        FROM jobs j
        LEFT JOIN (SELECT job_id, SUM(rate*qty) AS total FROM billing_lines GROUP BY job_id) b ON b.job_id = j.id
        LEFT JOIN (SELECT job_id, SUM(amount)   AS total FROM cost_lines    GROUP BY job_id) c ON c.job_id = j.id
        ${baseWhere}
      `, params),

      pool.query(`
        SELECT
          j.mode,
          COUNT(j.id) AS jobs,
          COALESCE(SUM(j.packages), 0) AS packages,
          COALESCE(SUM(j.weight),   0) AS weight,
          COALESCE(SUM(j.cbm),      0) AS cbm,
          COALESCE(SUM(b.total),    0) AS revenue,
          COALESCE(SUM(c.total),    0) AS cost
        FROM jobs j
        LEFT JOIN (SELECT job_id, SUM(rate*qty) AS total FROM billing_lines GROUP BY job_id) b ON b.job_id = j.id
        LEFT JOIN (SELECT job_id, SUM(amount)   AS total FROM cost_lines    GROUP BY job_id) c ON c.job_id = j.id
        ${baseWhere}
        GROUP BY j.mode
        ORDER BY revenue DESC
      `, params),

      m ? Promise.resolve({ rows: [] }) : pool.query(`
        SELECT
          DATE_TRUNC('month', j.created_at) AS month,
          COUNT(j.id) AS jobs,
          COALESCE(SUM(b.total), 0) AS revenue,
          COALESCE(SUM(c.total), 0) AS cost
        FROM jobs j
        LEFT JOIN (SELECT job_id, SUM(rate*qty) AS total FROM billing_lines GROUP BY job_id) b ON b.job_id = j.id
        LEFT JOIN (SELECT job_id, SUM(amount)   AS total FROM cost_lines    GROUP BY job_id) c ON c.job_id = j.id
        ${baseWhere}
        GROUP BY DATE_TRUNC('month', j.created_at)
        ORDER BY month
      `, params),
    ])

    const s = summaryRes.rows[0]
    const rev = parseFloat(s.revenue), cst = parseFloat(s.cost), pft = parseFloat(s.revenue) - parseFloat(s.cost)
    const gp  = rev > 0 ? parseFloat(((pft / rev) * 100).toFixed(1)) : 0

    const by_mode = byModeRes.rows.map(r => {
      const rv = parseFloat(r.revenue), ct = parseFloat(r.cost), pt = parseFloat(r.revenue) - parseFloat(r.cost)
      return {
        mode: r.mode, jobs: parseInt(r.jobs),
        packages: parseFloat(r.packages) || 0,
        weight:   parseFloat(r.weight)   || 0,
        cbm:      parseFloat(r.cbm)      || 0,
        revenue:  parseFloat(rv.toFixed(2)),
        cost:     parseFloat(ct.toFixed(2)),
        profit:   parseFloat(pt.toFixed(2)),
        gp_percent: rv > 0 ? parseFloat(((pt / rv) * 100).toFixed(1)) : 0
      }
    })

    const monthly_trend = trendRes.rows.map(r => {
      const rv = parseFloat(r.revenue), ct = parseFloat(r.cost), pt = parseFloat(r.revenue) - parseFloat(r.cost)
      return {
        month: new Date(r.month).toISOString().slice(0, 7),
        jobs: parseInt(r.jobs),
        revenue: parseFloat(rv.toFixed(2)),
        cost:    parseFloat(ct.toFixed(2)),
        profit:  parseFloat(pt.toFixed(2)),
        gp_percent: rv > 0 ? parseFloat(((pt / rv) * 100).toFixed(1)) : 0
      }
    })

    res.json({
      company, year: y, month: m,
      summary: {
        jobs: parseInt(s.jobs),
        packages: parseFloat(s.packages) || 0,
        weight:   parseFloat(s.weight)   || 0,
        cbm:      parseFloat(s.cbm)      || 0,
        revenue:  parseFloat(rev.toFixed(2)),
        cost:     parseFloat(cst.toFixed(2)),
        profit:   parseFloat(pft.toFixed(2)),
        gp_percent: gp
      },
      by_mode,
      monthly_trend
    })
  } catch (err) {
    console.error(`[ZHL] ${req.method} ${req.url}`, err.message)
    res.status(500).json({ error: 'Something went wrong. Please try again.' })
  }
})

// ─── LEADS ───────────────────────────────────────────────────────────────────
app.get('/api/leads/stats', async (req, res) => {
  try {
    const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0,0,0,0)
    const [activeRes, wonRes, industryRes, statusRes] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS total, COALESCE(SUM(quoted_price),0) AS pipeline_value
                  FROM leads WHERE (is_archived IS NULL OR is_archived=FALSE) AND status NOT IN ('Won','Lost')`),
      // won_at (set when a lead's status first flips to Won) reflects when the deal
      // actually closed, not when the lead was originally created — a lead that took
      // 6 weeks to close should count in the month it won, not be excluded entirely.
      // Falls back to created_at for leads won before won_at existed.
      pool.query(`SELECT COUNT(*) AS count, COALESCE(SUM(quoted_price),0) AS value
                  FROM leads WHERE status='Won' AND COALESCE(won_at, created_at)>=$1`, [monthStart]),
      pool.query(`SELECT industry, COUNT(*) AS count FROM leads
                  WHERE (is_archived IS NULL OR is_archived=FALSE) GROUP BY industry ORDER BY count DESC`),
      pool.query(`SELECT status, COUNT(*) AS count FROM leads
                  WHERE (is_archived IS NULL OR is_archived=FALSE) GROUP BY status`),
    ])
    res.json({
      total_active:     parseInt(activeRes.rows[0].total),
      pipeline_value:   parseFloat(activeRes.rows[0].pipeline_value),
      won_this_month:   { count: parseInt(wonRes.rows[0].count), value: parseFloat(wonRes.rows[0].value) },
      by_industry:      industryRes.rows.map(r => ({ industry: r.industry, count: parseInt(r.count) })),
      by_status:        Object.fromEntries(statusRes.rows.map(r => [r.status, parseInt(r.count)])),
    })
  } catch (err) {
    console.error(`[ZHL] ${req.method} ${req.url}`, err.message)
    res.status(500).json({ error: 'Something went wrong. Please try again.' })
  }
})

// ── User Profile ─────────────────────────────────────────────────────────────
app.get('/api/profile', async (req, res) => {
  try {
    const email = req.user.email
    const r = await pool.query('SELECT * FROM user_profiles WHERE email=$1', [email])
    res.json(r.rows[0] || { email, display_name: '', designation: '', signature_data: '' })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.put('/api/profile', async (req, res) => {
  try {
    const email = req.user.email
    const { display_name, designation, signature_data } = req.body
    await pool.query(`
      INSERT INTO user_profiles (email, display_name, designation, signature_data, updated_at)
      VALUES ($1,$2,$3,$4,NOW())
      ON CONFLICT (email) DO UPDATE SET
        display_name=$2, designation=$3, signature_data=$4, updated_at=NOW()
    `, [email, display_name || '', designation || '', signature_data || ''])
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.get('/api/leads/new-count', async (req, res) => {
  try {
    const since = req.query.since ? new Date(req.query.since) : new Date(0)
    const r = await pool.query(
      `SELECT COUNT(*) as count FROM leads WHERE created_at > $1 AND (is_archived IS NULL OR is_archived = FALSE)`,
      [since]
    )
    res.json({ count: parseInt(r.rows[0].count) })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/leads', async (req, res) => {
  try {
    const archived = req.query.archived === 'true'
    const where = archived ? `WHERE is_archived=TRUE` : `WHERE (is_archived IS NULL OR is_archived=FALSE)`
    // Paginated: every load used to pull the entire table, which only gets slower as
    // leads accumulate. Defaults to the first 100 if the caller doesn't specify.
    const limit = Math.min(parseInt(req.query.limit) || 100, 500)
    const offset = Math.max(parseInt(req.query.offset) || 0, 0)
    const [rows, count] = await Promise.all([
      pool.query(
        `SELECT id, ref, customer_name, customer_email, quoted_price, industry, lead_score,
                status, stage, risk_level, source, notes, created_at, next_follow_up, is_archived,
                claimed_by, claimed_at, follow_up_note, lost_reason, simple_mode, converted_job_id,
                contact_person, phone_number, load_type, origin, destination, service_type,
                incoterm, container_size, lead_dimensions, commodity_name, hs_code, lead_quantity,
                lead_weight, packaging_type, pickup_address, delivery_address,
                special_handling_notes, addons, cargo_lines, won_at, dormant_at
         FROM leads ${where} ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
        [limit, offset]
      ),
      pool.query(`SELECT COUNT(*) as total FROM leads ${where}`),
    ])
    res.json({ leads: rows.rows, total: parseInt(count.rows[0].total) })
  } catch (err) {
    console.error(`[ZHL] ${req.method} ${req.url}`, err.message)
    res.status(500).json({ error: 'Something went wrong. Please try again.' })
  }
})

app.post('/api/leads', async (req, res) => {
  try {
    const f = req.body || {}
    const ref = `ZL-${Date.now()}`
    const r = await pool.query(
      `INSERT INTO leads (ref, customer_name, customer_email, quoted_price, industry,
         lead_score, status, stage, risk_level, source, notes, next_follow_up)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [ ref, f.customer_name||'', f.customer_email||'',
        parseFloat(f.quoted_price)||0, f.industry||'General',
        parseInt(f.lead_score)||5, f.status||'New Lead', f.stage||'',
        f.risk_level||'Medium', f.source||'manual', f.notes||'',
        f.next_follow_up||null ]
    )
    res.status(201).json(r.rows[0])
  } catch (err) {
    console.error(`[ZHL] ${req.method} ${req.url}`, err.message)
    res.status(500).json({ error: 'Something went wrong. Please try again.' })
  }
})

app.put('/api/leads/:id', async (req, res) => {
  try {
    // claimed_by is deliberately NOT in this allowlist — it's only settable through the
    // dedicated PUT /api/leads/:id/claim endpoint, which does an atomic check-then-claim.
    // Allowing it here let any caller silently steal or un-claim a lead with no conflict
    // check at all, bypassing the whole point of the claim workflow.
    const allowed = ['customer_name','customer_email','quoted_price','industry',
                     'status','stage','risk_level','source','notes','next_follow_up','is_archived',
                     'follow_up_note','lost_reason',
                     'contact_person','phone_number','load_type','origin','destination',
                     'service_type','incoterm','container_size','lead_dimensions','commodity_name',
                     'hs_code','lead_quantity','lead_weight','packaging_type','pickup_address',
                     'delivery_address','special_handling_notes','addons']
    const updates = {}
    allowed.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f] })
    // Stamp won_at the first time a lead's status flips to Won, so "won this month"
    // stats can be based on when the deal actually closed, not when the lead was created.
    if (updates.status === 'Won') updates.won_at = new Date()
    if (Object.keys(updates).length) {
      const cols = Object.keys(updates).map((k,i) => `${k}=$${i+1}`).join(', ')
      const vals = [...Object.values(updates), req.params.id]
      await pool.query(`UPDATE leads SET ${cols} WHERE id=$${vals.length}`, vals)
    }
    const updated = (await pool.query('SELECT * FROM leads WHERE id=$1', [req.params.id])).rows[0]
    res.json(updated)
  } catch (err) {
    console.error(`[ZHL] ${req.method} ${req.url}`, err.message)
    res.status(500).json({ error: 'Something went wrong. Please try again.' })
  }
})

app.delete('/api/leads/:id', async (req, res) => {
  try {
    const lead = (await pool.query('SELECT customer_email, customer_name, industry, source, ref FROM leads WHERE id=$1', [req.params.id])).rows[0]
    if (!lead) return res.status(404).json({ error: 'Lead not found' })
    if (lead.customer_email) {
      // DO UPDATE (not DO NOTHING) — a repeat customer submitting a new lead months later
      // under a different company name/industry should refresh marketing_contacts with
      // their latest info, not keep showing whatever their very first inquiry looked like.
      await pool.query(
        `INSERT INTO marketing_contacts (email, customer_name, industry, source, lead_ref, archived_at)
         VALUES ($1,$2,$3,$4,$5,NOW())
         ON CONFLICT (email) DO UPDATE SET
           customer_name = EXCLUDED.customer_name,
           industry = EXCLUDED.industry,
           source = EXCLUDED.source,
           lead_ref = EXCLUDED.lead_ref,
           archived_at = NOW()`,
        [lead.customer_email, lead.customer_name, lead.industry, lead.source, lead.ref]
      )
    }
    await pool.query('DELETE FROM leads WHERE id=$1', [req.params.id])
    res.json({ success: true })
  } catch (err) {
    console.error(`[ZHL] ${req.method} ${req.url}`, err.message)
    res.status(500).json({ error: 'Something went wrong. Please try again.' })
  }
})

app.put('/api/leads/:id/claim', async (req, res) => {
  try {
    const existing = await pool.query('SELECT claimed_by FROM leads WHERE id=$1', [req.params.id])
    if (!existing.rows.length) return res.status(404).json({ error: 'Lead not found' })
    if (existing.rows[0].claimed_by) {
      return res.status(409).json({ error: 'Already claimed', claimed_by: existing.rows[0].claimed_by })
    }
    const claimedBy = req.user?.email || req.user?.id || 'Unknown'
    const r = await pool.query(
      'UPDATE leads SET claimed_by=$1, claimed_at=NOW() WHERE id=$2 RETURNING *',
      [claimedBy, req.params.id]
    )
    res.json(r.rows[0])
  } catch (err) {
    console.error(`[ZHL] ${req.method} ${req.url}`, err.message)
    res.status(500).json({ error: 'Something went wrong. Please try again.' })
  }
})

// Turns a Won lead into a real job. Shipper/consignee are deliberately left
// blank (the RFQ form only has one company + one pickup/delivery address, not
// a clean shipper-vs-consignee split) — staff fill those in on the job itself.
// quoted_price is never turned into a billing line; it's an unreviewed
// estimate, so it only ever appears as a reference note on the job.
// Blocked both here and by hiding the button once converted_job_id is set,
// so double-clicking can't create two jobs from the same lead.
app.post('/api/leads/:id/convert-to-job', async (req, res) => {
  try {
    const mode = (req.body?.mode || '').trim()
    if (!mode) return res.status(400).json({ error: 'A mode must be selected before converting.' })

    const lead = (await pool.query('SELECT * FROM leads WHERE id=$1', [req.params.id])).rows[0]
    if (!lead) return res.status(404).json({ error: 'Lead not found' })
    if (lead.converted_job_id) {
      return res.status(409).json({ error: 'Already converted', jobId: lead.converted_job_id })
    }

    const { job_number, year, sequence } = await generateJobNumber()
    const f = mapLeadToJobFields(lead, mode)

    const result = await pool.query(`
      INSERT INTO jobs (job_number, year, sequence, mode, status, notes, created_by,
        customer_name, customer_contact_name, customer_contact_number, customer_email,
        pickup_address, delivery_address, commodity, dimensions, weight, packages, customer_ref)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
      RETURNING *
    `, [
      job_number, year, sequence, f.mode, f.status, f.notes, req.user?.email || '',
      f.customer_name, f.customer_contact_name, f.customer_contact_number, f.customer_email,
      f.pickup_address, f.delivery_address, f.commodity, f.dimensions, f.weight, f.packages,
      f.customer_ref
    ])

    const job = result.rows[0]
    await pool.query('UPDATE leads SET converted_job_id=$1 WHERE id=$2', [job.id, lead.id])

    // Carry the customer's paperwork onto the job. The same stored file is referenced
    // by both rows rather than copied, so the lead keeps its record of what was sent
    // and nobody has to ask the customer to re-send a packing list they already gave us.
    const carried = await pool.query(
      `INSERT INTO documents (job_id, file_name, doc_type, file_url)
       SELECT $1, file_name, doc_type, file_url FROM lead_documents WHERE lead_id=$2
       RETURNING id`,
      [job.id, lead.id]
    )

    console.log(`[ZHL] Converted lead ${lead.ref} -> job ${job.job_number}${carried.rowCount ? ` (${carried.rowCount} document(s) carried over)` : ''}`)
    res.status(201).json({
      success: true, jobId: job.id, job_number: job.job_number,
      documents_carried: carried.rowCount,
    })
  } catch (err) {
    console.error(`[ZHL] ${req.method} ${req.url}`, err.message)
    res.status(500).json({ error: 'Something went wrong. Please try again.' })
  }
})

// ─── AI EMAIL GENERATOR ──────────────────────────────────────────────────────
app.post('/api/leads/:id/generate-email', async (req, res) => {
  try {
    const lead = (await pool.query('SELECT * FROM leads WHERE id=$1', [req.params.id])).rows[0]
    if (!lead) return res.status(404).json({ error: 'Lead not found' })

    const { email_type, options = {} } = req.body
    const clientName = lead.customer_name || 'there'

    let userPrompt = ''
    if (email_type === 'info_request') {
      const fields = (options.fields || []).join(', ') || 'missing shipment details'
      const custom = options.custom_questions ? ` Also ask: ${options.custom_questions}` : ''
      userPrompt = `Write an email to ${clientName} (${lead.customer_email || 'the client'}) requesting the following missing information for their freight enquiry: ${fields}.${custom} Freight context from their enquiry: ${lead.notes || 'No additional notes.'}`
    } else if (email_type === 'quote_confirmation') {
      const price = lead.quoted_price > 0 ? `SGD ${Number(lead.quoted_price).toLocaleString()}` : 'as per our discussion'
      const includes = (options.include || []).join(', ') || 'standard terms'
      userPrompt = `Write a quote confirmation email to ${clientName} confirming their freight quote of ${price}. Include in the email: ${includes}. Freight context: ${lead.notes || 'Standard shipment.'}`
    } else if (email_type === 'introduction') {
      const services = (options.services || []).join(', ') || 'freight forwarding services'
      const angle = options.angle || 'competitive rates and reliable service across Asia'
      userPrompt = `Write a concise cold introduction email to ${clientName} at their company. Highlight these freight services: ${services}. Key value proposition: ${angle}. Do not use their email address in the body.`
    } else {
      return res.status(400).json({ error: 'Invalid email_type' })
    }

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: 'You are a professional logistics sales representative at Zhenghe Logistics, a freight forwarding company based in Singapore. Write concise, professional emails in English. Be warm but efficient. Use the client\'s name naturally. Never invent rates, prices, or terms not provided to you. Always sign off as "Zhenghe Logistics Team".',
      tools: [{
        name: 'compose_email',
        description: 'Compose a professional logistics email',
        input_schema: {
          type: 'object',
          properties: {
            subject: { type: 'string', description: 'Concise email subject line' },
            body:    { type: 'string', description: 'Full email body with greeting and sign-off' }
          },
          required: ['subject', 'body']
        }
      }],
      tool_choice: { type: 'tool', name: 'compose_email' },
      messages: [{ role: 'user', content: userPrompt }]
    })

    const toolBlock = msg.content.find(c => c.type === 'tool_use' && c.name === 'compose_email')
    if (!toolBlock) return res.status(422).json({ error: 'AI did not return a structured email' })
    res.json(toolBlock.input)
  } catch (err) {
    console.error(`[ZHL] ${req.method} ${req.url}`, err.message)
    res.status(500).json({ error: 'Email generation failed. Please try again.' })
  }
})

// ─── RFQ WEBHOOK (public — no auth) ─────────────────────────────────────────
function rfqCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-rfq-secret')
}

app.options('/api/rfq', (req, res) => {
  rfqCors(res)
  res.status(200).end()
})

function inferIndustry(commodity) {
  const c = (commodity || '').toLowerCase()
  if (/electron|server|computing|software|hardware|semiconductor|component/.test(c)) return 'Tech'
  if (/pharma|medical|clinical|vaccine|biotech|chemical/.test(c)) return 'Pharmaceuticals'
  if (/textile|polyester|machinery|parts|industrial|factory|steel|metal/.test(c)) return 'Manufacturing'
  if (/food|agri|coconut|palm|grain|timber|mineral|commodity/.test(c)) return 'Commodities'
  if (/retail|garment|apparel|consumer|fashion|footwear/.test(c)) return 'Retail'
  return 'General'
}

function buildRfqNotes(b, mode, addons) {
  const s = (v) => v || '—'
  const lines = [
    `MODE: ${mode} | ROUTE: ${s(b.origin)} → ${s(b.destination)}`,
    `SERVICE: ${s(b.serviceType)} | INCOTERM: ${s(b.incoterm)} | LOAD: ${s(b.loadType)}`,
  ]
  if (b.containerSize) lines.push(`CONTAINER: ${b.containerSize}`)
  lines.push('---', 'CARGO')
  if (b.commodityName)      lines.push(`  Commodity: ${b.commodityName}`)
  if (b.hsCode)             lines.push(`  HS Code: ${b.hsCode}`)
  if (b.quantity)           lines.push(`  Quantity: ${b.quantity}`)
  if (b.weight)             lines.push(`  Weight: ${b.weight}`)
  if (b.packagingType)      lines.push(`  Packaging: ${b.packagingType}`)
  if (b.dimensions)         lines.push(`  Dimensions: ${b.dimensions}`)
  lines.push('---', 'CONTACT')
  lines.push(`  Company: ${s(b.companyName)}`)
  lines.push(`  Person: ${s(b.contactPerson)}`)
  lines.push(`  Email: ${s(b.emailAddress)}`)
  lines.push(`  Phone: ${s(b.phoneNumber)}`)
  if (b.pickupAddress || b.deliveryAddress) {
    lines.push('---', 'ADDRESSES')
    if (b.pickupAddress)   lines.push(`  Pickup: ${b.pickupAddress}`)
    if (b.deliveryAddress) lines.push(`  Delivery: ${b.deliveryAddress}`)
  }
  if (addons || b.specialHandlingNotes) {
    lines.push('---')
    if (addons)                  lines.push(`ADDONS: ${addons}`)
    if (b.specialHandlingNotes)  lines.push(`SPECIAL HANDLING: ${b.specialHandlingNotes}`)
  }
  lines.push('---', `Submitted: ${new Date().toISOString()}`)
  return lines.join('\n')
}

app.post('/api/rfq', async (req, res) => {
  rfqCors(res)
  // Optional shared-secret gate. When RFQ_SHARED_SECRET is set, callers (the Zhenghe site,
  // server-side) must send a matching x-rfq-secret header. Unset = fully public (prior behavior).
  const rfqSecret = process.env.RFQ_SHARED_SECRET
  if (rfqSecret && req.headers['x-rfq-secret'] !== rfqSecret) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  try {
    const b = req.body || {}
    // This endpoint is intentionally public (the site can't easily carry the shared
    // secret from a plain contact form) — cap every field length so an anonymous caller
    // can't flood the leads table with unbounded garbage/oversized records.
    const MAX_LEN = 2000
    const str = (v) => (v == null ? '' : String(v).slice(0, MAX_LEN))

    const companyName        = str(b.companyName)
    const contactPerson      = str(b.contactPerson)
    const emailAddress       = str(b.emailAddress)
    const phoneNumber        = str(b.phoneNumber)
    const mode               = (str(b.mode) || 'SEA').toUpperCase()
    const origin             = str(b.origin)
    const destination        = str(b.destination)
    const serviceType        = str(b.serviceType)
    const incoterm           = str(b.incoterm)
    const loadType           = str(b.loadType)
    const containerSize      = str(b.containerSize)
    const dimensions         = str(b.dimensions)
    const commodityName      = str(b.commodityName)
    const hsCode             = str(b.hsCode)
    const quantity           = str(b.quantity)
    const weight             = str(b.weight)
    const packagingType      = str(b.packagingType)
    const pickupAddress      = str(b.pickupAddress)
    const deliveryAddress    = str(b.deliveryAddress)
    const specialHandlingNotes = str(b.specialHandlingNotes)
    const addons = Array.isArray(b.addons) ? b.addons.join(', ') : str(b.addons)

    // Structured quote context (optional). Callers that don't have a quote yet
    // (e.g. the site's plain contact form) simply omit these — quoted_price
    // stays 0 and quote_ref/source_ref stay null, same as before this field
    // existed. specialHandlingNotes-packing (option b) still works unchanged
    // and is not replaced by this.
    const quoteRef = b.quoteRef != null ? str(b.quoteRef) : null
    const sourceRef = b.sourceRef != null ? str(b.sourceRef) : null
    const quotedPriceNum = parseFloat(b.quotedPrice)
    const quotedPrice = Number.isFinite(quotedPriceNum) ? quotedPriceNum : 0

    // Idempotency: a retried submission carrying the same sourceRef (the site's
    // own booking/enquiry number) must not create a second lead — return the
    // original instead of inserting again.
    if (sourceRef) {
      const dupe = await pool.query(
        `SELECT id, ref FROM leads WHERE source_ref = $1 LIMIT 1`,
        [sourceRef]
      )
      if (dupe.rows[0]) {
        return res.status(200).json({ success: true, leadId: dupe.rows[0].id, ref: dupe.rows[0].ref, deduped: true })
      }
    }

    const ref      = `ZL-${Date.now()}`
    const industry = inferIndustry(commodityName)
    const notes    = buildRfqNotes(
      { companyName, contactPerson, emailAddress, phoneNumber, origin, destination,
        serviceType, incoterm, loadType, containerSize, dimensions, commodityName,
        hsCode, quantity, weight, packagingType, pickupAddress, deliveryAddress, specialHandlingNotes },
      mode, addons
    )
    const cargoLines = extractCargoLines(b, specialHandlingNotes)

    const r = await pool.query(
      `INSERT INTO leads
         (ref, customer_name, customer_email, quoted_price, industry,
          lead_score, status, stage, risk_level, source, notes, quote_ref, source_ref,
          contact_person, phone_number, simple_mode, load_type, origin, destination,
          service_type, incoterm, container_size, lead_dimensions, commodity_name, hs_code,
          lead_quantity, lead_weight, packaging_type, pickup_address, delivery_address,
          special_handling_notes, addons, cargo_lines)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,
               $22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33)
       RETURNING id`,
      [ref, companyName || contactPerson, emailAddress, quotedPrice, industry,
       5, 'RFQ Received', 'RFQ Received', 'High', 'website', notes, quoteRef, sourceRef,
       contactPerson, phoneNumber, mode, loadType, origin, destination,
       serviceType, incoterm, containerSize, dimensions, commodityName, hsCode,
       quantity, weight, packagingType, pickupAddress, deliveryAddress,
       specialHandlingNotes, addons, JSON.stringify(cargoLines)]
    )

    const leadId = r.rows[0].id

    // Attachments are fetched after the lead row exists, so a failing file can never
    // cost us the enquiry itself. Errors are logged and swallowed inside.
    const attachments = normaliseAttachments(b)
    const storedDocs = attachments.length ? await ingestLeadAttachments(leadId, attachments) : []

    console.log(`[ZHL] RFQ saved: ${ref} | ${companyName || contactPerson || '(anonymous)'} | ${industry}${quoteRef ? ` | quote ${quoteRef}` : ''}${attachments.length ? ` | ${storedDocs.length}/${attachments.length} attachments` : ''}`)
    res.status(201).json({
      success: true, leadId, ref,
      // Reported back so the sending site can tell whether its files landed.
      attachments_received: attachments.length,
      attachments_stored: storedDocs.length,
    })
  } catch (err) {
    console.error('[ZHL] POST /api/rfq', err.message)
    res.status(500).json({ error: 'Something went wrong. Please try again.' })
  }
})

// ─── PUBLIC SHIPMENT TRACKING ────────────────────────────────────────────────
// GET /api/track?ref=<job_number|customer_ref>[&type=] — public read for the
// Zhenghe customer site's tracking page. Auth-exempt (see the allowlist above),
// but requires a bearer secret when TRACKING_API_SECRET is set (the site sends
// `Authorization: Bearer <secret>` server-side).
//
// PRIVACY: refs (job numbers / customer refs) are guessable, so this returns
// ONLY non-sensitive movement milestones — status, generic events, dates, and a
// coarse mode label. It deliberately never exposes names, addresses, commodity,
// contacts, or any cost/billing/GP field. Voided jobs are treated as not-found.
function fmtTrackDate(d) {
  if (!d) return ''
  const dt = new Date(d)
  return isNaN(dt.getTime()) ? String(d) : dt.toISOString().slice(0, 10)
}

app.get('/api/track', async (req, res) => {
  const trackSecret = process.env.TRACKING_API_SECRET
  if (trackSecret && req.headers.authorization !== `Bearer ${trackSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  const ref = (req.query.ref || '').toString().trim()
  const type = (req.query.type || 'zhl').toString()
  if (!ref) return res.status(400).json({ error: 'ref required' })

  try {
    const r = await pool.query(
      `SELECT job_number, mode, status, date_out, eta, date_delivered, created_at
         FROM jobs
        WHERE (LOWER(job_number) = LOWER($1) OR LOWER(customer_ref) = LOWER($1))
          AND (status IS NULL OR status <> 'Voided')
        ORDER BY created_at DESC
        LIMIT 1`,
      [ref]
    )
    const job = r.rows[0]
    if (!job) return res.status(404).json({ error: 'Shipment not found' })

    const delivered = !!job.date_delivered || job.status === 'Completed' || job.status === 'Delivered'
    const friendly = delivered
      ? 'Delivered'
      : ({ 'New': 'Booking received', 'In Progress': 'In transit', 'On Hold': 'On hold' }[job.status] || 'In progress')

    const events = [{ event: 'Booking received', loc: '', date: fmtTrackDate(job.created_at), done: true }]
    if (job.date_out) events.push({ event: 'Dispatched from origin', loc: '', date: fmtTrackDate(job.date_out), done: true })
    events.push({
      event: friendly,
      loc: '',
      date: fmtTrackDate(delivered ? (job.date_delivered || job.eta) : job.eta),
      done: delivered,
    })

    res.json({
      ref: job.job_number,
      type,
      route: job.mode || 'Shipment',
      status: friendly,
      events,
    })
  } catch (err) {
    console.error('[ZHL] GET /api/track', err.message)
    res.status(500).json({ error: 'Something went wrong. Please try again.' })
  }
})

// ─── CUSTOMER PORTAL FEEDS (documents + invoices) ────────────────────────────
// GET /api/customer/documents?email= and GET /api/customer/invoices?email=
// power the Zhenghe site's customer portal (Phase 3). Auth-exempt from the
// Supabase-session guard above (customers aren't ZHL staff), but — unlike
// /rfq and /track — these ALWAYS require a bearer secret: they return billing
// amounts and document links scoped only by an email string the customer
// typed at signup, which is too weak a boundary to leave optionally-public.
// If CUSTOMER_API_SECRET isn't set, the endpoints refuse everything (503)
// rather than silently going public.
//
// Scoping is by exact (case-insensitive) match against jobs.customer_email,
// a free-text field ops types in — typos mean a job just won't show up for
// that customer. Accepted limitation, not fixed here.
//
// Cost lines, vendor names, GP/margin figures and shipper/consignee/contact
// details are never touched by either handler.
function requireCustomerSecret(req, res) {
  const secret = process.env.CUSTOMER_API_SECRET
  if (!secret) {
    res.status(503).json({ error: 'Customer API not configured' })
    return false
  }
  if (req.headers.authorization !== `Bearer ${secret}`) {
    res.status(401).json({ error: 'Unauthorized' })
    return false
  }
  return true
}

app.get('/api/customer/documents', async (req, res) => {
  if (!requireCustomerSecret(req, res)) return
  const email = (req.query.email || '').toString().trim()
  if (!email) return res.status(400).json({ error: 'email required' })

  try {
    const r = await pool.query(
      `SELECT d.id, d.file_name, d.doc_type, d.upload_date, d.file_url, j.job_number
         FROM documents d
         JOIN jobs j ON j.id = d.job_id
        WHERE LOWER(j.customer_email) = LOWER($1)
          AND (j.status IS NULL OR j.status <> 'Voided')
        ORDER BY d.upload_date DESC`,
      [email]
    )
    res.json(r.rows.map((row) => ({
      id: row.id,
      fileName: row.file_name,
      docType: row.doc_type,
      uploadedAt: row.upload_date,
      fileUrl: row.file_url,
      jobNumber: row.job_number,
    })))
  } catch (err) {
    console.error('[ZHL] GET /api/customer/documents', err.message)
    res.status(500).json({ error: 'Something went wrong. Please try again.' })
  }
})

app.get('/api/customer/invoices', async (req, res) => {
  if (!requireCustomerSecret(req, res)) return
  const email = (req.query.email || '').toString().trim()
  if (!email) return res.status(400).json({ error: 'email required' })

  try {
    // Only surface jobs with an issued invoice number. billing_lines exist
    // while ops is still building a job's charges; the customer-facing page
    // promises FINAL invoices, so an assigned zhl_invoice_no is the gate for
    // "this has actually been invoiced" — never show draft/unconfirmed charges.
    const jobsR = await pool.query(
      `SELECT id, job_number, zhl_invoice_no, mode, status, date_delivered, created_at
         FROM jobs
        WHERE LOWER(customer_email) = LOWER($1)
          AND (status IS NULL OR status <> 'Voided')
          AND zhl_invoice_no IS NOT NULL
          AND zhl_invoice_no <> ''
        ORDER BY created_at DESC`,
      [email]
    )
    if (!jobsR.rows.length) return res.json([])

    const jobIds = jobsR.rows.map((j) => j.id)
    const linesR = await pool.query(
      `SELECT job_id, service, unit, qty, rate, rate_local, currency
         FROM billing_lines
        WHERE job_id = ANY($1::int[])`,
      [jobIds]
    )
    const linesByJob = new Map()
    for (const line of linesR.rows) {
      if (!linesByJob.has(line.job_id)) linesByJob.set(line.job_id, [])
      linesByJob.get(line.job_id).push(line)
    }

    // Only jobs with at least one billing line have anything to invoice.
    const invoices = jobsR.rows
      .filter((j) => linesByJob.has(j.id))
      .map((j) => {
        const lines = linesByJob.get(j.id)
        return {
          jobNumber: j.job_number,
          invoiceNo: j.zhl_invoice_no || '',
          invoiceDate: fmtTrackDate(j.date_delivered) || null,
          mode: j.mode || '',
          status: j.status || '',
          // rate is always stored SGD-converted (see frontend JobDetail.jsx
          // toSGD-on-save); rate_local + currency are the line's own display
          // amount. Total is the unambiguous SGD figure; lines show what the
          // customer actually agreed to per line.
          totalSgd: lines.reduce((sum, l) => sum + (Number(l.rate) || 0) * (Number(l.qty) || 1), 0),
          lines: lines.map((l) => ({
            service: l.service || '',
            unit: l.unit || '',
            qty: Number(l.qty) || 1,
            amount: Number(l.rate_local ?? l.rate) || 0,
            currency: l.currency || 'SGD',
          })),
        }
      })
    res.json(invoices)
  } catch (err) {
    console.error('[ZHL] GET /api/customer/invoices', err.message)
    res.status(500).json({ error: 'Something went wrong. Please try again.' })
  }
})

// ─── LEADS DORMANCY CRON ─────────────────────────────────────────────────────
// Called by Vercel cron daily. Leads older than 30 days that never closed are
// ARCHIVED (is_archived = TRUE, dormant_at stamped) — never deleted. The full
// record is retained so the team can still reach back out later ("do you still
// need this shipped?"), and archived leads remain viewable/exportable in the
// Leads page via the "Show archived" toggle and recoverable via the lead card.
// Their email is additionally copied into marketing_contacts for list-building.
// Won / already-converted leads are excluded entirely and stay in the active list.
//
// NOTE: the route path still reads "purge-old" because it is wired into the cron
// config in vercel.json; renaming it would need a coordinated change there. It no
// longer purges anything — nothing in this app deletes a lead automatically.
app.get('/api/leads/purge-old', async (req, res) => {
  const auth = req.headers.authorization
  // Fail CLOSED: if CRON_SECRET is ever unset/misconfigured, refuse the request rather
  // than silently letting it through unauthenticated (this route is exempted from the
  // global requireAuth guard, so this check is the only gate it has).
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  try {
    await ensureDB()
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - 30)
    // Never touch a lead that closed, and never re-process one that's already archived
    // (without the is_archived guard this would re-stamp dormant_at every single night).
    const DORMANCY_SCOPE = `
      AND COALESCE(status,'') <> 'Won'
      AND COALESCE(stage,'') <> 'Won'
      AND converted_job_id IS NULL
      AND (is_archived IS NULL OR is_archived = FALSE)
    `

    const oldLeads = await pool.query(
      `SELECT id, ref, customer_name, customer_email, industry, source
       FROM leads WHERE created_at < $1 AND (customer_email IS NOT NULL AND customer_email <> '') ${DORMANCY_SCOPE}`,
      [cutoff]
    )

    let contactsSaved = 0, skipped = 0, archived = 0
    for (const lead of oldLeads.rows) {
      try {
        await pool.query(
          `INSERT INTO marketing_contacts (email, customer_name, industry, source, lead_ref, archived_at)
           VALUES ($1,$2,$3,$4,$5,NOW())
           ON CONFLICT (email) DO UPDATE SET
             customer_name = EXCLUDED.customer_name,
             industry = EXCLUDED.industry,
             source = EXCLUDED.source,
             lead_ref = EXCLUDED.lead_ref,
             archived_at = NOW()`,
          [lead.customer_email, lead.customer_name, lead.industry, lead.source, lead.ref]
        )
        contactsSaved++
      } catch { skipped++ }
    }

    // Archive rather than delete. A failed marketing_contacts copy above no longer costs
    // anything either — the lead itself is still here in full, so nothing is lost.
    const arch = await pool.query(
      `UPDATE leads SET is_archived = TRUE, dormant_at = NOW()
       WHERE created_at < $1 ${DORMANCY_SCOPE}`,
      [cutoff]
    )
    archived = arch.rowCount

    console.log(`[ZHL] Leads dormancy sweep: ${archived} archived, ${contactsSaved} emails copied to marketing contacts, ${skipped} skipped`)
    res.json({ success: true, archived, contactsSaved, skipped, cutoff })
  } catch (err) {
    console.error('[ZHL] leads dormancy sweep error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ─── VENDOR RATE CARDS ───────────────────────────────────────────────────────
// Reference sheet of the negotiated rates our transport partners give us, read on the
// job screen to build cost lines without re-keying a PDF. Cost side only — these never
// touch billing lines.

app.get('/api/rate-cards', async (req, res) => {
  try {
    await ensureDB()
    const where = []
    const params = []
    if (req.query.vendor) { params.push(`%${req.query.vendor}%`); where.push(`vendor_name ILIKE $${params.length}`) }
    if (req.query.mode)   { params.push(req.query.mode);          where.push(`(mode = $${params.length} OR COALESCE(mode,'') = '')`) }
    if (req.query.active === 'true') where.push(`is_active = TRUE`)
    const sql = `SELECT * FROM rate_cards ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY vendor_name, id`
    const cards = (await pool.query(sql, params)).rows
    if (!cards.length) return res.json([])

    // One query for all lines rather than one per card — this list is read every time
    // the job-screen picker opens.
    const lines = (await pool.query(
      `SELECT * FROM rate_lines WHERE card_id = ANY($1::int[]) ORDER BY sort_order, id`,
      [cards.map(c => c.id)]
    )).rows
    const byCard = {}
    for (const l of lines) (byCard[l.card_id] = byCard[l.card_id] || []).push(l)
    res.json(cards.map(c => ({ ...c, lines: byCard[c.id] || [] })))
  } catch (err) {
    console.error(`[ZHL] ${req.method} ${req.url}`, err.message)
    res.status(500).json({ error: 'Something went wrong. Please try again.' })
  }
})

app.post('/api/rate-cards', async (req, res) => {
  try {
    await ensureDB()
    const b = req.body || {}
    if (!b.vendor_name) return res.status(400).json({ error: 'Vendor name is required.' })
    const r = await pool.query(
      `INSERT INTO rate_cards (vendor_name, title, mode, currency, volumetric_divisor,
                               valid_from, valid_to, notes, source_file_url, is_active, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [b.vendor_name, b.title || '', b.mode || '', b.currency || 'SGD',
       b.volumetric_divisor || null, b.valid_from || null, b.valid_to || null,
       b.notes || '', b.source_file_url || '',
       b.is_active !== undefined ? b.is_active : true, req.user?.email || '']
    )
    res.status(201).json({ ...r.rows[0], lines: [] })
  } catch (err) {
    console.error(`[ZHL] ${req.method} ${req.url}`, err.message)
    res.status(500).json({ error: 'Something went wrong. Please try again.' })
  }
})

app.put('/api/rate-cards/:id', async (req, res) => {
  try {
    await ensureDB()
    const allowed = ['vendor_name','title','mode','currency','volumetric_divisor',
                     'valid_from','valid_to','notes','source_file_url','is_active']
    const updates = {}
    allowed.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f] })
    if (Object.keys(updates).length) {
      updates.updated_at = new Date()
      const cols = Object.keys(updates).map((k, i) => `${k}=$${i + 1}`).join(', ')
      const vals = [...Object.values(updates), req.params.id]
      await pool.query(`UPDATE rate_cards SET ${cols} WHERE id=$${vals.length}`, vals)
    }
    const card = (await pool.query('SELECT * FROM rate_cards WHERE id=$1', [req.params.id])).rows[0]
    if (!card) return res.status(404).json({ error: 'Rate card not found' })
    const lines = (await pool.query('SELECT * FROM rate_lines WHERE card_id=$1 ORDER BY sort_order, id', [req.params.id])).rows
    res.json({ ...card, lines })
  } catch (err) {
    console.error(`[ZHL] ${req.method} ${req.url}`, err.message)
    res.status(500).json({ error: 'Something went wrong. Please try again.' })
  }
})

app.delete('/api/rate-cards/:id', async (req, res) => {
  try {
    await ensureDB()
    await pool.query('DELETE FROM rate_cards WHERE id=$1', [req.params.id]) // lines cascade
    res.json({ success: true })
  } catch (err) {
    console.error(`[ZHL] ${req.method} ${req.url}`, err.message)
    res.status(500).json({ error: 'Something went wrong. Please try again.' })
  }
})

// `bands` arrives as an array and must reach JSONB as a string; passing the array
// straight through makes node-postgres send a Postgres array literal instead.
function bandsParam(v) {
  if (v === undefined || v === null || v === '') return null
  return typeof v === 'string' ? v : JSON.stringify(v)
}

app.post('/api/rate-cards/:id/lines', async (req, res) => {
  try {
    await ensureDB()
    const b = req.body || {}
    const r = await pool.query(
      `INSERT INTO rate_lines (card_id, charge_name, category, basis, rate, min_charge, min_qty,
                               bands, band_metric, currency, auto_apply, condition_note, remarks, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [req.params.id, b.charge_name || '', b.category || 'optional', b.basis || 'flat',
       b.rate ?? null, b.min_charge ?? null, b.min_qty ?? null, bandsParam(b.bands),
       b.band_metric || null, b.currency || null,
       b.auto_apply !== undefined ? b.auto_apply : false,
       b.condition_note || '', b.remarks || '', b.sort_order ?? 0]
    )
    res.status(201).json(r.rows[0])
  } catch (err) {
    console.error(`[ZHL] ${req.method} ${req.url}`, err.message)
    res.status(500).json({ error: 'Something went wrong. Please try again.' })
  }
})

app.put('/api/rate-cards/:id/lines/:lid', async (req, res) => {
  try {
    await ensureDB()
    const allowed = ['charge_name','category','basis','rate','min_charge','min_qty',
                     'bands','band_metric','currency','auto_apply','condition_note','remarks','sort_order']
    const updates = {}
    allowed.forEach(f => {
      if (req.body[f] !== undefined) updates[f] = f === 'bands' ? bandsParam(req.body[f]) : req.body[f]
    })
    if (!Object.keys(updates).length) {
      const cur = (await pool.query('SELECT * FROM rate_lines WHERE id=$1 AND card_id=$2', [req.params.lid, req.params.id])).rows[0]
      return cur ? res.json(cur) : res.status(404).json({ error: 'Rate line not found' })
    }
    const cols = Object.keys(updates).map((k, i) => `${k}=$${i + 1}`).join(', ')
    const vals = [...Object.values(updates), req.params.lid, req.params.id]
    const r = await pool.query(
      `UPDATE rate_lines SET ${cols} WHERE id=$${vals.length - 1} AND card_id=$${vals.length} RETURNING *`, vals)
    if (!r.rows[0]) return res.status(404).json({ error: 'Rate line not found' })
    res.json(r.rows[0])
  } catch (err) {
    console.error(`[ZHL] ${req.method} ${req.url}`, err.message)
    res.status(500).json({ error: 'Something went wrong. Please try again.' })
  }
})

app.delete('/api/rate-cards/:id/lines/:lid', async (req, res) => {
  try {
    await ensureDB()
    await pool.query('DELETE FROM rate_lines WHERE id=$1 AND card_id=$2', [req.params.lid, req.params.id])
    res.json({ success: true })
  } catch (err) {
    console.error(`[ZHL] ${req.method} ${req.url}`, err.message)
    res.status(500).json({ error: 'Something went wrong. Please try again.' })
  }
})

// Price a card's lines against a real job. Deliberately server-side: the maths lives in
// one tested module (rateCalc.js) rather than being reimplemented in the browser, which
// is how money logic drifts out of sync. `qtys` supplies quantities for the bases that
// can't be derived from the job (per_hour, per_head, ...), keyed by rate-line id.
app.post('/api/jobs/:id/rate-preview', async (req, res) => {
  try {
    await ensureDB()
    const { card_id, qtys = {} } = req.body || {}
    if (!card_id) return res.status(400).json({ error: 'card_id is required.' })

    const job = (await pool.query('SELECT weight, cbm, packages FROM jobs WHERE id=$1', [req.params.id])).rows[0]
    if (!job) return res.status(404).json({ error: 'Job not found' })

    const card = (await pool.query('SELECT * FROM rate_cards WHERE id=$1', [card_id])).rows[0]
    if (!card) return res.status(404).json({ error: 'Rate card not found' })

    const lines = (await pool.query(
      'SELECT * FROM rate_lines WHERE card_id=$1 ORDER BY sort_order, id', [card_id])).rows

    const metrics = deriveMetrics(job, { volumetricDivisor: card.volumetric_divisor })
    res.json({
      metrics,
      currency: card.currency || 'SGD',
      lines: lines.map(l => ({
        ...l,
        ...computeRateAmount(l, metrics, { qty: qtys[l.id] }),
      })),
    })
  } catch (err) {
    console.error(`[ZHL] ${req.method} ${req.url}`, err.message)
    res.status(500).json({ error: 'Something went wrong. Please try again.' })
  }
})

// ─── MONTHLY BD REPORT ───────────────────────────────────────────────────────
// Gathers a month of pipeline and revenue for the management meeting, and has Claude
// write the commentary around it.
//
// The division of labour is deliberate and load-bearing: every NUMBER in the response
// is computed here from the database, and the model is given those figures and asked
// only for words. It is never asked to count, total or calculate anything. A deck that
// goes to company leadership cannot contain a figure a language model invented.
//
// What the model is genuinely better at, and what it is actually used for, is reading
// the free-text lost_reason field across a month of losses and telling you that six of
// them were about transit time rather than price. No SQL query produces that.

function monthWindow(monthParam) {
  // Accepts YYYY-MM; defaults to the current month.
  const now = new Date()
  let year = now.getFullYear(), month = now.getMonth()
  if (/^\d{4}-\d{2}$/.test(monthParam || '')) {
    const [y, m] = monthParam.split('-').map(Number)
    if (m >= 1 && m <= 12) { year = y; month = m - 1 }
  }
  const start = new Date(year, month, 1)
  const end = new Date(year, month + 1, 1)
  const prevStart = new Date(year, month - 1, 1)
  const label = start.toLocaleDateString('en-SG', { month: 'long', year: 'numeric' })
  return { start, end, prevStart, label }
}

async function buildMonthlyReport(monthParam) {
  const { start, end, prevStart, label } = monthWindow(monthParam)

  const [leadsRes, prevLeadsRes, revenueRes, byModeRes, dormantRes, salesRes] = await Promise.all([
    pool.query(`SELECT * FROM leads WHERE created_at >= $1 AND created_at < $2`, [start, end]),
    pool.query(`SELECT * FROM leads WHERE created_at >= $1 AND created_at < $2`, [prevStart, start]),
    pool.query(`
      SELECT COALESCE(SUM(b.total),0) AS sale, COALESCE(SUM(c.total),0) AS cost, COUNT(*) AS jobs
      FROM jobs j
      LEFT JOIN (SELECT job_id, SUM(rate*qty) AS total FROM billing_lines GROUP BY job_id) b ON b.job_id = j.id
      LEFT JOIN (SELECT job_id, SUM(amount)   AS total FROM cost_lines    GROUP BY job_id) c ON c.job_id = j.id
      WHERE j.created_at >= $1 AND j.created_at < $2 AND COALESCE(j.status,'') <> 'Voided'`, [start, end]),
    pool.query(`
      SELECT COALESCE(NULLIF(j.mode,''),'Unspecified') AS mode,
             COUNT(*) AS jobs,
             COALESCE(SUM(b.total),0) AS sale,
             COALESCE(SUM(c.total),0) AS cost
      FROM jobs j
      LEFT JOIN (SELECT job_id, SUM(rate*qty) AS total FROM billing_lines GROUP BY job_id) b ON b.job_id = j.id
      LEFT JOIN (SELECT job_id, SUM(amount)   AS total FROM cost_lines    GROUP BY job_id) c ON c.job_id = j.id
      WHERE j.created_at >= $1 AND j.created_at < $2 AND COALESCE(j.status,'') <> 'Voided'
      GROUP BY 1 ORDER BY sale DESC`, [start, end]),
    // Not restricted to the month: the point of this list is old leads worth chasing.
    pool.query(`SELECT * FROM leads WHERE is_archived = TRUE ORDER BY quoted_price DESC NULLS LAST LIMIT 40`),
    pool.query(`
      SELECT COALESCE(NULLIF(claimed_by,''),'Unassigned') AS person,
             COUNT(*) FILTER (WHERE status='Won' OR stage='Won') AS won,
             COUNT(*) AS handled,
             COALESCE(SUM(quoted_price) FILTER (WHERE status='Won' OR stage='Won'),0) AS won_value
      FROM leads WHERE created_at >= $1 AND created_at < $2
      GROUP BY 1 ORDER BY won_value DESC`, [start, end]),
  ])

  const metrics = deriveLeadMetrics(leadsRes.rows)
  const prev = deriveLeadMetrics(prevLeadsRes.rows)
  const rev = revenueRes.rows[0] || {}
  const sale = Number(rev.sale) || 0
  const cost = Number(rev.cost) || 0

  return {
    month: label,
    generated_at: new Date().toISOString(),
    leads: metrics,
    previous: {
      received: prev.counts.received,
      won: prev.counts.won,
      wonValue: prev.value.won,
      winRate: prev.rates.winRate,
    },
    revenue: {
      jobs: Number(rev.jobs) || 0,
      sale: Math.round(sale * 100) / 100,
      cost: Math.round(cost * 100) / 100,
      profit: Math.round((sale - cost) * 100) / 100,
      gpPercent: sale > 0 ? Math.round(((sale - cost) / sale) * 1000) / 10 : 0,
      byMode: byModeRes.rows.map(r => {
        const s = Number(r.sale) || 0, c = Number(r.cost) || 0
        return {
          mode: r.mode, jobs: Number(r.jobs) || 0,
          sale: Math.round(s * 100) / 100,
          profit: Math.round((s - c) * 100) / 100,
          gpPercent: s > 0 ? Math.round(((s - c) / s) * 1000) / 10 : 0,
        }
      }),
    },
    team: salesRes.rows.map(r => ({
      person: r.person, handled: Number(r.handled) || 0,
      won: Number(r.won) || 0, wonValue: Math.round((Number(r.won_value) || 0) * 100) / 100,
    })),
    reengage: deriveReengagementList(dormantRes.rows),
  }
}

app.get('/api/reports/monthly', async (req, res) => {
  try {
    await ensureDB()
    res.json(await buildMonthlyReport(req.query.month))
  } catch (err) {
    console.error(`[ZHL] ${req.method} ${req.url}`, err.message)
    res.status(500).json({ error: 'Could not build the monthly report.' })
  }
})

// Narrative layer. Separate from the data endpoint so the deck still builds if the AI
// call fails — the numbers are the report, the commentary is a bonus.
app.post('/api/reports/monthly/narrative', async (req, res) => {
  try {
    const report = req.body?.report
    if (!report) return res.status(400).json({ error: 'No report data supplied.' })

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 3000,
      system: 'You are preparing commentary for a freight forwarder\'s monthly management meeting, presented by the business development team to company leadership and middle management. Be direct and specific. Never invent or recalculate figures — every number is given to you and is already correct.',
      messages: [{ role: 'user', content: `Here is this month's data. Write the commentary for the deck.

${JSON.stringify(report, null, 2)}

Return ONLY this JSON:
{
  "headline": "one sentence a director could repeat in a corridor. Reference the single most important movement.",
  "findings": ["3 to 5 observations. Each must cite a figure from the data and say what it means. Prefer a comparison to last month where the data allows it."],
  "lostThemes": [{"theme": "short label", "count": <how many of the listed losses fit it>, "detail": "one line, naming customers where useful"}],
  "risks": ["1 to 3 things leadership should be uneasy about. Say nothing here rather than inventing a concern."],
  "actions": ["3 to 5 concrete things to do before next month. Name the customer or lane where the data supports it."],
  "speakerNotes": {
    "overview": "what the presenter says over the headline numbers",
    "pipeline": "what to say over the funnel",
    "wins": "what to say over the wins",
    "losses": "what to say over the losses, framed as learning rather than excuses",
    "actions": "how to close the meeting"
  }
}

Rules:
- Group lostThemes from the free-text reasons in leads.lostReasons. That clustering is the main thing you are here for.
- If response time is slow or leads sat unclaimed, say so plainly. This deck is presented by the BD team to their own leadership and has to be credible, not flattering.
- Currency is SGD. Write naturally, no bullet-point fragments.` }],
    })

    const text = getResponseText(msg).replace(/```json\s*|\s*```/g, '').trim()
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) return res.status(422).json({ error: 'Could not generate commentary.' })
    res.json(JSON.parse(match[0]))
  } catch (err) {
    console.error(`[ZHL] ${req.method} ${req.url}`, err.message)
    res.status(500).json({ error: 'Could not generate commentary.' })
  }
})

// ─── JOB MOVEMENT REPORT ─────────────────────────────────────────────────────
// The performance report: what was actually moved, what it earned, and how well it was
// delivered, for a month, quarter or year. Leads measure what might come in; this
// measures what the business did.
//
// Same rule as the pipeline report: every figure is computed here from the database and
// the model is only ever asked for words.

// One row per job with its billing and cost totals already folded in, so the metrics
// module receives flat rows and stays free of SQL.
const MOVEMENT_JOB_SQL = `
  SELECT j.id, j.job_number, j.mode, j.status, j.customer_name, j.shipper,
         j.weight, j.cbm, j.packages, j.date_out, j.date_delivered, j.deadline_date,
         j.salesperson, j.created_by, j.created_at,
         COALESCE(b.total, 0) AS sale,
         COALESCE(c.total, 0) AS cost
  FROM jobs j
  LEFT JOIN (SELECT job_id, SUM(rate * qty) AS total FROM billing_lines GROUP BY job_id) b ON b.job_id = j.id
  LEFT JOIN (SELECT job_id, SUM(amount)     AS total FROM cost_lines    GROUP BY job_id) c ON c.job_id = j.id
  WHERE j.created_at >= $1 AND j.created_at < $2`

async function buildMovementReport(periodRef) {
  const { kind, start, end, prevStart, label } = periodWindow(periodRef)

  const [cur, prev] = await Promise.all([
    pool.query(MOVEMENT_JOB_SQL, [start, end]),
    pool.query(MOVEMENT_JOB_SQL, [prevStart, start]),
  ])

  const metrics = deriveMovementMetrics(cur.rows)
  const previous = deriveMovementMetrics(prev.rows)

  return {
    period: { kind, label, start: start.toISOString(), end: end.toISOString() },
    generated_at: new Date().toISOString(),
    ...metrics,
    // A month has one bar and is not worth charting; a quarter or year has a shape.
    trend: kind === 'month' ? [] : deriveTrend(cur.rows),
    previous: {
      label: periodWindow(periodRef).kind,
      jobs: previous.volume.jobs,
      sale: previous.money.sale,
      profit: previous.money.profit,
      gpPercent: previous.money.gpPercent,
      onTimeRate: previous.delivery.onTimeRate,
    },
  }
}

app.get('/api/reports/movement', async (req, res) => {
  try {
    await ensureDB()
    res.json(await buildMovementReport(req.query.period))
  } catch (err) {
    console.error(`[ZHL] ${req.method} ${req.url}`, err.message)
    res.status(500).json({ error: 'Could not build the movement report.' })
  }
})

app.post('/api/reports/movement/narrative', async (req, res) => {
  try {
    const report = req.body?.report
    if (!report) return res.status(400).json({ error: 'No report data supplied.' })

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 3000,
      system: "You are preparing commentary for a freight forwarder's management review, presented to company leadership and middle management. Be direct and specific. Never invent or recalculate figures: every number is given to you and is already correct.",
      messages: [{ role: 'user', content: `Here is the period's job movement data. Write the commentary for the deck.

${JSON.stringify(report, null, 2)}

Return ONLY this JSON:
{
  "headline": "one sentence a director could repeat in a corridor, naming the most important movement in the period",
  "findings": ["3 to 5 observations. Each must cite a figure and say what it means. Compare against the previous period where the data allows."],
  "operations": ["1 to 3 points specifically about delivery performance: on-time rate, lateness, transit times. Say plainly if it is poor."],
  "risks": ["1 to 3 things leadership should be uneasy about. Customer concentration and revenue with no cost recorded are usually the candidates. Say nothing rather than inventing a concern."],
  "actions": ["3 to 5 concrete things to do next period. Name the customer, mode or job where the data supports it."],
  "speakerNotes": {
    "overview": "what the presenter says over the headline figures",
    "volume": "what to say over the volume and mode mix",
    "delivery": "what to say over delivery performance",
    "customers": "what to say over the customer table",
    "actions": "how to close the meeting"
  }
}

Notes:
- Currency is SGD. Weight is kilograms, volume is CBM.
- risk.missingCosting counts jobs carrying revenue with no supplier cost recorded yet. Those overstate profit until someone enters the invoice, so treat a high number as a data-quality warning, not as genuine margin.
- risk.topCustomerShare is the largest customer's share of revenue. Above roughly 40% is worth naming as concentration risk.
- Write naturally, not in bullet fragments.` }],
    })

    const text = getResponseText(msg).replace(/```json\s*|\s*```/g, '').trim()
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) return res.status(422).json({ error: 'Could not generate commentary.' })
    res.json(JSON.parse(match[0]))
  } catch (err) {
    console.error(`[ZHL] ${req.method} ${req.url}`, err.message)
    res.status(500).json({ error: 'Could not generate commentary.' })
  }
})

// ─── LEAD DOCUMENTS ──────────────────────────────────────────────────────────
// Paperwork attached to an enquiry, either sent by the customer through the website
// or added by staff from an email.

app.get('/api/leads/:id/documents', async (req, res) => {
  try {
    await ensureDB()
    const r = await pool.query(
      `SELECT id, lead_id, file_name, doc_type, file_url, source, uploaded_by, upload_date
       FROM lead_documents WHERE lead_id=$1 ORDER BY upload_date, id`,
      [req.params.id]
    )
    res.json(r.rows)
  } catch (err) {
    console.error(`[ZHL] ${req.method} ${req.url}`, err.message)
    res.status(500).json({ error: 'Something went wrong. Please try again.' })
  }
})

app.post('/api/leads/:id/documents', upload.single('file'), async (req, res) => {
  try {
    await ensureDB()
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' })
    const { doc_type = 'Other' } = req.body
    const stored = `lead-${req.params.id}-${Date.now()}-${Math.round(Math.random() * 1e9)}-${req.file.originalname}`.replace(/\s+/g, '_')
    const file_url = await uploadToSupabaseStorage(req.file.buffer, stored, req.file.mimetype)
    const r = await pool.query(
      `INSERT INTO lead_documents (lead_id, file_name, doc_type, file_url, source, uploaded_by)
       VALUES ($1,$2,$3,$4,'manual',$5) RETURNING *`,
      [req.params.id, req.file.originalname, doc_type, file_url, req.user?.email || '']
    )
    res.status(201).json(r.rows[0])
  } catch (err) {
    console.error(`[ZHL] ${req.method} ${req.url}`, err.message)
    res.status(500).json({ error: 'Something went wrong. Please try again.' })
  }
})

app.delete('/api/leads/:id/documents/:did', async (req, res) => {
  try {
    await ensureDB()
    const doc = (await pool.query(
      'SELECT file_url FROM lead_documents WHERE id=$1 AND lead_id=$2', [req.params.did, req.params.id])).rows[0]
    await pool.query('DELETE FROM lead_documents WHERE id=$1 AND lead_id=$2', [req.params.did, req.params.id])
    if (doc) deleteFromSupabaseStorage(doc.file_url).catch(() => {})  // best effort, never blocks
    res.json({ success: true })
  } catch (err) {
    console.error(`[ZHL] ${req.method} ${req.url}`, err.message)
    res.status(500).json({ error: 'Something went wrong. Please try again.' })
  }
})

// Direct upload against a lead's public ref, for the website to push a file it holds
// as bytes rather than as a URL. Exempt from the staff auth guard and gated by the
// same shared secret as /api/rfq, so it is only usable by the sending site.
app.post('/api/rfq/:ref/documents', upload.single('file'), async (req, res) => {
  rfqCors(res)
  const rfqSecret = process.env.RFQ_SHARED_SECRET
  if (rfqSecret && req.headers['x-rfq-secret'] !== rfqSecret) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  try {
    await ensureDB()
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' })
    const lead = (await pool.query('SELECT id FROM leads WHERE ref=$1', [req.params.ref])).rows[0]
    if (!lead) return res.status(404).json({ error: 'Unknown lead reference' })
    const stored = `lead-${lead.id}-${Date.now()}-${Math.round(Math.random() * 1e9)}-${req.file.originalname}`.replace(/\s+/g, '_')
    const file_url = await uploadToSupabaseStorage(req.file.buffer, stored, req.file.mimetype)
    const r = await pool.query(
      `INSERT INTO lead_documents (lead_id, file_name, doc_type, file_url, source)
       VALUES ($1,$2,'Other',$3,'website') RETURNING *`,
      [lead.id, req.file.originalname, file_url]
    )
    console.log(`[ZHL] RFQ attachment stored for ${req.params.ref}: ${req.file.originalname}`)
    res.status(201).json(r.rows[0])
  } catch (err) {
    console.error(`[ZHL] ${req.method} ${req.url}`, err.message)
    res.status(500).json({ error: 'Something went wrong. Please try again.' })
  }
})

// ─── MARKETING CONTACTS ──────────────────────────────────────────────────────
app.get('/api/marketing-contacts', async (req, res) => {
  try {
    await ensureDB()
    const r = await pool.query(
      `SELECT id, email, customer_name, industry, source, lead_ref, archived_at
       FROM marketing_contacts ORDER BY archived_at DESC`
    )
    res.json(r.rows)
  } catch (err) {
    console.error(`[ZHL] ${req.method} ${req.url}`, err.message)
    res.status(500).json({ error: 'Something went wrong. Please try again.' })
  }
})

app.delete('/api/marketing-contacts/:id', async (req, res) => {
  try {
    await ensureDB()
    await pool.query('DELETE FROM marketing_contacts WHERE id=$1', [req.params.id])
    res.json({ success: true })
  } catch (err) {
    console.error(`[ZHL] ${req.method} ${req.url}`, err.message)
    res.status(500).json({ error: 'Something went wrong. Please try again.' })
  }
})

module.exports = app;
