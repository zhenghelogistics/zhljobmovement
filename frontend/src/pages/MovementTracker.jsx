import { useEffect, useState, useMemo, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import * as XLSX from 'xlsx'
import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'
import { ChevronUp, ChevronDown, Download, FileText, ClipboardList, ArrowRight, Presentation } from 'lucide-react'
import { getJobs, getMovementReport, getMovementQuestions, getMovementNarrative } from '../api'
import DeckQuestions from '../components/DeckQuestions'
import { parseLocalDate } from '../utils/format'

const MODES = ['', 'Air Express', 'Air Freight', 'LCL Express', 'LCL', 'Local Delivery', 'Local Clearance & Delivery', 'Sea FCL', 'Sea LCL', 'Warehousing']
const STATUSES = ['', 'New', 'In Progress', 'Completed', 'On Hold', 'Voided']

const fmt = (n) => n == null ? '—' : `$${Number(n).toLocaleString('en-SG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const fmtGP = (n) => n == null || isNaN(n) ? '—' : `${Number(n).toFixed(1)}%`

function deadlineInfo(date) {
  if (!date) return { label: '—', cls: '' }
  const today = new Date(); today.setHours(0,0,0,0)
  const d = parseLocalDate(date)
  const diff = Math.ceil((d - today) / (1000*60*60*24))
  if (diff < 0) return { label: date, cls: 'deadline-past' }
  if (diff <= 3) return { label: date, cls: 'deadline-soon' }
  return { label: date, cls: 'deadline-ok' }
}

// Extract the numeric sequence portion of a job number like "ZHL-1000/26"
// (the digits between "ZHL-" and "/") so job numbers sort numerically
// instead of lexicographically — otherwise "ZHL-1000/26" sorts before
// "ZHL-999/26" once a year passes 999 jobs.
function jobNumberSeq(jobNumber) {
  const match = String(jobNumber).match(/ZHL-(\d+)\//)
  return match ? Number(match[1]) : NaN
}

function gpClass(gp) {
  if (gp == null || isNaN(gp)) return 'text-muted'
  if (gp >= 20) return 'gp-high'
  if (gp >= 10) return 'gp-mid'
  return 'gp-low'
}

function StatusPill({ status }) {
  const map = { 'New': 'new', 'In Progress': 'inprogress', 'Completed': 'completed', 'On Hold': 'onhold', 'Voided': 'voided' }
  return <span className={`pill pill-${map[status] || 'new'}`}>{status || 'New'}</span>
}

const COLS = [
  { key: 'job_number', label: 'Job No.' },
  { key: 'customer_ref', label: 'Ref' },
  { key: 'shipper', label: 'Shipper' },
  { key: 'consignee', label: 'Consignee' },
  { key: 'mode', label: 'Mode' },
  { key: 'zhl_invoice_no', label: 'ZHL Inv No.' },
  { key: 'created_by', label: 'Salesperson' },
  { key: 'status', label: 'Status' },
  { key: 'deadline_date', label: 'Deadline' },
  { key: 'date_out', label: 'Date Out' },
  { key: 'date_delivered', label: 'Delivered' },
  { key: 'packages', label: 'Pkgs' },
  { key: 'weight', label: 'Wt (kg)' },
  { key: 'cost_sgd', label: 'Cost SGD' },
  { key: 'sale_sgd', label: 'Sale SGD' },
  { key: 'profit_sgd', label: 'Profit SGD' },
  { key: 'gp_percent', label: 'GP%' },
]

function shortName(email) {
  if (!email) return '—'
  const prefix = email.split('@')[0]
  const parts = prefix.split('.')
  if (parts.length >= 2) return parts[0].charAt(0).toUpperCase() + parts[0].slice(1) + ' ' + parts[1].charAt(0).toUpperCase() + '.'
  return prefix.charAt(0).toUpperCase() + prefix.slice(1)
}

const navy = [0, 48, 135]
const blue = [0, 110, 255]

export default function MovementTracker() {
  const [jobs, setJobs] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [deckBusy, setDeckBusy] = useState('')
  const [showDeckMenu, setShowDeckMenu] = useState(false)
  const [deckAsk, setDeckAsk] = useState(null)  // { report, questions }
  const [search, setSearch] = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const [filterMode, setFilterMode] = useState('')
  const [filterCreatedBy, setFilterCreatedBy] = useState('')
  const [showVoided, setShowVoided] = useState(false)
  const [sortKey, setSortKey] = useState('id')
  const [sortDir, setSortDir] = useState('desc')
  const navigate = useNavigate()
  const logoRef = useRef(null)
  const requestIdRef = useRef(0)
  const isFirstLoadRef = useRef(true)

  useEffect(() => {
    const img = new Image()
    img.onload = () => {
      const MAX = 400
      const scale = Math.min(1, MAX / img.naturalWidth)
      const canvas = document.createElement('canvas')
      canvas.width  = Math.round(img.naturalWidth  * scale)
      canvas.height = Math.round(img.naturalHeight * scale)
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height)
      logoRef.current = canvas.toDataURL('image/png')
    }
    img.src = '/logo.png'
  }, [])

  function load() {
    // Stamp this request so a slower, older request can't clobber the
    // results of a newer one that resolves first.
    const requestId = ++requestIdRef.current
    setLoading(true)
    getJobs({
      search: search || undefined,
      status: filterStatus || undefined,
      mode: filterMode || undefined,
      created_by: filterCreatedBy || undefined,
    })
      .then(r => {
        if (requestIdRef.current !== requestId) return // stale response, ignore
        setJobs(r.data)
        setError('')
        setLoading(false)
      })
      .catch(err => {
        if (requestIdRef.current !== requestId) return
        // Without this the list just renders empty, so a dropped connection looks
        // identical to "no jobs match your filters". Every other list page in the
        // app surfaces its load failure.
        setError(err?.response?.data?.error || 'Could not load jobs. Check your connection and try again.')
        setLoading(false)
      })
  }

  // Debounce re-fetching while the user is still typing in the search box
  // (and filter changes, which arrive far less often) so we don't fire a
  // network request on every keystroke. The initial mount loads immediately.
  useEffect(() => {
    if (isFirstLoadRef.current) {
      isFirstLoadRef.current = false
      load()
      return
    }
    const timer = setTimeout(() => { load() }, 300)
    return () => clearTimeout(timer)
  }, [search, filterStatus, filterMode, filterCreatedBy])

  function handleSort(key) {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('asc') }
  }

  const sorted = useMemo(() => {
    return [...jobs]
      .filter(j => showVoided ? true : j.status !== 'Voided')
      .sort((a, b) => {
        const av = a[sortKey], bv = b[sortKey]
        if (av == null && bv == null) return 0
        if (av == null) return 1
        if (bv == null) return -1
        let cmp
        if (sortKey === 'job_number') {
          const an = jobNumberSeq(av), bn = jobNumberSeq(bv)
          cmp = (!isNaN(an) && !isNaN(bn)) ? an - bn : String(av).localeCompare(String(bv))
        } else {
          cmp = typeof av === 'number' ? av - bv : String(av).localeCompare(String(bv))
        }
        return sortDir === 'asc' ? cmp : -cmp
      })
  }, [jobs, sortKey, sortDir, showVoided])

  const voidedCount = jobs.filter(j => j.status === 'Voided').length

  // Summary from currently visible jobs
  const mRevenue = sorted.reduce((s, j) => s + (j.sale_sgd||0), 0)
  const mCost = sorted.reduce((s, j) => s + (j.cost_sgd||0), 0)
  const mProfit = mRevenue - mCost
  const mGP = mRevenue > 0 ? (mProfit/mRevenue)*100 : 0

  const staffOptions = useMemo(() => {
    const emails = [...new Set(jobs.map(j => j.created_by).filter(Boolean))].sort()
    return emails
  }, [jobs])


  // Builds the operations review deck for a month, quarter or year. Figures come from
  // the server; the commentary is a separate call so a failure there still leaves a
  // deck full of real numbers rather than nothing at all.
  // Step one: pull the period, then let the model ask about anything it cannot explain
  // from the figures alone. Those answers are the difference between commentary that
  // restates numbers and commentary that says something.
  async function buildDeck(period) {
    setShowDeckMenu(false)
    setDeckBusy('Gathering the period…')
    try {
      const { data: report } = await getMovementReport(period)

      let questions = [], note = 'failed'
      try {
        setDeckBusy('Reviewing the figures…')
        const { data } = await getMovementQuestions(report)
        questions = data.questions || []
        note = data.note || 'ok'
      } catch {
        // Never block the deck on this.
      }

      // Always open the prompt, even with no generated questions: the presenter should
      // always get the chance to add what the figures cannot show, and in a quiet period
      // that context matters more, not less.
      setDeckBusy('')
      setDeckAsk({ report, questions, note })
    } catch (err) {
      alert('Could not build the deck: ' + (err?.response?.data?.error || err.message))
      setDeckBusy('')
    }
  }

  // Step two: write the commentary and assemble the slides.
  async function finishDeck(report, answers) {
    setDeckAsk(null)
    setDeckBusy('Writing the commentary…')
    try {
      let narrative = null
      try {
        const { data } = await getMovementNarrative(report, answers)
        narrative = data
      } catch {
        console.warn('[Motus] narrative unavailable, building deck without commentary')
      }

      setDeckBusy('Building slides…')
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
      const { buildMovementDeck } = await import('../utils/movementDeck')
      await buildMovementDeck(report, narrative, logo)

      if (!narrative) {
        alert('Deck downloaded, but the AI commentary could not be generated. The slides contain the figures without the written analysis.')
      }
    } catch (err) {
      alert('Could not build the deck: ' + (err?.response?.data?.error || err.message))
    } finally {
      setDeckBusy('')
    }
  }

  // Offer this period and the last few, so the common cases are one click and nobody
  // has to work out what to type.
  function deckPeriods() {
    const now = new Date()
    const y = now.getFullYear(), m = now.getMonth()
    const monthRef = (dt) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`
    const monthName = (dt) => dt.toLocaleDateString('en-SG', { month: 'long', year: 'numeric' })
    const thisMonth = new Date(y, m, 1)
    const lastMonth = new Date(y, m - 1, 1)
    const q = Math.floor(m / 3) + 1
    const prevQ = q === 1 ? { q: 4, y: y - 1 } : { q: q - 1, y }
    return [
      { label: monthName(thisMonth), ref: monthRef(thisMonth), group: 'Month' },
      { label: monthName(lastMonth), ref: monthRef(lastMonth), group: 'Month' },
      { label: `Q${q} ${y}`, ref: `${y}-Q${q}`, group: 'Quarter' },
      { label: `Q${prevQ.q} ${prevQ.y}`, ref: `${prevQ.y}-Q${prevQ.q}`, group: 'Quarter' },
      { label: String(y), ref: String(y), group: 'Year' },
      { label: String(y - 1), ref: String(y - 1), group: 'Year' },
    ]
  }

  function exportExcel() {
    const rows = sorted.map(j => ({
      'Job No.': j.job_number,
      'Customer Ref': j.customer_ref,
      'Shipper': j.shipper,
      'Consignee': j.consignee,
      'Mode': j.mode,
      'ZHL Inv No.': j.zhl_invoice_no,
      'Salesperson': shortName(j.created_by),
      'Status': j.status,
      'Deadline': j.deadline_date,
      'Date Out': j.date_out,
      'Date Delivered': j.date_delivered,
      'Packages': j.packages,
      'Weight (kg)': j.weight,
      'Cost SGD': j.cost_sgd,
      'Sale SGD': j.sale_sgd,
      'Profit SGD': j.profit_sgd,
      'GP%': j.gp_percent,
    }))
    const ws = XLSX.utils.json_to_sheet(rows)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Movement Tracker')
    XLSX.writeFile(wb, `ZHL_Movement_Tracker_${new Date().toISOString().split('T')[0]}.xlsx`)
  }

  function exportPDFReport() {
    const doc = new jsPDF('l', 'mm', 'a4')  // landscape for wide table
    const pw = 297, ph = 210, ml = 12, mr = 12, tw = pw - ml - mr

    // Header bar
    doc.setFillColor(...navy)
    doc.rect(0, 0, pw, 32, 'F')
    if (logoRef.current) doc.addImage(logoRef.current, 'PNG', 5, 1, 24, 30)
    doc.setTextColor(255, 255, 255)
    doc.setFontSize(8.5); doc.setFont('helvetica', 'normal')
    doc.text('Freight Forwarding & Logistics', 33, 12)
    doc.setDrawColor(255, 255, 255); doc.setLineWidth(0.2)
    doc.line(33, 16, pw - mr, 16)
    doc.setDrawColor(0)
    doc.text('rfq@zhenghe.com.sg', 33, 23)
    doc.setFontSize(13); doc.setFont('helvetica', 'bold')
    doc.text('MOVEMENT REPORT', pw - mr, 12, { align: 'right' })
    doc.setFontSize(8); doc.setFont('helvetica', 'normal')
    doc.text(`Generated: ${new Date().toLocaleDateString('en-SG')}`, pw - mr, 23, { align: 'right' })

    // Filter summary line
    const filterParts = []
    if (filterCreatedBy) filterParts.push(`Salesperson: ${shortName(filterCreatedBy)} (${filterCreatedBy})`)
    if (filterStatus)    filterParts.push(`Status: ${filterStatus}`)
    if (filterMode)      filterParts.push(`Mode: ${filterMode}`)
    if (search)          filterParts.push(`Search: "${search}"`)
    if (!showVoided)     filterParts.push('Voided jobs excluded')

    let y = 38
    if (filterParts.length) {
      doc.setFontSize(8); doc.setFont('helvetica', 'italic'); doc.setTextColor(80, 80, 80)
      doc.text(`Filters: ${filterParts.join('  |  ')}`, ml, y)
      y += 6
    }

    // Metrics summary box
    const mStr = [
      `Jobs: ${sorted.length}`,
      `Revenue: $${Number(mRevenue).toLocaleString('en-SG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
      `Cost: $${Number(mCost).toLocaleString('en-SG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
      `Profit: $${Number(mProfit).toLocaleString('en-SG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
      `GP: ${mRevenue > 0 ? ((mProfit/mRevenue)*100).toFixed(1) : '0.0'}%`,
    ]
    autoTable(doc, {
      startY: y,
      body: [mStr.map(s => ({ content: s, styles: { fontStyle: 'bold', fontSize: 8.5, halign: 'center' } }))],
      styles: { fillColor: [237, 242, 248], textColor: navy, cellPadding: 4 },
      margin: { left: ml, right: mr },
      tableWidth: tw,
    })

    // Jobs table
    autoTable(doc, {
      startY: doc.lastAutoTable.finalY + 4,
      head: [['Job No.', 'Ref', 'Shipper', 'Consignee', 'Mode', 'Salesperson', 'Status', 'Deadline', 'Date Out', 'Delivered', 'Cost (SGD)', 'Sale (SGD)', 'Profit (SGD)', 'GP%']],
      body: sorted.map(j => [
        j.job_number,
        j.customer_ref || '—',
        j.shipper || '—',
        j.consignee || '—',
        j.mode || '—',
        shortName(j.created_by),
        j.status || '—',
        j.deadline_date || '—',
        j.date_out || '—',
        j.date_delivered || '—',
        j.cost_sgd != null ? `$${Number(j.cost_sgd).toFixed(2)}` : '—',
        j.sale_sgd != null ? `$${Number(j.sale_sgd).toFixed(2)}` : '—',
        j.profit_sgd != null ? `$${Number(j.profit_sgd).toFixed(2)}` : '—',
        j.gp_percent != null ? `${Number(j.gp_percent).toFixed(1)}%` : '—',
      ]),
      foot: [[
        { content: `${sorted.length} jobs`, colSpan: 10, styles: { fontStyle: 'bold', halign: 'right' } },
        { content: `$${Number(mCost).toFixed(2)}`,   styles: { fontStyle: 'bold', halign: 'right' } },
        { content: `$${Number(mRevenue).toFixed(2)}`, styles: { fontStyle: 'bold', halign: 'right' } },
        { content: `$${Number(mProfit).toFixed(2)}`,  styles: { fontStyle: 'bold', halign: 'right' } },
        { content: `${mRevenue > 0 ? ((mProfit/mRevenue)*100).toFixed(1) : '0.0'}%`, styles: { fontStyle: 'bold', halign: 'right' } },
      ]],
      headStyles: { fillColor: navy, fontSize: 7.5, fontStyle: 'bold', textColor: [255,255,255] },
      footStyles: { fillColor: [237,242,248], textColor: navy, fontSize: 8, fontStyle: 'bold' },
      styles: { fontSize: 7.5, cellPadding: 2.5, overflow: 'linebreak' },
      columnStyles: {
        0:  { cellWidth: 20, fontStyle: 'bold' },
        1:  { cellWidth: 18 },
        2:  { cellWidth: 26 },
        3:  { cellWidth: 26 },
        4:  { cellWidth: 20 },
        5:  { cellWidth: 18 },
        6:  { cellWidth: 16 },
        7:  { cellWidth: 16 },
        8:  { cellWidth: 16 },
        9:  { cellWidth: 16 },
        10: { cellWidth: 20, halign: 'right' },
        11: { cellWidth: 20, halign: 'right' },
        12: { cellWidth: 20, halign: 'right', fontStyle: 'bold' },
        13: { cellWidth: 12, halign: 'right' },
      },
      margin: { left: ml, right: mr },
      tableWidth: tw,
    })

    // Page numbers
    const totalPages = doc.internal.getNumberOfPages()
    for (let p = 1; p <= totalPages; p++) {
      doc.setPage(p); doc.setFontSize(7); doc.setTextColor(150, 150, 150)
      const label = filterCreatedBy ? `Salesperson: ${shortName(filterCreatedBy)}` : 'All Salespersons'
      doc.text(`Zhenghe Logistics Pte Ltd — Movement Report — ${label}`, ml, ph - 5)
      doc.text(`Page ${p} of ${totalPages}`, pw - mr, ph - 5, { align: 'right' })
    }

    const filePart = filterCreatedBy ? `_${filterCreatedBy.split('@')[0]}` : ''
    doc.save(`ZHL_MovementReport${filePart}_${new Date().toISOString().split('T')[0]}.pdf`)
  }

  const sortIcon = (key) => sortKey !== key ? null : (sortDir === 'asc'
    ? <ChevronUp size={12} style={{ verticalAlign: 'middle', marginLeft: 2 }} />
    : <ChevronDown size={12} style={{ verticalAlign: 'middle', marginLeft: 2 }} />)

  return (
    <div>
      <div className="page-header flex-between">
        <div>
          <h1>Movement Tracker</h1>
          <p>{jobs.length} job{jobs.length !== 1 ? 's' : ''} found</p>
        </div>
        <div className="flex gap-2">
          <div style={{ position: 'relative', display: 'inline-block' }}>
            <button className="btn btn-ghost btn-sm" onClick={() => setShowDeckMenu(v => !v)} disabled={!!deckBusy}
              title="Build an operations review deck as an editable PowerPoint">
              {deckBusy
                ? <><span className="spinner spinner-dark"></span> {deckBusy}</>
                : <><Presentation size={14} style={{ marginRight: 4, verticalAlign: 'middle' }} />Review Deck</>}
            </button>
            {showDeckMenu && !deckBusy && (
              <>
                {/* full-screen catcher so a click anywhere closes the menu */}
                <div style={{ position: 'fixed', inset: 0, zIndex: 199 }} onClick={() => setShowDeckMenu(false)} />
                <div style={{
                  position: 'absolute', top: '100%', right: 0, zIndex: 200, marginTop: 4, minWidth: 190,
                  background: 'var(--surface)', border: '1px solid var(--border-solid)', borderRadius: 8,
                  boxShadow: '0 8px 24px rgba(0,0,0,0.18)', overflow: 'hidden',
                }}>
                  {deckPeriods().map((p, i, arr) => (
                    <div key={p.ref}>
                      {(i === 0 || arr[i - 1].group !== p.group) && (
                        <div style={{ padding: '7px 12px 3px', fontSize: 9, fontWeight: 800, letterSpacing: '0.5px',
                          textTransform: 'uppercase', color: 'var(--text-muted)' }}>{p.group}</div>
                      )}
                      <div onClick={() => buildDeck(p.ref)}
                        style={{ padding: '7px 12px', fontSize: 13, cursor: 'pointer', color: 'var(--text)' }}
                        onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
                        onMouseLeave={e => e.currentTarget.style.background = ''}>
                        {p.label}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
          {deckAsk && (
            <DeckQuestions
              questions={deckAsk.questions}
              note={deckAsk.note}
              periodLabel={deckAsk.report.period.label}
              onSubmit={answers => finishDeck(deckAsk.report, answers)}
              onSkip={() => finishDeck(deckAsk.report, [])}
              onClose={() => setDeckAsk(null)}
            />
          )}
          <button className="btn btn-ghost btn-sm" onClick={exportExcel}><Download size={14} style={{ marginRight: 4, verticalAlign: 'middle' }} />Export Excel</button>
          <button className="btn btn-ghost btn-sm" onClick={exportPDFReport}><FileText size={14} style={{ marginRight: 4, verticalAlign: 'middle' }} />PDF Report</button>
          <button className="btn btn-primary" onClick={() => navigate('/intake')}>+ New Job</button>
        </div>
      </div>

      {/* Metric cards */}
      <div className="metric-grid" style={{ gridTemplateColumns: 'repeat(5,1fr)' }}>
        <div className="metric-card">
          <div className="metric-label">Jobs Shown</div>
          <div className="metric-value blue">{sorted.length}</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">Revenue</div>
          <div className="metric-value">{fmt(mRevenue)}</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">Total Cost</div>
          <div className="metric-value">{fmt(mCost)}</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">Profit</div>
          <div className={`metric-value ${mProfit >= 0 ? 'green' : ''}`}>{fmt(mProfit)}</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">Avg GP%</div>
          <div className={`metric-value ${gpClass(mGP)}`}>{fmtGP(mGP)}</div>
        </div>
      </div>

      {/* Filters */}
      <div className="filters-bar">
        <input
          className="form-control search-input"
          placeholder="Search job no., shipper, consignee, ref..."
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <select className="form-control" value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
          {STATUSES.map(s => <option key={s} value={s}>{s || 'All Statuses'}</option>)}
        </select>
        <select className="form-control" value={filterMode} onChange={e => setFilterMode(e.target.value)}>
          {MODES.map(m => <option key={m} value={m}>{m || 'All Modes'}</option>)}
        </select>
        <select className="form-control" value={filterCreatedBy} onChange={e => setFilterCreatedBy(e.target.value)}>
          <option value=''>All Salespersons</option>
          {staffOptions.map(email => <option key={email} value={email}>{shortName(email)}</option>)}
        </select>
        {(search || filterStatus || filterMode || filterCreatedBy) &&
          <button className="btn btn-ghost btn-sm" onClick={() => { setSearch(''); setFilterStatus(''); setFilterMode(''); setFilterCreatedBy('') }}>Clear</button>
        }
        {voidedCount > 0 && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-muted)', cursor: 'pointer', whiteSpace: 'nowrap', userSelect: 'none' }}>
            <input type="checkbox" checked={showVoided} onChange={e => setShowVoided(e.target.checked)} />
            Show voided ({voidedCount})
          </label>
        )}
      </div>

      {/* Desktop table */}
      <div className="table-wrap">
        {loading
          ? <div style={{ padding: 40, textAlign: 'center' }}><span className="spinner spinner-dark" style={{width:28,height:28}}></span></div>
          : error
          ? <div className="alert alert-error" style={{ margin: 16 }}>{error}</div>
          : jobs.length === 0
            ? <div className="empty-state"><div className="empty-state-icon"><ClipboardList size={36} style={{ color: 'var(--text-muted)' }} /></div><h3>No jobs found</h3><p>Create a new job to get started.</p></div>
            : <table className="spreadsheet">
                <thead>
                  <tr>
                    {COLS.map(c => (
                      <th key={c.key} onClick={() => handleSort(c.key)}>
                        {c.label}{sortIcon(c.key)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sorted.map(job => {
                    const dl = deadlineInfo(job.deadline_date)
                    const isVoided = job.status === 'Voided'
                    return (
                      <tr key={job.id} className="tr-link" onClick={() => navigate(`/jobs/${job.id}`)}
                        style={isVoided ? { opacity: 0.45, background: '#fafafa' } : {}}>
                        <td style={{ fontWeight: 700, color: 'var(--heading)', whiteSpace: 'nowrap', textDecoration: isVoided ? 'line-through' : 'none' }}>{job.job_number}</td>
                        <td style={{ color: 'var(--blue)', fontWeight: 600 }}>{job.customer_ref || '—'}</td>
                        <td>{job.shipper || '—'}</td>
                        <td>{job.consignee || '—'}</td>
                        <td style={{ whiteSpace: 'nowrap' }}><ModeTag mode={job.mode} /></td>
                        <td>{job.zhl_invoice_no || '—'}</td>
                        <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{shortName(job.created_by)}</td>
                        <td><StatusPill status={job.status} /></td>
                        <td><span className={dl.cls} style={{ whiteSpace: 'nowrap', fontSize: 13 }}>{dl.label}</span></td>
                        <td style={{ whiteSpace: 'nowrap' }}>{job.date_out || '—'}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>{job.date_delivered || '—'}</td>
                        <td className="text-right">{job.packages ?? '—'}</td>
                        <td className="text-right">{job.weight != null ? job.weight : '—'}</td>
                        <td className="text-right">{fmt(job.cost_sgd)}</td>
                        <td className="text-right">{fmt(job.sale_sgd)}</td>
                        <td className={`text-right ${job.profit_sgd >= 0 ? 'text-green' : 'text-red'}`} style={{ fontWeight: 600 }}>{fmt(job.profit_sgd)}</td>
                        <td className={`text-right ${gpClass(job.gp_percent)}`}>{fmtGP(job.gp_percent)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
        }
      </div>

      {/* Mobile cards */}
      <div className="job-cards">
        {sorted.map(job => {
          const dl = deadlineInfo(job.deadline_date)
          return (
            <div key={job.id} className="job-card" onClick={() => navigate(`/jobs/${job.id}`)}>
              <div className="job-card-header">
                <div>
                  <div className="job-card-number">{job.job_number}</div>
                  {job.customer_ref && <div className="job-card-ref">Ref: {job.customer_ref}</div>}
                </div>
                <StatusPill status={job.status} />
              </div>
              <div className="job-card-names">
                <strong>{job.shipper || '—'}</strong> <ArrowRight size={12} style={{ verticalAlign: 'middle' }} /> {job.consignee || '—'}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{job.mode}{job.created_by ? ` · ${shortName(job.created_by)} (Sales)` : ''}</div>
              <div className="job-card-footer">
                <span className={dl.cls} style={{ fontSize: 12 }}>{dl.label !== '—' ? `Due: ${dl.label}` : ''}</span>
                <span className={gpClass(job.gp_percent)} style={{ fontSize: 13 }}>{fmtGP(job.gp_percent)}</span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function ModeTag({ mode }) {
  const colors = {
    'Air Express': { bg: '#EDE9FE', color: '#5B21B6' },
    'Air Freight': { bg: '#F3E8FF', color: '#7C3AED' },
    'LCL Express': { bg: '#FEF3C7', color: '#92400E' },
    'LCL':         { bg: '#FEF9C3', color: '#854D0E' },
    'Sea FCL': { bg: '#DBEAFE', color: '#1D4ED8' },
    'Sea LCL': { bg: '#BFDBFE', color: '#1E40AF' },
    'Local Delivery': { bg: '#D1FAE5', color: '#065F46' },
    'Local Clearance & Delivery': { bg: '#D1FAE5', color: '#065F46' },
    'Warehousing': { bg: '#E0F2FE', color: '#0369A1' },
  }
  const style = colors[mode] || { bg: '#F1F4F7', color: '#6B7E93' }
  return (
    <span style={{ background: style.bg, color: style.color, padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 700 }}>
      {mode}
    </span>
  )
}
