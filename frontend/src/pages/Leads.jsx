import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronDown, Circle, Mail, X, ArrowRight, Check, AlertTriangle, Sparkles, Inbox, ClipboardList, Paperclip, Upload, Trash2, Presentation } from 'lucide-react'
import { getLeads, createLead, updateLead, deleteLead, getLeadStats, claimLead, generateEmail, convertLeadToJob, getMarketingContacts, deleteMarketingContact,
  getLeadDocuments, uploadLeadDocument, deleteLeadDocument,
  getMonthlyReport, getMonthlyNarrative } from '../api'
import { SectionHead, SectionBox } from '../components/SectionBox'

// ── helpers ───────────────────────────────────────────────────────────────────

function timeAgo(iso) {
  if (!iso) return '—'
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1)  return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

function fmtDate(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-SG', { day: 'numeric', month: 'short', year: 'numeric' })
}

function fmtDatetime(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('en-SG', { dateStyle: 'medium', timeStyle: 'short' })
}

function fmtPrice(v) {
  if (!v) return '—'
  return `S$${Number(v).toLocaleString('en-SG', { maximumFractionDigits: 0 })}`
}

// Normalize a GET /api/leads response into { items, hasMore }, regardless of
// whether the backend has been updated to support limit/offset pagination yet.
// - Plain array (today's shape / not-yet-upgraded backend) → everything is
//   already loaded, no "Load More" needed.
// - Object shape (once pagination lands) → look for the list under a few
//   likely keys, and derive hasMore from an explicit flag or a total count,
//   falling back to "got a full page, so assume there might be more".
function extractLeadsPage(data, offset, limit) {
  if (Array.isArray(data)) {
    return { items: data, hasMore: false }
  }
  const items = data?.leads || data?.data || data?.items || data?.rows || []
  let hasMore
  if (typeof data?.hasMore === 'boolean') hasMore = data.hasMore
  else if (typeof data?.has_more === 'boolean') hasMore = data.has_more
  else if (typeof data?.total === 'number') hasMore = (offset + items.length) < data.total
  else hasMore = items.length > 0 && items.length >= limit
  return { items, hasMore }
}

const LEADS_PAGE_SIZE = 100

// Guard against CSV/formula injection: lead data can originate from the public,
// unauthenticated RFQ webhook, so a field starting with =, +, - or @ gets a leading
// single quote to force spreadsheet apps to treat it as plain text, not a formula.
function csvSafe(v) {
  let s = String(v ?? '')
  if (/^[=+\-@]/.test(s)) s = `'${s}`
  return s.replace(/"/g, '""')
}

function downloadCSV(rows, filename) {
  const csv = rows.map(r => r.map(v => `"${csvSafe(v)}"`).join(',')).join('\n')
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
  a.download = filename
  a.click()
  URL.revokeObjectURL(a.href)
}

const asDate = (v) => (v ? new Date(v).toLocaleDateString('en-SG') : '')

// ── constants ─────────────────────────────────────────────────────────────────

const PIPELINE_STAGES = [
  'RFQ Received', 'New Lead', 'Follow-Up', 'Quote Sent', 'Responded', 'Won', 'Lost',
]

const STAGE_COLOR = {
  'RFQ Received': { bg: 'var(--blue-light)',      border: 'rgba(0,110,255,0.25)',  dot: 'var(--blue)' },
  'New Lead':     { bg: 'rgba(147,51,234,0.08)',  border: 'rgba(147,51,234,0.25)', dot: '#7C3AED' },
  'Follow-Up':    { bg: 'rgba(234,179,8,0.08)',   border: 'rgba(234,179,8,0.30)',  dot: '#B45309' },
  'Quote Sent':   { bg: 'rgba(14,165,233,0.08)',  border: 'rgba(14,165,233,0.25)', dot: '#0369A1' },
  'Responded':    { bg: 'rgba(20,184,166,0.08)',  border: 'rgba(20,184,166,0.25)', dot: '#0F766E' },
  'Won':          { bg: 'var(--green-light)',     border: 'rgba(20,128,74,0.25)',  dot: 'var(--green)' },
  'Lost':         { bg: 'var(--red-light)',       border: 'rgba(192,57,43,0.25)',  dot: 'var(--red)' },
}

const RISK_COLOR = {
  High:   { bg: 'var(--red-light)',   color: 'var(--red)' },
  Medium: { bg: 'var(--amber-light)', color: 'var(--amber)' },
  Low:    { bg: 'var(--green-light)', color: 'var(--green)' },
}

const INDUSTRY_COLOR = {
  Tech:            { bg: 'var(--blue-light)',      color: 'var(--blue)' },
  Pharmaceuticals: { bg: 'rgba(20,128,74,0.1)',    color: '#14804A' },
  Manufacturing:   { bg: 'rgba(180,83,9,0.1)',     color: '#B45309' },
  Commodities:     { bg: 'rgba(107,114,128,0.12)', color: '#4B5563' },
  Retail:          { bg: 'rgba(139,92,246,0.1)',   color: '#7C3AED' },
  General:         { bg: 'rgba(107,114,128,0.1)',  color: '#6B7280' },
}

// ── follow-up templates (no API needed) ──────────────────────────────────────

const FOLLOWUP_TEMPLATES = {
  Polite: (name, note) => ({
    subject: 'Following Up on Your Freight Enquiry',
    body: `Dear ${name || 'there'},\n\nI hope you're doing well. I wanted to follow up on your recent freight enquiry with Zhenghe Logistics.\n\nWould you have a moment to advise on the status of your shipment requirements? We're happy to answer any questions or provide additional clarification on our services.${note ? `\n\n${note}` : ''}\n\nLooking forward to hearing from you.\n\nWarm regards,\nZhenghe Logistics Team`,
  }),
  Firm: (name, note) => ({
    subject: 'Follow-Up: Your Freight Enquiry — Response Required',
    body: `Dear ${name || 'there'},\n\nI'm following up on your freight enquiry submitted to Zhenghe Logistics. We have reviewed your requirements and would appreciate your response so we can move forward.\n\nCould you please advise on the current status of your shipment requirements at your earliest convenience?${note ? `\n\n${note}` : ''}\n\nWe look forward to your prompt reply.\n\nBest regards,\nZhenghe Logistics Team`,
  }),
  Urgent: (name, note) => ({
    subject: 'URGENT: Follow-Up Required — Freight Enquiry Pending',
    body: `Dear ${name || 'there'},\n\nThis is an urgent follow-up regarding your pending freight enquiry with Zhenghe Logistics.\n\nWe have been unable to reach you and need to confirm your requirements to avoid any delays. Please respond as soon as possible — ideally by end of today.${note ? `\n\n${note}` : ''}\n\nPlease do not hesitate to contact us directly if you have any concerns.\n\nUrgently,\nZhenghe Logistics Team`,
  }),
}

// ── small components ──────────────────────────────────────────────────────────

function Pill({ label, style }) {
  return (
    <span style={{
      padding: '2px 9px', borderRadius: 20, fontSize: 10, fontWeight: 800,
      textTransform: 'uppercase', letterSpacing: '0.5px', whiteSpace: 'nowrap', ...style,
    }}>{label}</span>
  )
}

function IndustryPill({ industry }) {
  const s = INDUSTRY_COLOR[industry] || INDUSTRY_COLOR.General
  return <Pill label={industry || 'General'} style={{ background: s.bg, color: s.color }} />
}

function RiskBadge({ risk }) {
  if (!risk) return null
  const s = RISK_COLOR[risk] || {}
  return <Pill label={risk} style={{ background: s.bg, color: s.color }} />
}

function StageDot({ stage }) {
  const s = STAGE_COLOR[stage] || {}
  return <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: s.dot || '#6B7280', marginRight: 5 }} />
}

const RFQ_STATUSES = ['New', 'In Progress', 'Quoted']

const STATUS_STAGE_MAP = {
  'New':         'New Lead',
  'In Progress': 'Follow-Up',
  'Quoted':      'Quote Sent',
}

const STAGE_STATUS_MAP = {
  'RFQ Received': 'New',
  'New Lead':     'New',
  'Follow-Up':    'In Progress',
  'Responded':    'In Progress',
  'Quote Sent':   'Quoted',
}

const STATUS_STYLE = {
  'New':         { bg: 'var(--blue-light)',  color: 'var(--link)',  border: 'rgba(0,110,255,0.2)' },
  'In Progress': { bg: 'var(--amber-light)', color: 'var(--amber)', border: 'rgba(180,83,9,0.3)' },
  'Quoted':      { bg: 'var(--green-light)', color: 'var(--green)', border: 'rgba(20,128,74,0.3)' },
}

function StatusDropdown({ lead, onChange }) {
  const [open, setOpen] = useState(false)
  const current = STAGE_STATUS_MAP[lead.stage] || null
  const st = STATUS_STYLE[current] || { bg: '#F3F4F6', color: '#6B7280', border: '#D1D5DB' }

  return (
    <div style={{ position: 'relative' }} onClick={e => e.stopPropagation()}>
      <button
        onClick={() => setOpen(v => !v)}
        style={{
          background: st.bg, color: st.color, border: `1.5px solid ${st.border}`,
          borderRadius: 6, padding: '3px 8px', fontSize: 11, fontWeight: 700,
          cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4,
          fontFamily: 'var(--font)', whiteSpace: 'nowrap',
        }}
      >
        {current || lead.stage || '—'} <ChevronDown size={12} />
      </button>
      {open && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 199 }} onClick={() => setOpen(false)} />
          <div style={{
            position: 'absolute', top: '100%', left: 0, zIndex: 200, marginTop: 4,
            backgroundColor: '#ffffff', border: '1px solid #D1DCE8',
            borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.13)', minWidth: 130, overflow: 'hidden',
          }}>
            {RFQ_STATUSES.map(s => (
              <button key={s} onClick={() => { onChange(STATUS_STAGE_MAP[s]); setOpen(false) }}
                style={{
                  display: 'block', width: '100%', padding: '8px 14px', background: s === current ? '#F0F4FB' : '#ffffff',
                  border: 'none', textAlign: 'left', cursor: 'pointer',
                  fontSize: 12, fontWeight: s === current ? 700 : 500, fontFamily: 'var(--font)',
                  color: STATUS_STYLE[s]?.color || 'var(--text)',
                }}
                onMouseEnter={e => e.currentTarget.style.background = '#F0F4FB'}
                onMouseLeave={e => e.currentTarget.style.background = s === current ? '#F0F4FB' : '#ffffff'}
              >
                {s}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function StatCard({ label, value, sub }) {
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '16px 20px', flex: 1, minWidth: 160 }}>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 900, color: 'var(--heading)' }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{sub}</div>}
    </div>
  )
}

// ── tag toggle helper ─────────────────────────────────────────────────────────

function TagButton({ label, active, onClick }) {
  return (
    <button onClick={onClick} style={{
      padding: '4px 10px', borderRadius: 8, cursor: 'pointer', fontSize: 11, fontWeight: 600,
      border: '1.5px solid var(--border)',
      background: active ? 'rgba(0,110,255,0.15)' : 'transparent',
      color: active ? 'var(--blue)' : 'var(--text-muted)',
      transition: 'all 0.12s',
    }}>{label}</button>
  )
}

// ── Lead Modal ────────────────────────────────────────────────────────────────

// Paperwork attached to an enquiry. Files sent through the website arrive on their
// own; this is where staff see them, and where they add anything that came in by
// email instead. Whatever is here follows the lead onto the job when it is won.
function LeadDocuments({ leadId }) {
  const [docs, setDocs] = useState([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const fileRef = useRef(null)

  useEffect(() => {
    let cancelled = false
    getLeadDocuments(leadId)
      .then(({ data }) => { if (!cancelled) setDocs(Array.isArray(data) ? data : []) })
      .catch(() => { if (!cancelled) setError('Could not load attachments.') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [leadId])

  async function add(file) {
    if (!file) return
    // Vercel rejects a request body over roughly 4.5MB before it ever reaches us, so
    // catch it here where we can say something useful instead of failing obscurely.
    if (file.size > 4 * 1024 * 1024) {
      setError(`"${file.name}" is ${(file.size / 1024 / 1024).toFixed(1)} MB — the limit is 4 MB. Compress it at ilovepdf.com and try again.`)
      if (fileRef.current) fileRef.current.value = ''
      return
    }
    setBusy(true); setError('')
    try {
      const { data } = await uploadLeadDocument(leadId, file)
      setDocs(d => [...d, data])
    } catch (err) {
      setError(err?.response?.data?.error || 'Upload failed. Please try again.')
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''  // let the same file re-trigger onChange
    }
  }

  async function remove(doc) {
    if (!window.confirm(`Remove "${doc.file_name}"?`)) return
    try {
      await deleteLeadDocument(leadId, doc.id)
      setDocs(d => d.filter(x => x.id !== doc.id))
    } catch { setError('Could not remove that file.') }
  }

  return (
    <SectionBox>
      <SectionHead>Attachments{docs.length ? ` (${docs.length})` : ''}</SectionHead>

      {loading && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Loading…</div>}
      {error && <div className="alert alert-error" style={{ marginBottom: 8, fontSize: 12 }}>{error}</div>}

      {!loading && docs.length === 0 && (
        <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 10px' }}>
          Nothing attached yet. Files the customer sends through the website appear here
          automatically — or add one they emailed you.
        </p>
      )}

      {docs.map(d => (
        <div key={d.id} style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px',
          border: '1px solid var(--border)', borderRadius: 8, marginBottom: 6, background: 'var(--surface)',
        }}>
          <Paperclip size={14} color="var(--text-muted)" style={{ flexShrink: 0 }} />
          <a href={d.file_url} target="_blank" rel="noopener noreferrer"
            style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 600, color: 'var(--link)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {d.file_name}
          </a>
          {/* worth distinguishing: a file the customer sent themselves carries more
              weight than one a colleague added from memory */}
          <span style={{
            fontSize: 9, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.4px',
            padding: '2px 6px', borderRadius: 4, flexShrink: 0,
            background: d.source === 'website' ? 'var(--blue-light)' : 'var(--sub-box-bg)',
            color: d.source === 'website' ? 'var(--blue)' : 'var(--text-muted)',
          }}>{d.source === 'website' ? 'from customer' : 'added by us'}</span>
          <button className="btn btn-ghost btn-xs" style={{ color: 'var(--red)', flexShrink: 0 }}
            onClick={() => remove(d)} title="Remove"><Trash2 size={12} /></button>
        </div>
      ))}

      <label className="btn btn-outline btn-sm" style={{ cursor: busy ? 'wait' : 'pointer', marginTop: 4 }}>
        {busy ? <><span className="spinner spinner-dark"></span> Uploading…</> : <><Upload size={13} /> Attach a file</>}
        <input ref={fileRef} type="file" style={{ display: 'none' }} disabled={busy}
          onChange={e => add(e.target.files[0])} />
      </label>
    </SectionBox>
  )
}

function LeadModal({ lead, onClose, onSave, onClaim }) {
  const navigate = useNavigate()
  const isNew = !lead.id

  // parse existing next_follow_up into date + time
  const existingFU = lead.next_follow_up ? new Date(lead.next_follow_up) : null
  const initDate = existingFU ? existingFU.toISOString().slice(0, 10) : ''
  const initTime = existingFU ? existingFU.toTimeString().slice(0, 5) : '09:00'

  const [tab, setTab] = useState('details')

  // ── form state ──
  const [form, setForm] = useState({
    customer_name:  lead.customer_name  || '',
    customer_email: lead.customer_email || '',
    contact_person: lead.contact_person || '',
    phone_number:   lead.phone_number   || '',
    quoted_price:   lead.quoted_price   || '',
    industry:       lead.industry       || 'General',
    stage:          lead.stage          || 'New Lead',
    status:         lead.status         || lead.stage || 'New Lead',
    risk_level:     lead.risk_level     || 'Medium',
    source:         lead.source         || '',
    notes:          lead.notes          || '',
    is_archived:    lead.is_archived    || false,
    follow_up_date: initDate,
    follow_up_time: initTime,
    follow_up_note: lead.follow_up_note || '',
    lost_reason:    lead.lost_reason    || '',
    // shipment details — captured from the RFQ form, editable/fillable here too
    load_type:              lead.load_type              || '',
    origin:                 lead.origin                 || '',
    destination:            lead.destination            || '',
    service_type:           lead.service_type           || '',
    incoterm:               lead.incoterm               || '',
    container_size:         lead.container_size         || '',
    lead_dimensions:        lead.lead_dimensions        || '',
    commodity_name:         lead.commodity_name         || '',
    hs_code:                lead.hs_code                || '',
    lead_quantity:          lead.lead_quantity          || '',
    lead_weight:             lead.lead_weight            || '',
    packaging_type:          lead.packaging_type         || '',
    pickup_address:          lead.pickup_address         || '',
    delivery_address:        lead.delivery_address       || '',
    special_handling_notes:  lead.special_handling_notes || '',
    addons:                  lead.addons                 || '',
  })
  const [claimedBy, setClaimedBy] = useState(lead.claimed_by || null)
  const [saving, setSaving]   = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [err, setErr]         = useState('')

  // Auto-claim on open — silently assign this lead to whoever opens it first
  useEffect(() => {
    if (isNew || lead.claimed_by) return
    claimLead(lead.id)
      .then(r => { setClaimedBy(r.data.claimed_by); onClaim?.(lead.id, r.data.claimed_by) })
      .catch(e => { if (e.response?.status === 409) setClaimedBy(e.response.data.claimed_by) })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── action panel ──
  const [showQuoteIn, setShowQuoteIn] = useState(false)
  const [quoteIn, setQuoteIn]         = useState(String(lead.quoted_price || ''))
  const [showLostIn, setShowLostIn]   = useState(false)
  const [lostIn, setLostIn]           = useState(lead.lost_reason || '')

  // ── convert to job ──
  const [convertMode, setConvertMode] = useState('')
  const [converting, setConverting]   = useState(false)
  const [convertErr, setConvertErr]   = useState('')
  const modePills = lead.simple_mode === 'AIR' ? ['Air Express', 'Air Freight']
    : lead.simple_mode === 'SEA' ? ['Sea FCL', 'Sea LCL']
    : ['Sea FCL', 'Sea LCL', 'Air Express', 'Air Freight'] // unknown mode (e.g. manually created lead) — show all
  async function handleConvertToJob() {
    if (!convertMode) return
    setConverting(true); setConvertErr('')
    try {
      const { data } = await convertLeadToJob(lead.id, convertMode)
      navigate(`/jobs/${data.jobId}`)
    } catch (e) {
      setConvertErr(e?.response?.data?.error || 'Convert failed')
      setConverting(false)
    }
  }

  // ── email generator ──
  const [emailType, setEmailType]         = useState('followup')
  const [emailTone, setEmailTone]         = useState('Polite')
  const [emailNote, setEmailNote]         = useState('')
  const [infoFields, setInfoFields]       = useState([])
  const [infoCustom, setInfoCustom]       = useState('')
  const [quoteIncs, setQuoteIncs]         = useState(['Validity period (14 days)', 'Next steps'])
  const [introSvcs, setIntroSvcs]         = useState([])
  const [introAngle, setIntroAngle]       = useState('')
  const [emailResult, setEmailResult]     = useState(null)
  const [emailLoading, setEmailLoading]   = useState(false)
  const [emailErr, setEmailErr]           = useState('')
  const [copied, setCopied]               = useState('')

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  // stage and status must always move together — the backend's Won-This-Month /
  // Active-Leads KPIs key off `status`, not `stage`, so every path that changes
  // `stage` mirrors the same value into `status`.
  const setStage = (newStage) => setForm(f => ({ ...f, stage: newStage, status: newStage }))
  const inp = { className: 'form-control', style: { width: '100%' } }

  // ── save ──
  async function handleSave() {
    if (!form.customer_name.trim()) { setErr('Company name is required'); return }
    setSaving(true); setErr('')
    try {
      const payload = {
        customer_name:  form.customer_name,
        customer_email: form.customer_email,
        contact_person: form.contact_person,
        phone_number:   form.phone_number,
        quoted_price:   form.quoted_price ? parseFloat(form.quoted_price) : 0,
        industry:       form.industry,
        stage:          form.stage,
        status:         form.status,
        risk_level:     form.risk_level,
        source:         form.source,
        notes:          form.notes,
        is_archived:    form.is_archived,
        next_follow_up: form.follow_up_date
          ? `${form.follow_up_date}T${form.follow_up_time || '09:00'}:00`
          : null,
        follow_up_note: form.follow_up_note || null,
        lost_reason:    form.lost_reason    || null,
        // shipment details
        load_type:              form.load_type,
        origin:                 form.origin,
        destination:            form.destination,
        service_type:           form.service_type,
        incoterm:               form.incoterm,
        container_size:         form.container_size,
        lead_dimensions:        form.lead_dimensions,
        commodity_name:         form.commodity_name,
        hs_code:                form.hs_code,
        lead_quantity:          form.lead_quantity,
        lead_weight:            form.lead_weight,
        packaging_type:         form.packaging_type,
        pickup_address:         form.pickup_address,
        delivery_address:       form.delivery_address,
        special_handling_notes: form.special_handling_notes,
        addons:                 form.addons,
      }
      isNew ? await createLead(payload) : await updateLead(lead.id, payload)
      onSave()
    } catch (e) {
      setErr(e?.response?.data?.error || 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  // ── delete ──
  async function handleDelete() {
    if (!window.confirm(`Permanently delete this lead (${lead.customer_name || lead.ref})? This cannot be undone.`)) return
    setDeleting(true)
    try {
      await deleteLead(lead.id)
      onSave()
    } catch (e) {
      setErr(e?.response?.data?.error || 'Delete failed')
      setDeleting(false)
    }
  }

  // ── email generator ──
  async function handleGenerateEmail() {
    setEmailLoading(true); setEmailErr(''); setEmailResult(null)
    try {
      if (emailType === 'followup') {
        setEmailResult(FOLLOWUP_TEMPLATES[emailTone](form.customer_name, emailNote))
      } else {
        const opts = emailType === 'info_request'
          ? { fields: infoFields, custom_questions: infoCustom }
          : emailType === 'quote_confirmation'
          ? { include: quoteIncs }
          : { services: introSvcs, angle: introAngle }
        const { data } = await generateEmail(lead.id, { email_type: emailType, options: opts })
        setEmailResult(data)
      }
    } catch (e) {
      setEmailErr(e?.response?.data?.error || 'Generation failed. Please try again.')
    } finally {
      setEmailLoading(false)
    }
  }

  function copyText(text, key) {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(key)
      setTimeout(() => setCopied(''), 1800)
    }).catch(() => {})
  }

  // ── follow-up display ──
  const followUpDt = form.follow_up_date
    ? new Date(`${form.follow_up_date}T${form.follow_up_time || '09:00'}`)
    : null
  const followUpOverdue = followUpDt && followUpDt < new Date()

  // ── field row helper ──
  const fieldRow = (label, children) => (
    <div style={{ marginBottom: 14 }}>
      <label style={{ display: 'block', fontSize: 10, fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 5 }}>{label}</label>
      {children}
    </div>
  )

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 900, width: '95vw' }} onClick={e => e.stopPropagation()}>

        {/* ── Header ── */}
        <div className="modal-header">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--heading)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {isNew ? 'New Lead' : (lead.customer_name || lead.ref)}
            </div>
            {!isNew && (
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span>{lead.ref} · received {fmtDate(lead.created_at)}</span>
                {claimedBy
                  ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'var(--green-light)', border: '1px solid rgba(20,128,74,0.25)', borderRadius: 20, padding: '1px 8px', color: 'var(--green)', fontWeight: 700, fontSize: 10 }}><Circle size={6} fill="currentColor" stroke="none" />{claimedBy.split('@')[0]}</span>
                  : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'var(--amber-light)', border: '1px solid rgba(180,83,9,0.25)', borderRadius: 20, padding: '1px 8px', color: 'var(--amber)', fontWeight: 700, fontSize: 10 }}>Unclaimed</span>
                }
              </div>
            )}
          </div>
          {!isNew && (
            <div style={{ display: 'flex', gap: 2, background: 'var(--sub-box-bg)', border: '1px solid var(--border)', borderRadius: 7, padding: 3, margin: '0 10px' }}>
              {['details', 'email'].map(t => (
                <button key={t} onClick={() => setTab(t)}
                  className={tab === t ? 'btn btn-primary btn-xs' : 'btn btn-ghost btn-xs'}
                  style={{ textTransform: 'capitalize' }}
                >{t === 'email' ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Mail size={13} />Email</span> : 'Details'}</button>
              ))}
            </div>
          )}
          <button className="btn btn-ghost btn-sm" onClick={onClose}><X size={16} /></button>
        </div>

        {/* ── Route Banner ── */}
        {!isNew && (form.origin || form.destination) && (
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
            flexWrap: 'wrap', padding: '10px 24px', background: 'var(--sub-box-bg)',
            borderBottom: '1px solid var(--border)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 16, fontWeight: 800, color: 'var(--heading)' }}>
              <span>{form.origin || '—'}</span>
              <span style={{ color: 'var(--text-muted)', fontWeight: 400, display: 'inline-flex', alignItems: 'center' }}><ArrowRight size={16} /></span>
              <span>{form.destination || '—'}</span>
            </div>
            {(form.load_type || lead.simple_mode) && (
              <span style={{
                fontSize: 11, fontWeight: 700, color: 'var(--blue)', border: '1.5px solid var(--blue)',
                borderRadius: 20, padding: '2px 12px',
              }}>{form.load_type || lead.simple_mode}</span>
            )}
          </div>
        )}

        {/* ══════════════════ DETAILS TAB ══════════════════ */}
        <div style={{ display: isNew || tab === 'details' ? 'block' : 'none' }}>
          <div className="modal-body" style={{ padding: '16px 24px', maxHeight: '75vh', overflowY: 'auto' }}>
            {err && <div className="alert alert-error" style={{ marginBottom: 14 }}>{err}</div>}

            {/* Core fields */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 20px' }}>
              {fieldRow('Company Name',
                <input {...inp} value={form.customer_name} onChange={e => set('customer_name', e.target.value)} placeholder="Acme Corp" />
              )}
              {fieldRow('Email',
                <input {...inp} type="email" value={form.customer_email} onChange={e => set('customer_email', e.target.value)} placeholder="contact@acme.com" />
              )}
              {fieldRow('Contact Person',
                <input {...inp} value={form.contact_person} onChange={e => set('contact_person', e.target.value)} placeholder="Name of contact" />
              )}
              {fieldRow('Phone Number',
                <input {...inp} value={form.phone_number} onChange={e => set('phone_number', e.target.value)} placeholder="+65 xxxx xxxx" />
              )}
              {fieldRow('Quoted Price (SGD)',
                <input {...inp} type="number" value={form.quoted_price} onChange={e => set('quoted_price', e.target.value)} placeholder="0" />
              )}
              {fieldRow('Stage',
                <select {...inp} value={form.stage} onChange={e => setStage(e.target.value)}>
                  {PIPELINE_STAGES.map(s => <option key={s}>{s}</option>)}
                </select>
              )}
              {fieldRow('Risk Level',
                <select {...inp} value={form.risk_level} onChange={e => set('risk_level', e.target.value)}>
                  {['High', 'Medium', 'Low'].map(r => <option key={r}>{r}</option>)}
                </select>
              )}
              {fieldRow('Industry',
                <select {...inp} value={form.industry} onChange={e => set('industry', e.target.value)}>
                  {['Tech','Pharmaceuticals','Manufacturing','Commodities','Retail','General'].map(i => <option key={i}>{i}</option>)}
                </select>
              )}
              {fieldRow('Source',
                <input {...inp} value={form.source} onChange={e => set('source', e.target.value)} placeholder="Website, Referral, Cold Call..." />
              )}
            </div>

            {/* ── Shipment Details ── */}
            <SectionBox>
              <SectionHead>Shipment Details</SectionHead>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 20px' }}>
                {fieldRow('Origin',
                  <input {...inp} value={form.origin} onChange={e => set('origin', e.target.value)} placeholder="Port / city of origin" />
                )}
                {fieldRow('Destination',
                  <input {...inp} value={form.destination} onChange={e => set('destination', e.target.value)} placeholder="Port / city of destination" />
                )}
                {fieldRow('Load Type',
                  <input {...inp} value={form.load_type} onChange={e => set('load_type', e.target.value)} placeholder="FCL, LCL, Air Express..." />
                )}
                {fieldRow('Service Type',
                  <input {...inp} value={form.service_type} onChange={e => set('service_type', e.target.value)} placeholder="Door-to-door, Port-to-port..." />
                )}
                {fieldRow('Incoterm',
                  <input {...inp} value={form.incoterm} onChange={e => set('incoterm', e.target.value)} placeholder="FOB, CIF, EXW..." />
                )}
                {fieldRow('Container Size',
                  <input {...inp} value={form.container_size} onChange={e => set('container_size', e.target.value)} placeholder="20ft, 40ft, 40HC..." />
                )}
                {fieldRow('Commodity',
                  <input {...inp} value={form.commodity_name} onChange={e => set('commodity_name', e.target.value)} placeholder="What's being shipped" />
                )}
                {fieldRow('HS Code',
                  <input {...inp} value={form.hs_code} onChange={e => set('hs_code', e.target.value)} />
                )}
                {fieldRow('Quantity',
                  <input {...inp} value={form.lead_quantity} onChange={e => set('lead_quantity', e.target.value)} />
                )}
                {fieldRow('Weight',
                  <input {...inp} value={form.lead_weight} onChange={e => set('lead_weight', e.target.value)} />
                )}
                {fieldRow('Dimensions',
                  <input {...inp} value={form.lead_dimensions} onChange={e => set('lead_dimensions', e.target.value)} />
                )}
                {fieldRow('Packaging Type',
                  <input {...inp} value={form.packaging_type} onChange={e => set('packaging_type', e.target.value)} placeholder="Pallets, cartons, drums..." />
                )}
              </div>
              {fieldRow('Pickup Address',
                <textarea {...inp} rows={2} value={form.pickup_address} onChange={e => set('pickup_address', e.target.value)} style={{ ...inp.style, resize: 'vertical' }} />
              )}
              {fieldRow('Delivery Address',
                <textarea {...inp} rows={2} value={form.delivery_address} onChange={e => set('delivery_address', e.target.value)} style={{ ...inp.style, resize: 'vertical' }} />
              )}
              {fieldRow('Special Handling Notes',
                <textarea {...inp} rows={2} value={form.special_handling_notes} onChange={e => set('special_handling_notes', e.target.value)} style={{ ...inp.style, resize: 'vertical' }} />
              )}
              {fieldRow('Add-ons',
                <input {...inp} value={form.addons} onChange={e => set('addons', e.target.value)} />
              )}
            </SectionBox>

            {/* ── Cargo Lines (multi-cargo-type quotes only, e.g. LCL + a container + a reefer in one booking) ── */}
            {Array.isArray(lead.cargo_lines) && lead.cargo_lines.length > 1 && (
              <SectionBox>
                <SectionHead>Cargo Lines ({lead.cargo_lines.length})</SectionHead>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ textAlign: 'left', color: 'var(--text-muted)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                        <th style={{ padding: '0 8px 6px 0' }}>Type</th>
                        <th style={{ padding: '0 8px 6px' }}>Qty</th>
                        <th style={{ padding: '0 8px 6px' }}>Weight</th>
                        <th style={{ padding: '0 8px 6px' }}>Commodity</th>
                        <th style={{ padding: '0 8px 6px' }}>HS Code</th>
                      </tr>
                    </thead>
                    <tbody>
                      {lead.cargo_lines.map((c, i) => (
                        <tr key={i} style={{ borderTop: '1px solid var(--border-solid)' }}>
                          <td style={{ padding: '6px 8px 6px 0', fontWeight: 700, color: 'var(--heading)', whiteSpace: 'nowrap' }}>{c.cargoType || '—'}</td>
                          <td style={{ padding: '6px 8px' }}>{c.qty || '—'}</td>
                          <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>{c.weightKg ? `${c.weightKg} kg` : '—'}</td>
                          <td style={{ padding: '6px 8px' }}>{c.commodity || '—'}</td>
                          <td style={{ padding: '6px 8px' }}>{c.hsCode || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </SectionBox>
            )}

            {/* Only for saved leads — a lead has to exist before a file can hang off it. */}
            {!isNew && <LeadDocuments leadId={lead.id} />}

            {fieldRow('Notes',
              <textarea {...inp} rows={4} value={form.notes} onChange={e => set('notes', e.target.value)}
                style={{ ...inp.style, resize: 'vertical', fontFamily: 'ui-monospace, "Courier New", monospace', fontSize: 12, lineHeight: 1.65 }}
                placeholder="Cargo details, requirements, context..."
              />
            )}

            {/* ── Action Panel ── */}
            <SectionBox>
              <SectionHead>Quick Actions</SectionHead>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {[
                  { label: 'Responded',  target: 'Responded',  color: '#0369A1' },
                  { label: 'Send Quote', target: 'Quote Sent', color: 'var(--blue)', special: 'quote' },
                  { label: 'Won',        target: 'Won',        color: 'var(--green)' },
                  { label: 'Lost',       target: 'Lost',       color: 'var(--red)', special: 'lost' },
                ].map(a => (
                  <button key={a.label}
                    onClick={() => {
                      if (a.special === 'quote') { setShowQuoteIn(v => !v); setShowLostIn(false) }
                      else if (a.special === 'lost') { setShowLostIn(v => !v); setShowQuoteIn(false) }
                      else setStage(a.target)
                    }}
                    style={{
                      padding: '5px 14px', borderRadius: 8, cursor: 'pointer', fontSize: 12, fontWeight: 700,
                      border: `1.5px solid ${a.color}`,
                      background: form.stage === a.target ? a.color : 'transparent',
                      color: form.stage === a.target ? '#fff' : a.color,
                      transition: 'all 0.12s',
                    }}
                  >{a.label}</button>
                ))}
                {form.stage === 'Lost' && (
                  <button onClick={() => { setStage('Follow-Up'); set('lost_reason', '') }}
                    style={{ padding: '5px 14px', borderRadius: 8, cursor: 'pointer', fontSize: 12, fontWeight: 700, border: '1.5px solid var(--amber)', background: 'transparent', color: 'var(--amber)' }}
                  >Recover</button>
                )}
              </div>

              {showQuoteIn && (
                <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input type="number" placeholder="Quoted price (SGD)" value={quoteIn}
                    onChange={e => setQuoteIn(e.target.value)}
                    className="form-control" style={{ maxWidth: 200 }} autoFocus />
                  <button className="btn btn-primary btn-sm" onClick={() => {
                    setStage('Quote Sent')
                    if (quoteIn) set('quoted_price', quoteIn)
                    setShowQuoteIn(false)
                  }}>Confirm</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setShowQuoteIn(false)}><X size={14} /></button>
                </div>
              )}

              {showLostIn && (
                <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input placeholder="Reason for losing (optional)" value={lostIn}
                    onChange={e => setLostIn(e.target.value)}
                    className="form-control" style={{ flex: 1 }} autoFocus />
                  <button className="btn btn-danger btn-sm" onClick={() => {
                    setStage('Lost'); set('lost_reason', lostIn); setShowLostIn(false)
                  }}>Mark Lost</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setShowLostIn(false)}><X size={14} /></button>
                </div>
              )}

              {form.lost_reason && (
                <div style={{ marginTop: 8, fontSize: 11, color: 'var(--red)' }}>
                  Lost reason: {form.lost_reason}
                </div>
              )}
            </SectionBox>

            {/* ── Convert to Job (Won leads only) ── */}
            {!isNew && form.stage === 'Won' && (
              <SectionBox>
                <SectionHead>Convert to Job</SectionHead>
                {lead.converted_job_id ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--green)', fontWeight: 700 }}><Check size={13} />Converted</span>
                    <button className="btn btn-primary btn-sm" onClick={() => navigate(`/jobs/${lead.converted_job_id}`)}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      View Job <ArrowRight size={13} />
                    </button>
                  </div>
                ) : (
                  <>
                    <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 10px' }}>
                      Pick the exact mode for this job — shipper, consignee, and billing are left blank for you to fill in on the job itself.
                    </p>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
                      {modePills.map(m => (
                        <button key={m} onClick={() => setConvertMode(m)}
                          style={{
                            padding: '5px 14px', borderRadius: 20, cursor: 'pointer', fontSize: 12, fontWeight: 700,
                            border: '1.5px solid var(--blue)',
                            background: convertMode === m ? 'var(--blue)' : 'transparent',
                            color: convertMode === m ? '#fff' : 'var(--blue)',
                            transition: 'all 0.12s',
                          }}
                        >{m}</button>
                      ))}
                    </div>
                    {convertErr && <div className="alert alert-error" style={{ marginBottom: 10 }}>{convertErr}</div>}
                    <button className="btn btn-primary btn-sm" onClick={handleConvertToJob} disabled={!convertMode || converting}>
                      {converting ? 'Converting…' : 'Convert to Job'}
                    </button>
                  </>
                )}
              </SectionBox>
            )}

            {/* ── Follow-Up Scheduler ── */}
            <SectionBox>
              <SectionHead>Follow-Up Scheduler</SectionHead>

              {followUpDt && (
                <div style={{
                  marginBottom: 10, padding: '8px 12px', borderRadius: 8,
                  background: followUpOverdue ? 'var(--red-light)' : 'var(--blue-light)',
                  border: `1px solid ${followUpOverdue ? 'rgba(192,57,43,0.25)' : 'rgba(0,110,255,0.20)'}`,
                }}>
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 700, color: followUpOverdue ? 'var(--red)' : 'var(--blue)' }}>
                    {followUpOverdue ? <AlertTriangle size={13} /> : <Check size={13} />}
                    {followUpOverdue ? 'Overdue: ' : 'Scheduled: '}{fmtDatetime(`${form.follow_up_date}T${form.follow_up_time}`)}
                  </div>
                  {form.follow_up_note && (
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{form.follow_up_note}</div>
                  )}
                </div>
              )}

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                <div>
                  <label style={{ display: 'block', fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 4 }}>Date</label>
                  <input type="date" className="form-control" value={form.follow_up_date}
                    onChange={e => set('follow_up_date', e.target.value)} style={{ width: '100%' }} />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 4 }}>Time</label>
                  <input type="time" className="form-control" value={form.follow_up_time}
                    onChange={e => set('follow_up_time', e.target.value)} style={{ width: '100%' }} />
                </div>
              </div>
              <input className="form-control" style={{ width: '100%' }}
                placeholder="What to follow up about..."
                value={form.follow_up_note} onChange={e => set('follow_up_note', e.target.value)} />
            </SectionBox>

            {/* Archive */}
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-muted)', cursor: 'pointer', marginBottom: 16 }}>
              <input type="checkbox" checked={form.is_archived} onChange={e => set('is_archived', e.target.checked)} />
              Archive this lead (hide from active pipeline)
            </label>

            {/* Footer */}
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', alignItems: 'center' }}>
              {!isNew && (
                <button className="btn btn-ghost btn-sm" onClick={handleDelete} disabled={deleting}
                  style={{ color: 'var(--red)', marginRight: 'auto' }}>
                  {deleting ? 'Deleting…' : 'Delete Lead'}
                </button>
              )}
              <button className="btn btn-ghost btn-sm" onClick={onClose}>Cancel</button>
              <button className="btn btn-primary btn-sm" onClick={handleSave} disabled={saving}>
                {saving ? 'Saving…' : 'Save Lead'}
              </button>
            </div>
          </div>
        </div>

        {/* ══════════════════ EMAIL TAB ══════════════════ */}
        {!isNew && tab === 'email' && (
          <div className="modal-body" style={{ padding: '16px 24px 24px', maxHeight: '75vh', overflowY: 'auto' }}>

            {/* Type selector */}
            <SectionBox>
              <SectionHead>Email Type</SectionHead>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
                {[
                  { value: 'followup',           label: 'Follow-Up',         badge: 'Template' },
                  { value: 'info_request',        label: 'Info Request',      badge: 'AI' },
                  { value: 'quote_confirmation',  label: 'Quote Confirmation',badge: 'AI' },
                  { value: 'introduction',        label: 'Cold Introduction', badge: 'AI' },
                ].map(t => (
                  <button key={t.value}
                    onClick={() => { setEmailType(t.value); setEmailResult(null); setEmailErr('') }}
                    style={{
                      padding: '6px 14px', borderRadius: 8, cursor: 'pointer', fontSize: 12, fontWeight: 700,
                      border: '1.5px solid var(--border)',
                      background: emailType === t.value ? 'var(--navy)' : 'transparent',
                      color: emailType === t.value ? '#fff' : 'var(--text)',
                      transition: 'all 0.12s',
                      display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2,
                    }}
                  >
                    <span>{t.label}</span>
                    <span style={{ fontSize: 9, opacity: 0.65, fontWeight: 600, letterSpacing: '0.4px' }}>{t.badge}</span>
                  </button>
                ))}
              </div>

              {/* ── Follow-Up options ── */}
              {emailType === 'followup' && (
                <>
                  <SectionHead>Tone</SectionHead>
                  <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
                    {['Polite', 'Firm', 'Urgent'].map(t => (
                      <button key={t} onClick={() => setEmailTone(t)}
                        style={{
                          padding: '5px 16px', borderRadius: 8, cursor: 'pointer', fontSize: 12, fontWeight: 700,
                          border: '1.5px solid var(--border)',
                          background: emailTone === t ? 'var(--blue)' : 'transparent',
                          color: emailTone === t ? '#fff' : 'var(--text)',
                          transition: 'all 0.12s',
                        }}
                      >{t}</button>
                    ))}
                  </div>
                  <SectionHead>Custom Note (optional)</SectionHead>
                  <input className="form-control" style={{ width: '100%' }}
                    placeholder="Any specific message to include..."
                    value={emailNote} onChange={e => setEmailNote(e.target.value)} />
                </>
              )}

              {/* ── Info Request options ── */}
              {emailType === 'info_request' && (
                <>
                  <SectionHead>Fields to Request</SectionHead>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
                    {['HS Code','Weight','CBM','Dimensions','Pickup Address','Delivery Address','Incoterm','Commodity Details','Packaging Type','Cargo Readiness Date'].map(f => (
                      <TagButton key={f} label={f}
                        active={infoFields.includes(f)}
                        onClick={() => setInfoFields(p => p.includes(f) ? p.filter(x => x !== f) : [...p, f])}
                      />
                    ))}
                  </div>
                  <SectionHead>Additional Questions</SectionHead>
                  <input className="form-control" style={{ width: '100%' }}
                    placeholder="Any other specific questions..."
                    value={infoCustom} onChange={e => setInfoCustom(e.target.value)} />
                </>
              )}

              {/* ── Quote Confirmation options ── */}
              {emailType === 'quote_confirmation' && (
                <>
                  <div style={{ marginBottom: 10, fontSize: 12, color: 'var(--text-muted)' }}>
                    Quote on file:{' '}
                    <strong style={{ color: lead.quoted_price > 0 ? 'var(--blue)' : 'var(--text-muted)' }}>
                      {lead.quoted_price > 0 ? fmtPrice(lead.quoted_price) : 'None set yet'}
                    </strong>
                  </div>
                  <SectionHead>Include in Email</SectionHead>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {['Validity period (14 days)','Payment terms','Next steps','Subject to space/approval','Cargo readiness date','Bank details for deposit'].map(f => (
                      <TagButton key={f} label={f}
                        active={quoteIncs.includes(f)}
                        onClick={() => setQuoteIncs(p => p.includes(f) ? p.filter(x => x !== f) : [...p, f])}
                      />
                    ))}
                  </div>
                </>
              )}

              {/* ── Cold Introduction options ── */}
              {emailType === 'introduction' && (
                <>
                  <SectionHead>Services to Highlight</SectionHead>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
                    {['FCL (Full Container)','LCL (Less Container)','Air Freight','Air Express','Local Delivery','Customs Clearance','Warehousing','Door-to-Door','Project Cargo'].map(s => (
                      <TagButton key={s} label={s}
                        active={introSvcs.includes(s)}
                        onClick={() => setIntroSvcs(p => p.includes(s) ? p.filter(x => x !== s) : [...p, s])}
                      />
                    ))}
                  </div>
                  <SectionHead>Key Angle / Value Proposition</SectionHead>
                  <input className="form-control" style={{ width: '100%' }}
                    placeholder="e.g. Competitive LCL rates for SG-India, 5-day transit..."
                    value={introAngle} onChange={e => setIntroAngle(e.target.value)} />
                </>
              )}
            </SectionBox>

            {emailErr && <div className="alert alert-error" style={{ marginBottom: 12 }}>{emailErr}</div>}

            <button className="btn btn-primary btn-sm"
              onClick={handleGenerateEmail}
              disabled={emailLoading}
              style={{ width: '100%', marginBottom: emailResult ? 20 : 0, justifyContent: 'center' }}
            >
              {emailLoading
                ? 'Generating…'
                : emailType === 'followup'
                ? 'Generate from Template'
                : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, justifyContent: 'center' }}><Sparkles size={14} />Generate with AI</span>}
            </button>

            {/* ── Email result ── */}
            {emailResult && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
                    <SectionHead>Subject</SectionHead>
                    <button className="btn btn-ghost btn-xs" onClick={() => copyText(emailResult.subject, 'subject')}>
                      {copied === 'subject' ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}><Check size={12} />Copied</span> : 'Copy'}
                    </button>
                  </div>
                  <input className="form-control" style={{ width: '100%', fontWeight: 600 }}
                    value={emailResult.subject}
                    onChange={e => setEmailResult(r => ({ ...r, subject: e.target.value }))} />
                </div>
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
                    <SectionHead>Body</SectionHead>
                    <button className="btn btn-ghost btn-xs" onClick={() => copyText(emailResult.body, 'body')}>
                      {copied === 'body' ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}><Check size={12} />Copied</span> : 'Copy'}
                    </button>
                  </div>
                  <textarea className="form-control"
                    style={{ width: '100%', minHeight: 240, resize: 'vertical', fontFamily: 'ui-monospace, "Courier New", monospace', fontSize: 12, lineHeight: 1.7 }}
                    value={emailResult.body}
                    onChange={e => setEmailResult(r => ({ ...r, body: e.target.value }))} />
                </div>
              </div>
            )}
          </div>
        )}

      </div>
    </div>
  )
}

// ── Unclaimed Attention Banner ────────────────────────────────────────────────

function AttentionBanner({ leads, onClaimed }) {
  const [claiming, setClaiming] = useState(null)
  const [results, setResults]   = useState({})

  async function handleClaim(lead) {
    setClaiming(lead.id)
    try {
      await claimLead(lead.id)
      setResults(r => ({ ...r, [lead.id]: { ok: true, msg: 'Claimed by you' } }))
      onClaimed()
    } catch (e) {
      const msg = e?.response?.data?.claimed_by
        ? `Already claimed by ${e.response.data.claimed_by}`
        : 'Refresh and try again'
      setResults(r => ({ ...r, [lead.id]: { ok: false, msg } }))
    } finally {
      setClaiming(null)
    }
  }

  const unclaimed = leads.filter(l => !l.claimed_by && !results[l.id]?.ok)
  if (!unclaimed.length) return null

  return (
    <div style={{
      background: 'var(--amber-light)', border: '1px solid rgba(180,83,9,0.40)',
      borderRadius: 10, padding: '14px 18px', marginBottom: 20,
    }}>
      <div style={{ fontSize: 14, fontWeight: 800, color: 'var(--amber)', marginBottom: 10 }}>
        {unclaimed.length} lead{unclaimed.length > 1 ? 's' : ''} need{unclaimed.length === 1 ? 's' : ''} attention
        <span style={{ fontSize: 11, opacity: 0.7, fontWeight: 400, marginLeft: 8 }}>— unclaimed for 2+ weeks</span>
      </div>
      {unclaimed.map(lead => (
        <div key={lead.id} style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          background: 'rgba(255,255,255,0.6)', borderRadius: 8, padding: '8px 12px',
          flexWrap: 'wrap', gap: 8, marginBottom: 6,
        }}>
          <div>
            <span style={{ fontWeight: 700, fontSize: 13 }}>{lead.customer_name || lead.ref}</span>
            <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 8 }}>{lead.stage} · {timeAgo(lead.created_at)}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {results[lead.id] && (
              <span style={{ fontSize: 11, color: results[lead.id].ok ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>
                {results[lead.id].msg}
              </span>
            )}
            <button className="btn btn-sm" disabled={claiming === lead.id}
              style={{ background: 'var(--amber)', color: '#fff', border: 'none' }}
              onClick={() => handleClaim(lead)}
            >{claiming === lead.id ? 'Claiming…' : "I'll handle this"}</button>
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Pipeline Card ─────────────────────────────────────────────────────────────

function PipelineCard({ lead, onClick }) {
  const followUpDt = lead.next_follow_up ? new Date(lead.next_follow_up) : null
  const followUpOverdue = followUpDt && followUpDt < new Date()

  return (
    <div onClick={onClick} style={{
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 10, padding: '12px 14px', cursor: 'pointer', transition: 'box-shadow 0.15s, border-color 0.15s',
    }}
    onMouseEnter={e => { e.currentTarget.style.boxShadow = '0 4px 16px rgba(0,0,0,0.10)'; e.currentTarget.style.borderColor = 'var(--blue)' }}
    onMouseLeave={e => { e.currentTarget.style.boxShadow = ''; e.currentTarget.style.borderColor = 'var(--border)' }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
        <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--heading)', lineHeight: 1.3, flex: 1, marginRight: 6 }}>
          {lead.customer_name || <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(no name)</span>}
        </div>
        <RiskBadge risk={lead.risk_level} />
      </div>

      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {lead.customer_email || lead.ref}
      </div>

      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 8 }}>
        <IndustryPill industry={lead.industry || 'General'} />
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: lead.quoted_price ? 'var(--blue)' : 'var(--text-muted)' }}>
          {fmtPrice(lead.quoted_price)}
        </span>
        {followUpDt ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 10, color: followUpOverdue ? 'var(--red)' : 'var(--text-muted)', fontWeight: followUpOverdue ? 700 : 400 }}>
            {followUpOverdue && <AlertTriangle size={10} />}{fmtDate(lead.next_follow_up)}
          </span>
        ) : (
          <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{timeAgo(lead.created_at)}</span>
        )}
      </div>

      {lead.follow_up_note && (
        <div style={{ marginTop: 5, fontSize: 10, color: 'var(--text-muted)', fontStyle: 'italic', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {lead.follow_up_note}
        </div>
      )}

      {lead.claimed_by && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 3, marginTop: 5, fontSize: 10, color: 'var(--green)', fontWeight: 700 }}>
          <Check size={10} />{lead.claimed_by.split('@')[0]}
        </div>
      )}
    </div>
  )
}

// ── Pipeline Column ───────────────────────────────────────────────────────────

function PipelineColumn({ stage, leads, onCardClick }) {
  const sc = STAGE_COLOR[stage] || {}
  const total = leads.reduce((s, l) => s + (l.quoted_price || 0), 0)

  return (
    <div style={{ minWidth: 230, maxWidth: 260, flex: '0 0 240px', display: 'flex', flexDirection: 'column' }}>
      <div style={{
        background: sc.bg || 'rgba(107,114,128,0.06)',
        border: `1px solid ${sc.border || 'var(--border)'}`,
        borderRadius: '10px 10px 0 0', padding: '10px 14px',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <StageDot stage={stage} />
          <span style={{ fontSize: 11, fontWeight: 800, color: 'var(--heading)', textTransform: 'uppercase', letterSpacing: '0.4px' }}>{stage}</span>
        </div>
        <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', background: 'var(--sub-box-bg)', borderRadius: 20, padding: '1px 8px' }}>
          {leads.length}
        </span>
      </div>

      {total > 0 && (
        <div style={{ background: sc.bg || 'rgba(107,114,128,0.04)', borderLeft: `1px solid ${sc.border || 'var(--border)'}`, borderRight: `1px solid ${sc.border || 'var(--border)'}`, padding: '4px 14px', fontSize: 10, color: 'var(--text-muted)', fontWeight: 600 }}>
          {fmtPrice(total)}
        </div>
      )}

      <div style={{
        flex: 1, display: 'flex', flexDirection: 'column', gap: 8,
        background: 'var(--sub-box-bg)', border: `1px solid ${sc.border || 'var(--border)'}`,
        borderTop: 'none', borderRadius: '0 0 10px 10px', padding: '10px', minHeight: 80,
      }}>
        {leads.length === 0 && (
          <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 11, padding: '20px 0' }}>No leads</div>
        )}
        {leads.map(l => <PipelineCard key={l.id} lead={l} onClick={() => onCardClick(l)} />)}
      </div>
    </div>
  )
}

// ── List View ─────────────────────────────────────────────────────────────────

function ListView({ leads, onRowClick, onStatusChange }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Ref</th>
            <th>Company</th>
            <th>Industry</th>
            <th>Status</th>
            <th>Stage</th>
            <th>Risk</th>
            <th>Price</th>
            <th>Follow-Up</th>
            <th>Owner</th>
            <th>Received</th>
          </tr>
        </thead>
        <tbody>
          {leads.map(lead => {
            const fuOverdue = lead.next_follow_up && new Date(lead.next_follow_up) < new Date()
            return (
              <tr key={lead.id} className="tr-link" onClick={() => onRowClick(lead)}>
                <td><span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11, fontWeight: 700, color: 'var(--link)' }}>{lead.ref}</span></td>
                <td style={{ fontWeight: 600 }}>{lead.customer_name || <span style={{ color: 'var(--text-muted)' }}>—</span>}</td>
                <td><IndustryPill industry={lead.industry || 'General'} /></td>
                <td><StatusDropdown lead={lead} onChange={stage => onStatusChange(lead.id, stage)} /></td>
                <td><div style={{ display: 'flex', alignItems: 'center' }}><StageDot stage={lead.stage} /><span style={{ fontSize: 11 }}>{lead.stage}</span></div></td>
                <td><RiskBadge risk={lead.risk_level} /></td>
                <td style={{ fontWeight: 600, color: 'var(--blue)' }}>{fmtPrice(lead.quoted_price)}</td>
                <td style={{ fontSize: 11, color: fuOverdue ? 'var(--red)' : 'var(--text-muted)', fontWeight: fuOverdue ? 700 : 400 }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                    {fuOverdue && <AlertTriangle size={11} />}{fmtDate(lead.next_follow_up)}
                  </span>
                </td>
                <td style={{ fontSize: 11, color: lead.claimed_by ? 'var(--green)' : 'var(--text-muted)' }}>
                  {lead.claimed_by ? lead.claimed_by.split('@')[0] : '—'}
                </td>
                <td style={{ color: 'var(--text-muted)', fontSize: 12, whiteSpace: 'nowrap' }}>{timeAgo(lead.created_at)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ── Marketing Contacts View ───────────────────────────────────────────────────

function ContactsView() {
  const [contacts, setContacts] = useState([])
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState('')
  const [search, setSearch]     = useState('')
  const [deleting, setDeleting] = useState(null)

  useEffect(() => {
    setLoading(true)
    getMarketingContacts()
      .then(r => setContacts(r.data))
      .catch(() => setError('Failed to load contacts'))
      .finally(() => setLoading(false))
  }, [])

  async function handleDelete(id) {
    if (!window.confirm('Remove this contact from the mailing list?')) return
    setDeleting(id)
    try {
      await deleteMarketingContact(id)
      setContacts(prev => prev.filter(c => c.id !== id))
    } catch { alert('Failed to delete contact') }
    finally { setDeleting(null) }
  }

  function exportCSV() {
    downloadCSV([
      ['Email', 'Name', 'Industry', 'Source', 'Lead Ref', 'Archived Date'],
      ...filtered.map(c => [
        c.email, c.customer_name, c.industry, c.source, c.lead_ref, asDate(c.archived_at),
      ])
    ], `ZHL_Marketing_Contacts_${new Date().toISOString().slice(0, 10)}.csv`)
  }

  const q = search.toLowerCase()
  const filtered = contacts.filter(c =>
    !q
    || (c.email         || '').toLowerCase().includes(q)
    || (c.customer_name || '').toLowerCase().includes(q)
    || (c.industry      || '').toLowerCase().includes(q)
    || (c.source        || '').toLowerCase().includes(q)
    || (c.lead_ref      || '').toLowerCase().includes(q)
  )

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        <input className="form-control search-input"
          placeholder="Search email, name, industry..."
          value={search} onChange={e => setSearch(e.target.value)}
          style={{ flex: '1 1 260px', maxWidth: 360 }} />
        <span style={{ fontSize: 12, color: 'var(--text-muted)', marginLeft: 4 }}>
          {filtered.length} contact{filtered.length !== 1 ? 's' : ''}
        </span>
        <button className="btn btn-ghost btn-sm" onClick={exportCSV} disabled={filtered.length === 0}
          style={{ marginLeft: 'auto' }}>
          Export CSV
        </button>
      </div>

      {loading && <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--text-muted)' }}>Loading…</div>}
      {error   && <div className="alert alert-error">{error}</div>}

      {!loading && !error && filtered.length === 0 && (
        <div className="empty-state">
          <div className="empty-state-icon" style={{ fontSize: 36, display: 'flex', justifyContent: 'center', color: 'var(--text-muted)' }}><Inbox size={36} /></div>
          <h3>{search ? 'No contacts match your search' : 'No archived contacts yet'}</h3>
          <p style={{ fontSize: 13, marginTop: 4 }}>
            {search ? 'Try a different search term' : 'Emails are archived here automatically when a lead record is purged after 30 days'}
          </p>
        </div>
      )}

      {!loading && !error && filtered.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Email</th>
                <th>Name</th>
                <th>Industry</th>
                <th>Source</th>
                <th>Lead Ref</th>
                <th>Archived</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(c => (
                <tr key={c.id}>
                  <td><a href={`mailto:${c.email}`} style={{ color: 'var(--blue)', textDecoration: 'none' }}>{c.email}</a></td>
                  <td style={{ color: 'var(--text)' }}>{c.customer_name || '—'}</td>
                  <td style={{ color: 'var(--text-muted)', fontSize: 12 }}>{c.industry || '—'}</td>
                  <td style={{ color: 'var(--text-muted)', fontSize: 12 }}>{c.source || '—'}</td>
                  <td style={{ fontFamily: 'monospace', fontSize: 12, color: 'var(--text-muted)' }}>{c.lead_ref || '—'}</td>
                  <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{c.archived_at ? new Date(c.archived_at).toLocaleDateString('en-SG', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'}</td>
                  <td>
                    <button className="btn btn-ghost btn-xs" style={{ color: 'var(--red)' }}
                      disabled={deleting === c.id} onClick={() => handleDelete(c.id)}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ marginTop: 16, padding: '10px 14px', background: 'rgba(0,110,255,0.05)', borderRadius: 8, border: '1px solid rgba(0,110,255,0.15)', fontSize: 12, color: 'var(--text-muted)' }}>
        Emails are automatically archived here when a lead older than 30 days is purged from the pipeline. Use "Export CSV" to download the list for rate-sharing campaigns.
      </div>
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function Leads() {
  const [leads, setLeads]         = useState([])
  const [stats, setStats]         = useState(null)
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState('')
  const [view, setView]           = useState('pipeline')
  const [showArchived, setShowArchived] = useState(false)
  const [search, setSearch]       = useState('')
  const [modalLead, setModalLead] = useState(null)
  const [deckBusy, setDeckBusy] = useState('')
  const [offset, setOffset]       = useState(0)
  const [hasMore, setHasMore]     = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)

  function handleClaim(id, claimedBy) {
    setLeads(prev => prev.map(l => l.id === id ? { ...l, claimed_by: claimedBy } : l))
  }

  async function handleStatusChange(id, stage) {
    // mirror stage into status too — the backend's KPI queries read `status`,
    // not `stage`, so every stage-changing path needs to keep them in sync.
    try {
      await updateLead(id, { stage, status: stage })
      setLeads(prev => prev.map(l => l.id === id ? { ...l, stage, status: stage } : l))
    } catch { /* silent — the dropdown snaps back on next fetch */ }
  }

  const fetchAll = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const [lr, sr] = await Promise.all([
        getLeads({ archived: showArchived ? 'true' : 'false', limit: LEADS_PAGE_SIZE, offset: 0 }),
        getLeadStats(),
      ])
      const { items, hasMore: more } = extractLeadsPage(lr.data, 0, LEADS_PAGE_SIZE)
      setLeads(items)
      setOffset(items.length)
      setHasMore(more)
      setStats(sr.data)
    } catch {
      setError('Failed to load leads')
    } finally {
      setLoading(false)
    }
  }, [showArchived])

  useEffect(() => { fetchAll() }, [fetchAll])

  async function loadMore() {
    if (loadingMore || !hasMore) return
    setLoadingMore(true)
    try {
      const lr = await getLeads({ archived: showArchived ? 'true' : 'false', limit: LEADS_PAGE_SIZE, offset })
      const { items, hasMore: more } = extractLeadsPage(lr.data, offset, LEADS_PAGE_SIZE)
      setLeads(prev => [...prev, ...items])
      setOffset(o => o + items.length)
      setHasMore(more)
    } catch {
      // silent — the button just stays available for the user to retry
    } finally {
      setLoadingMore(false)
    }
  }

  const filtered = leads.filter(l => {
    const q = search.toLowerCase()
    return !q
      || (l.customer_name  || '').toLowerCase().includes(q)
      || (l.customer_email || '').toLowerCase().includes(q)
      || (l.ref            || '').toLowerCase().includes(q)
      || (l.industry       || '').toLowerCase().includes(q)
      || (l.stage          || '').toLowerCase().includes(q)
  })

  const byStage = PIPELINE_STAGES.reduce((acc, s) => {
    acc[s] = filtered.filter(l => l.stage === s)
    return acc
  }, {})

  // Exports whatever is currently on screen — so ticking "Show archived" and hitting this
  // gives you the dormant-lead list to run a "do you still need this shipped?" follow-up from.
  // Builds the management deck. Figures come from the server; the commentary is a
  // separate call so a failure there still leaves a deck full of real numbers rather
  // than nothing at all.
  async function buildDeck() {
    setDeckBusy('Gathering the month…')
    try {
      const { data: report } = await getMonthlyReport()

      let narrative = null
      try {
        setDeckBusy('Writing the commentary…')
        const { data } = await getMonthlyNarrative(report)
        narrative = data
      } catch {
        console.warn('[Motus] narrative unavailable, building deck without commentary')
      }

      setDeckBusy('Building slides…')
      // Rasterise the logo here rather than bundling it, matching how the PDFs do it.
      const logo = await new Promise(resolve => {
        const img = new Image()
        img.onload = () => {
          const canvas = document.createElement('canvas')
          canvas.width = img.naturalWidth; canvas.height = img.naturalHeight
          canvas.getContext('2d').drawImage(img, 0, 0)
          resolve(canvas.toDataURL('image/png'))
        }
        img.onerror = () => resolve(null)
        img.src = '/logo.png'
      })

      // pptxgenjs is heavy and only matters when someone asks for a deck.
      const { buildMonthlyDeck } = await import('../utils/monthlyDeck')
      await buildMonthlyDeck(report, narrative, logo)

      if (!narrative) {
        alert('Deck downloaded, but the AI commentary could not be generated. The slides contain the figures without the written analysis.')
      }
    } catch (err) {
      alert('Could not build the deck: ' + (err?.response?.data?.error || err.message))
    } finally {
      setDeckBusy('')
    }
  }

  function exportLeadsCSV() {
    downloadCSV([
      ['Ref', 'Company', 'Contact', 'Email', 'Phone', 'Stage', 'Status', 'Industry',
       'Quoted Price', 'Origin', 'Destination', 'Commodity', 'Service', 'Claimed By',
       'Created', 'Went Dormant', 'Archived', 'Next Follow-Up', 'Notes'],
      ...filtered.map(l => [
        l.ref, l.customer_name, l.contact_person, l.customer_email, l.phone_number,
        l.stage, l.status, l.industry, l.quoted_price, l.origin, l.destination,
        l.commodity_name, l.service_type, l.claimed_by,
        asDate(l.created_at), asDate(l.dormant_at), l.is_archived ? 'Yes' : 'No',
        asDate(l.next_follow_up), (l.notes || '').replace(/\s+/g, ' ').trim(),
      ])
    ], `ZHL_Leads${showArchived ? '_incl_archived' : ''}_${new Date().toISOString().slice(0, 10)}.csv`)
  }

  return (
    <div style={{ padding: '24px 32px', maxWidth: view === 'pipeline' ? 'none' : 1200, margin: view === 'pipeline' ? undefined : '0 auto' }}>

      {/* Header */}
      <div className="flex-between" style={{ marginBottom: 20 }}>
        <div className="page-header" style={{ marginBottom: 0 }}>
          <h1>Leads Pipeline</h1>
          <p>Manage freight enquiries and track opportunities</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="btn btn-ghost btn-sm" onClick={buildDeck} disabled={!!deckBusy}
            title="Build this month's management deck as an editable PowerPoint">
            {deckBusy
              ? <><span className="spinner spinner-dark"></span> {deckBusy}</>
              : <><Presentation size={14} /> Monthly Deck</>}
          </button>
          <button className="btn btn-ghost btn-sm" onClick={fetchAll}>Refresh</button>
          <button className="btn btn-primary btn-sm" onClick={() => setModalLead({})}>+ New Lead</button>
        </div>
      </div>

      {/* Stats bar */}
      {stats && view !== 'contacts' && (
        <div style={{ display: 'flex', gap: 12, marginBottom: 24, flexWrap: 'wrap' }}>
          <StatCard label="Active Leads" value={stats.total_active || 0} sub={`${leads.length} total loaded`} />
          <StatCard label="Pipeline Value"
            value={stats.pipeline_value ? `S$${Number(stats.pipeline_value).toLocaleString('en-SG', { maximumFractionDigits: 0 })}` : '—'}
            sub="quoted in active leads" />
          <StatCard label="Won This Month" value={stats.won_this_month?.count || 0}
            sub={stats.won_this_month?.value ? fmtPrice(stats.won_this_month.value) : 'closed won'} />
          <StatCard label="Top Industry" value={stats.by_industry?.[0]?.industry || '—'}
            sub={stats.by_industry?.[0] ? `${stats.by_industry[0].count} leads` : ''} />
        </div>
      )}

      {/* Unclaimed banner */}
      {view !== 'contacts' && !loading && (() => {
        const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000
        const unclaimed = leads.filter(l => !l.claimed_by && !l.is_archived && new Date(l.created_at).getTime() < cutoff)
        return unclaimed.length > 0 ? <AttentionBanner leads={unclaimed} onClaimed={fetchAll} /> : null
      })()}

      {/* Controls */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        {view !== 'contacts' && (
          <input className="form-control search-input"
            placeholder="Search company, email, ref, stage..."
            value={search} onChange={e => setSearch(e.target.value)}
            style={{ flex: '1 1 260px', maxWidth: 360 }} />
        )}
        <div style={{ display: 'flex', gap: 2, background: 'var(--sub-box-bg)', border: '1px solid var(--border)', borderRadius: 8, padding: 3 }}>
          {['pipeline', 'list', 'contacts'].map(v => (
            <button key={v} onClick={() => setView(v)}
              className={view === v ? 'btn btn-primary btn-xs' : 'btn btn-ghost btn-xs'}
              style={{ textTransform: 'capitalize' }}
            >{v}</button>
          ))}
        </div>
        {view !== 'contacts' && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-muted)', cursor: 'pointer' }}>
            <input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} />
            Show archived
          </label>
        )}
        {view !== 'contacts' && filtered.length > 0 && (
          <button className="btn btn-ghost btn-sm" onClick={exportLeadsCSV} title="Export the leads currently shown, including any search filter">
            Export CSV ({filtered.length})
          </button>
        )}
      </div>

      {view !== 'contacts' && loading && <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--text-muted)' }}>Loading…</div>}
      {view !== 'contacts' && error   && <div className="alert alert-error">{error}</div>}

      {view !== 'contacts' && !loading && !error && filtered.length === 0 && (
        <div className="empty-state">
          <div className="empty-state-icon" style={{ fontSize: 36, display: 'flex', justifyContent: 'center', color: 'var(--text-muted)' }}><ClipboardList size={36} /></div>
          <h3>{search ? 'No leads match your search' : 'No leads yet'}</h3>
          <p style={{ fontSize: 13, marginTop: 4 }}>
            {search ? 'Try a different search term' : 'Add a lead manually or submit an RFQ via your website'}
          </p>
        </div>
      )}

      {view !== 'contacts' && !loading && !error && filtered.length > 0 && view === 'pipeline' && (
        <div style={{ overflowX: 'auto', paddingBottom: 16 }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', minWidth: 'max-content' }}>
            {PIPELINE_STAGES.map(stage => (
              <PipelineColumn key={stage} stage={stage} leads={byStage[stage] || []} onCardClick={setModalLead} />
            ))}
          </div>
        </div>
      )}

      {view !== 'contacts' && !loading && !error && filtered.length > 0 && view === 'list' && (
        <ListView leads={filtered} onRowClick={setModalLead} onStatusChange={handleStatusChange} />
      )}

      {view !== 'contacts' && !loading && !error && hasMore && (
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: 16 }}>
          <button className="btn btn-ghost btn-sm" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? 'Loading…' : 'Load More'}
          </button>
        </div>
      )}

      {view === 'contacts' && <ContactsView />}

      {modalLead !== null && (
        <LeadModal lead={modalLead} onClose={() => setModalLead(null)} onSave={() => { setModalLead(null); fetchAll() }} onClaim={handleClaim} />
      )}
    </div>
  )
}
