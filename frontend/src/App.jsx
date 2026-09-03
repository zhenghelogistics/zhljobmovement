import { BrowserRouter, Routes, Route, NavLink, useNavigate, useLocation } from 'react-router-dom'
import { useState, useEffect, lazy, Suspense } from 'react'
import {
  LayoutDashboard, Route as RouteIcon, PlusCircle, BarChart3, Calculator, Inbox,
  Sparkles, DollarSign, UserCircle, LogOut, X, ArrowRightLeft, AlertTriangle, Sun, Moon, Check,
  ReceiptText,
} from 'lucide-react'
const ProfileModal = lazy(() => import('./components/ProfileModal'))

// Pages are loaded on demand rather than all bundled into the first download.
// Statically importing them meant opening the Dashboard also pulled in jsPDF (used
// by three pages), xlsx, recharts and every other page's code — a 1.8 MB bundle that
// had to arrive and parse before anything appeared on screen. Splitting per route
// means each page's weight is paid only when someone actually visits it.
//
// Login and AuthCallback stay eager: they are the very first thing an unauthenticated
// visitor sees, so lazy-loading them would only add a spinner to the critical path.
import Login from './pages/Login'
import AuthCallback from './pages/AuthCallback'
import ResetPassword from './pages/ResetPassword'
const Dashboard       = lazy(() => import('./pages/Dashboard'))
const MovementTracker = lazy(() => import('./pages/MovementTracker'))
const JobDetail       = lazy(() => import('./pages/JobDetail'))
const EmailIntake     = lazy(() => import('./pages/EmailIntake'))
const CompanyStats    = lazy(() => import('./pages/CompanyStats'))
const QuoteCalculator = lazy(() => import('./pages/QuoteCalculator'))
const Leads           = lazy(() => import('./pages/Leads'))
const RateCards       = lazy(() => import('./pages/RateCards'))
import { AuthProvider, useAuth } from './lib/AuthContext'
import { CHANGELOG } from './changelog'
import { getFxRates, updateFxRates, unlockFxRate, getNewLeadsCount } from './api'
import { nameFromEmail } from './utils/format'

const NAV = [
  { to: '/',       icon: LayoutDashboard, label: 'Dashboard',         exact: true },
  { to: '/jobs',   icon: RouteIcon,       label: 'Movement Tracker',  exact: false },
  { to: '/intake', icon: PlusCircle,      label: 'New Job',           exact: false },
  { to: '/stats',  icon: BarChart3,       label: 'Company Stats',     exact: false },
  { to: '/quote',  icon: Calculator,      label: 'Quote Calculator',  exact: false },
  { to: '/leads',  icon: Inbox,           label: 'Leads Pipeline',     exact: false },
  { to: '/rates',  icon: ReceiptText,     label: 'Rate Cards',        exact: false },
]

// Default SGD-based rates (approximate; overwritten by the daily Yahoo Finance sync)
const DEFAULT_RATES = {
  USD: 0.745, EUR: 0.688, CNY: 5.35, MYR: 3.35, HKD: 5.8, THB: 26.5,
  VND: 18500, IDR: 11900, INR: 63, JPY: 112, GBP: 0.58, AUD: 1.12,
  KRW: 1010, PHP: 43, TWD: 23.5, AED: 2.74,
}
const FX_ORDER = ['USD', 'EUR', 'CNY', 'MYR', 'HKD', 'THB', 'VND', 'IDR', 'INR', 'JPY', 'GBP', 'AUD', 'KRW', 'PHP', 'TWD', 'AED']
const sortedRateEntries = (rates) => FX_ORDER.filter(c => c in rates).map(c => [c, rates[c]])

const SEEN_KEY = 'changelog_seen_count'

function WhatsNewModal({ onClose }) {
  const navigate = useNavigate()

  useEffect(() => {
    localStorage.setItem(SEEN_KEY, String(CHANGELOG.length))
  }, [])

  function go(route) {
    onClose()
    navigate(route)
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 520 }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2 style={{ fontSize: 16 }}>What's New</h2>
          <button className="btn btn-ghost btn-sm" onClick={onClose}><X size={14} /></button>
        </div>
        <div className="modal-body" style={{ padding: '4px 20px 20px', maxHeight: '70vh', overflowY: 'auto' }}>
          {CHANGELOG.map((entry, i) => (
            <div key={entry.id} style={{
              borderLeft: `3px solid ${i === 0 ? '#006EFF' : '#D1DCE8'}`,
              paddingLeft: 16,
              paddingTop: 14,
              paddingBottom: 14,
              borderBottom: i < CHANGELOG.length - 1 ? '1px solid var(--border)' : 'none',
              marginLeft: 4,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, marginBottom: 4 }}>
                <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--heading)', flex: 1 }}>{entry.title}</span>
                <span style={{
                  fontSize: 10, fontWeight: 700, color: i === 0 ? '#006EFF' : '#6B7E93',
                  background: i === 0 ? '#E8F1FA' : 'var(--bg-hover)',
                  borderRadius: 6, padding: '2px 7px', flexShrink: 0, whiteSpace: 'nowrap',
                }}>{entry.date}</span>
              </div>
              <p style={{ fontSize: 13, color: '#4A5568', lineHeight: 1.6, margin: '0 0 10px' }}>{entry.description}</p>
              {entry.route && (
                <button
                  className="btn btn-sm"
                  style={{ fontSize: 12, padding: '4px 12px', border: '1.5px solid var(--navy)', color: 'var(--heading)', background: 'transparent', borderRadius: 6, cursor: 'pointer', fontFamily: 'var(--font)' }}
                  onClick={() => go(entry.route)}
                >
                  {entry.routeLabel} →
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function toInverse(fwd) {
  const n = parseFloat(fwd)
  return n > 0 ? (1 / n).toFixed(6).replace(/\.?0+$/, '') : ''
}
function toForward(inv) {
  const n = parseFloat(inv)
  return n > 0 ? (1 / n).toFixed(6).replace(/\.?0+$/, '') : ''
}

function CurrencyConverter({ onClose, onRatesSaved }) {
  const [amount, setAmount] = useState('1000')
  const [base, setBase] = useState('SGD')
  const [rates, setRates] = useState(DEFAULT_RATES)
  const [draftRates, setDraftRates] = useState(
    Object.fromEntries(Object.entries(DEFAULT_RATES).map(([c, v]) => [c, String(v)]))
  )
  const [draftInverse, setDraftInverse] = useState(
    Object.fromEntries(Object.entries(DEFAULT_RATES).map(([c, v]) => [c, toInverse(v)]))
  )
  const [isManual, setIsManual] = useState({})
  const [updatedAt, setUpdatedAt] = useState(null)
  const [updatedBy, setUpdatedBy] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [unlocking, setUnlocking] = useState({})
  const [tab, setTab] = useState('converter')

  useEffect(() => {
    getFxRates()
      .then(r => {
        const loaded = r.data.rates || DEFAULT_RATES
        setRates(loaded)
        setDraftRates(Object.fromEntries(Object.entries(loaded).map(([c, v]) => [c, String(v)])))
        setDraftInverse(Object.fromEntries(Object.entries(loaded).map(([c, v]) => [c, toInverse(v)])))
        setIsManual(r.data.is_manual || {})
        setUpdatedAt(r.data.updated_at)
        setUpdatedBy(r.data.updated_by)
      })
      .catch(() => {})
  }, [])

  function onForwardChange(c, val) {
    setDraftRates(prev => ({ ...prev, [c]: val }))
    const inv = toInverse(val)
    if (inv) setDraftInverse(prev => ({ ...prev, [c]: inv }))
  }

  function onInverseChange(c, val) {
    setDraftInverse(prev => ({ ...prev, [c]: val }))
    const fwd = toForward(val)
    if (fwd) setDraftRates(prev => ({ ...prev, [c]: fwd }))
  }

  async function saveRates() {
    setSaving(true)
    setSaveError('')
    try {
      const parsed = Object.fromEntries(
        FX_ORDER.map(c => [c, parseFloat(draftRates[c]) || rates[c] || DEFAULT_RATES[c]])
      )
      const r = await updateFxRates(parsed)
      setRates(parsed)
      setDraftRates(Object.fromEntries(Object.entries(parsed).map(([c, v]) => [c, String(v)])))
      setDraftInverse(Object.fromEntries(Object.entries(parsed).map(([c, v]) => [c, toInverse(v)])))
      setIsManual(Object.fromEntries(FX_ORDER.map(c => [c, true])))
      setUpdatedAt(r.data.updated_at)
      setUpdatedBy(r.data.updated_by)
      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
      if (onRatesSaved) onRatesSaved(parsed)
      window.dispatchEvent(new CustomEvent('fxRatesUpdated', { detail: parsed }))
    } catch (err) {
      setSaveError(err?.response?.data?.error || 'Failed to save. Please try again.')
    } finally { setSaving(false) }
  }

  async function handleUnlock(currency) {
    setUnlocking(prev => ({ ...prev, [currency]: true }))
    try {
      const r = await unlockFxRate(currency)
      const newRate = r.data.rate
      setRates(prev => ({ ...prev, [currency]: newRate }))
      setDraftRates(prev => ({ ...prev, [currency]: String(newRate) }))
      setDraftInverse(prev => ({ ...prev, [currency]: toInverse(newRate) }))
      setIsManual(prev => ({ ...prev, [currency]: false }))
    } catch {
      // silent fail — user can try again
    } finally {
      setUnlocking(prev => ({ ...prev, [currency]: false }))
    }
  }

  const currencies = ['SGD', ...Object.keys(rates)]
  const num = parseFloat(amount) || 0
  const sgdAmount = base === 'SGD' ? num : num / (rates[base] || 1)

  const lastUpdatedLabel = updatedAt
    ? `Last set ${new Date(updatedAt).toLocaleDateString('en-SG')}${updatedBy ? ' by ' + nameFromEmail(updatedBy) : ''}`
    : 'Rates not yet saved'

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 480 }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2 style={{ fontSize: 16 }}>FX Rates & Converter</h2>
          <button className="btn btn-ghost btn-sm" onClick={onClose}><X size={14} /></button>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', padding: '0 20px' }}>
          {['converter', 'rates'].map(t => (
            <button key={t} onClick={() => setTab(t)} style={{
              background: 'none', border: 'none', padding: '10px 16px', cursor: 'pointer',
              fontWeight: tab === t ? 700 : 400, fontSize: 13,
              color: tab === t ? 'var(--navy)' : 'var(--text-muted)',
              borderBottom: tab === t ? '2px solid var(--navy)' : '2px solid transparent',
            }}>
              {t === 'converter' ? 'Converter' : 'Manage Rates'}
            </button>
          ))}
        </div>

        <div className="modal-body" style={{ padding: '16px 20px' }}>
          {tab === 'converter' ? (
            <>
              <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
                <input type="number" className="form-control" value={amount}
                  onChange={e => setAmount(e.target.value)}
                  style={{ flex: 1, fontSize: 18, fontWeight: 700 }} placeholder="Amount" />
                <select className="form-control" value={base} onChange={e => setBase(e.target.value)} style={{ width: 100 }}>
                  {currencies.map(c => <option key={c}>{c}</option>)}
                </select>
              </div>
              <div style={{ borderRadius: 8, overflow: 'hidden', border: '1px solid var(--border-solid)' }}>
                {['SGD', ...FX_ORDER].filter(c => c !== base && (c === 'SGD' || c in rates)).map(c => {
                  const val = c === 'SGD' ? sgdAmount : sgdAmount * (rates[c] || 1)
                  return (
                    <div key={c} style={{ display: 'flex', alignItems: 'center', padding: '10px 14px', borderBottom: '1px solid var(--border)', background: 'var(--bg)' }}>
                      <span style={{ fontWeight: 700, fontSize: 13, width: 48, color: 'var(--heading)' }}>{c}</span>
                      <span style={{ flex: 1, fontSize: 18, fontWeight: 700 }}>
                        {val.toLocaleString('en-SG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </span>
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 1 }}>
                      <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>1 SGD = {Number(rates[c]).toFixed(4)} {c}</span>
                      <span style={{ fontSize: 10, color: 'var(--blue)', fontWeight: 600 }}>1 {c} = {(1 / (rates[c] || 1)).toFixed(4)} SGD</span>
                    </div>
                    </div>
                  )
                })}
              </div>
              <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text-muted)', textAlign: 'right' }}>{lastUpdatedLabel}</div>
            </>
          ) : (
            <>
              <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
                Edit either direction — they update each other automatically. Save to lock the rate; the daily sync won't overwrite locked rates.
              </p>
              <div style={{ borderRadius: 8, overflow: 'hidden', border: '1px solid var(--border-solid)', marginBottom: 14 }}>
                {FX_ORDER.filter(c => c in rates).map(c => (
                  <div key={c} style={{ borderBottom: '1px solid var(--border-solid)', background: '#ffffff' }}>
                    {/* Currency label + lock badge */}
                    <div style={{ display: 'flex', alignItems: 'center', padding: '8px 14px 4px', gap: 8 }}>
                      <span style={{ fontWeight: 800, fontSize: 13, color: 'var(--heading)', width: 36 }}>{c}</span>
                      <div style={{ marginLeft: 'auto' }}>
                        {isManual[c] ? (
                          <button onClick={() => handleUnlock(c)} disabled={unlocking[c]}
                            style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 5, cursor: 'pointer', background: '#FEF3C7', color: '#92400E', border: '1.5px solid #F59E0B', opacity: unlocking[c] ? 0.6 : 1 }}>
                            {unlocking[c] ? 'Fetching...' : 'Locked — Use live'}
                          </button>
                        ) : (
                          <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 5, background: '#F0FDF4', color: '#166534', border: '1.5px solid #86EFAC' }}>Auto</span>
                        )}
                      </div>
                    </div>
                    {/* Two-way rate inputs */}
                    <div style={{ display: 'flex', gap: 0, padding: '4px 14px 10px' }}>
                      {/* SGD → Foreign */}
                      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 3 }}>
                        <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>1 SGD =</span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                          <input type="text" inputMode="decimal"
                            style={{ width: '100%', padding: '5px 8px', fontSize: 13, fontWeight: 600, borderRadius: 5, border: '1.5px solid var(--border-solid)', textAlign: 'right', fontFamily: 'var(--font)' }}
                            value={draftRates[c] ?? ''}
                            onChange={e => onForwardChange(c, e.target.value)} />
                          <span style={{ fontSize: 11, color: 'var(--text-muted)', minWidth: 28 }}>{c}</span>
                        </div>
                      </div>
                      {/* Divider */}
                      <div style={{ display: 'flex', alignItems: 'center', padding: '0 10px', color: 'var(--text-muted)', paddingTop: 16 }}><ArrowRightLeft size={15} /></div>
                      {/* Foreign → SGD */}
                      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 3 }}>
                        <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--blue)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>1 {c} =</span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                          <input type="text" inputMode="decimal"
                            style={{ width: '100%', padding: '5px 8px', fontSize: 13, fontWeight: 600, borderRadius: 5, border: '1.5px solid #93C5FD', textAlign: 'right', fontFamily: 'var(--font)', background: '#EFF6FF' }}
                            value={draftInverse[c] ?? ''}
                            onChange={e => onInverseChange(c, e.target.value)} />
                          <span style={{ fontSize: 11, color: 'var(--text-muted)', minWidth: 28 }}>SGD</span>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              {saveError && <p style={{ color: '#DC2626', fontSize: 12, marginBottom: 8 }}>{saveError}</p>}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{lastUpdatedLabel}</span>
                <button className="btn btn-primary btn-sm" onClick={saveRates} disabled={saving}>
                  {saving ? 'Saving...' : saved ? <><Check size={13} /> Saved!</> : 'Save Rates'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function FxReminderBanner({ updatedAt, onOpenRates }) {
  const today = new Date()
  const day = today.getDate()
  const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate()
  const daysLeft = daysInMonth - day

  const isFirstOfMonth = day === 1
  const isMonthEnd = daysLeft <= 2

  if (!isFirstOfMonth && !isMonthEnd) return null

  const nextMonth = new Date(today.getFullYear(), today.getMonth() + 1, 1)
    .toLocaleString('en-SG', { month: 'long', year: 'numeric' })
  const lastSet = updatedAt ? new Date(updatedAt).toLocaleDateString('en-SG') : null
  const msg = isFirstOfMonth
    ? `New month — please update FX rates for ${nextMonth}.`
    : `${daysLeft === 0 ? 'Last day of month' : `${daysLeft} day${daysLeft > 1 ? 's' : ''} left`} — update FX rates for ${nextMonth} before month-end.`

  return (
    <div style={{
      background: '#FEF3C7', borderBottom: '1px solid #F59E0B',
      padding: '8px 20px', display: 'flex', alignItems: 'center', gap: 10, fontSize: 13,
    }}>
      <AlertTriangle size={15} />
      <span style={{ flex: 1, color: '#92400E', fontWeight: 500 }}>
        {msg}{lastSet ? ` Last set: ${lastSet}.` : ''}
      </span>
      <button className="btn btn-sm" onClick={onOpenRates}
        style={{ background: '#F59E0B', color: '#fff', border: 'none', fontWeight: 600, fontSize: 12 }}>
        Update Rates
      </button>
    </div>
  )
}

function Sidebar({ onCurrencyClick, onWhatsNewClick, onProfileClick, unreadCount, newLeadsCount, theme, onToggleTheme }) {
  const { user, signOut } = useAuth()

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <div style={{ width: '100%' }}>
          <img
            src="/logo-cropped.png"
            alt="Zhenghe Logistics"
            style={{ width: '100%', height: 'auto', display: 'block', marginBottom: 4 }}
          />
          <div className="sidebar-sub" style={{ paddingLeft: 2 }}>Motus</div>
        </div>
      </div>

      <div className="sidebar-section-label">Main Menu</div>

      <nav className="sidebar-nav">
        {NAV.map(({ to, icon: Icon, label, exact }) => (
          <NavLink
            key={to}
            to={to}
            end={exact}
            className={({ isActive }) => `sidebar-link${isActive ? ' active' : ''}`}
            style={{ position: 'relative' }}
          >
            <span className="sidebar-icon"><Icon size={17} strokeWidth={2} /></span>
            {label}
            {to === '/leads' && newLeadsCount > 0 && (
              <span style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', display: 'inline-block' }}>
                <span className="badge-ping" />
                <span style={{
                  position: 'relative', zIndex: 1, display: 'inline-block',
                  background: '#EF4444', color: 'white', borderRadius: 10,
                  fontSize: 10, fontWeight: 800, padding: '1px 6px', minWidth: 18, textAlign: 'center',
                  lineHeight: '16px',
                }}>
                  {newLeadsCount > 99 ? '99+' : newLeadsCount}
                </span>
              </span>
            )}
          </NavLink>
        ))}
      </nav>

      <div className="sidebar-bottom">
        <button
          className="sidebar-link"
          onClick={onWhatsNewClick}
          style={{ width: '100%', textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', marginBottom: 4, position: 'relative' }}
        >
          <span className="sidebar-icon"><Sparkles size={17} strokeWidth={2} /></span>
          What's New
          {unreadCount > 0 && (
            <span style={{
              position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
              background: '#EF4444', color: 'white', borderRadius: 10,
              fontSize: 10, fontWeight: 800, padding: '1px 6px', minWidth: 18, textAlign: 'center',
            }}>{unreadCount}</span>
          )}
        </button>

        <button
          className="sidebar-link"
          onClick={onCurrencyClick}
          style={{ width: '100%', textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', marginBottom: 4 }}
        >
          <span className="sidebar-icon"><DollarSign size={17} strokeWidth={2} /></span>
          Currency Converter
        </button>

        <button className="theme-toggle" onClick={onToggleTheme}>
          {theme === 'dark' ? <Sun size={16} strokeWidth={2} /> : <Moon size={16} strokeWidth={2} />}
          <span>{theme === 'dark' ? 'Light Mode' : 'Dark Mode'}</span>
        </button>

        {/* Logged-in user + account + sign out */}
        <div style={{ borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: 10, marginTop: 4 }}>
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', marginBottom: 6, paddingLeft: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {user?.email}
          </div>
          <button
            className="sidebar-link"
            onClick={onProfileClick}
            style={{ width: '100%', textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', marginBottom: 2 }}
          >
            <span className="sidebar-icon"><UserCircle size={17} strokeWidth={2} /></span>
            My Account
          </button>
          <button
            className="sidebar-link"
            onClick={signOut}
            style={{ width: '100%', textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(255,255,255,0.6)', fontSize: 13 }}
          >
            <span className="sidebar-icon" style={{ opacity: 0.6 }}><LogOut size={17} strokeWidth={2} /></span>
            Sign Out
          </button>
        </div>

        <div className="sidebar-version">Motus v1.0</div>
      </div>
    </aside>
  )
}

function HashErrorBanner() {
  const hash = window.location.hash
  if (!hash.includes('error=')) return null
  const params = new URLSearchParams(hash.replace('#', ''))
  const desc = params.get('error_description')?.replace(/\+/g, ' ') || 'Authentication error'
  const code = params.get('error_code')
  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'linear-gradient(135deg, #003087 0%, #006EFF 100%)',
    }}>
      <div style={{
        background: '#fff', borderRadius: 16, padding: '40px 36px', width: '100%', maxWidth: 380,
        boxShadow: '0 20px 60px rgba(0,0,0,0.25)', textAlign: 'center',
      }}>
        <div style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 56, height: 56, borderRadius: 14, background: '#003087',
          fontSize: 20, fontWeight: 900, color: '#fff', letterSpacing: '-1px', marginBottom: 16,
        }}>ZHL</div>
        <div style={{ display: 'flex', justifyContent: 'center', color: '#003087', marginBottom: 12 }}><AlertTriangle size={32} /></div>
        <div style={{ fontSize: 16, fontWeight: 800, color: '#003087', marginBottom: 8 }}>
          {code === 'otp_expired' ? 'Link expired' : 'Verification failed'}
        </div>
        <div style={{ fontSize: 13, color: '#6B7E93', marginBottom: 8, lineHeight: 1.6 }}>
          {code === 'otp_expired'
            ? 'This confirmation link has expired. Please sign up again to receive a new one.'
            : desc}
        </div>
        <button
          className="btn btn-primary"
          style={{ width: '100%', justifyContent: 'center', height: 44, marginTop: 12 }}
          onClick={() => { window.location.href = '/' }}
        >
          Back to Sign In
        </button>
      </div>
    </div>
  )
}

const LEADS_SEEN_KEY = (email) => `leads_seen_at_${email}`
const THEME_KEY = 'motus_theme'

function AppShell() {
  const { user, loading } = useAuth()
  const location = useLocation()
  const [showCurrency, setShowCurrency] = useState(false)
  const [showWhatsNew, setShowWhatsNew] = useState(false)
  const [showProfile, setShowProfile] = useState(false)
  const [fxUpdatedAt, setFxUpdatedAt] = useState(null)
  const [newLeadsCount, setNewLeadsCount] = useState(0)
  const [theme, setTheme] = useState(() => localStorage.getItem(THEME_KEY) || 'light')
  const seen = parseInt(localStorage.getItem(SEEN_KEY) || '0', 10)
  const unreadCount = Math.max(0, CHANGELOG.length - seen)

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem(THEME_KEY, theme)
  }, [theme])

  function toggleTheme() {
    setTheme(t => (t === 'dark' ? 'light' : 'dark'))
  }

  useEffect(() => {
    if (!user) return
    getFxRates().then(r => setFxUpdatedAt(r.data.updated_at)).catch(() => {})
  }, [user])

  // Fetch new leads count on mount and poll every 60s
  useEffect(() => {
    if (!user) return
    async function fetchCount() {
      try {
        const since = localStorage.getItem(LEADS_SEEN_KEY(user.email))
        const { data } = await getNewLeadsCount(since || undefined)
        setNewLeadsCount(data.count)
      } catch (_) {}
    }
    fetchCount()
    const interval = setInterval(fetchCount, 60000)
    return () => clearInterval(interval)
  }, [user])

  // Clear badge when user visits /leads
  useEffect(() => {
    if (location.pathname === '/leads' && user) {
      localStorage.setItem(LEADS_SEEN_KEY(user.email), new Date().toISOString())
      setNewLeadsCount(0)
    }
  }, [location.pathname, user])

  // Supabase redirects auth errors to root with #error=... hash fragments
  if (window.location.hash.includes('error=')) return <HashErrorBanner />

  // Auth callback must be accessible without a session
  if (window.location.pathname === '/auth/callback') return <AuthCallback />
  // Must come before the signed-in gate below: a recovery link already establishes a
  // session, so without this the user is considered logged in and never gets asked to
  // choose a new password.
  if (window.location.pathname === '/auth/reset') return <ResetPassword />

  // Show nothing while we check if the user is already logged in
  if (loading) return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#003087' }}>
      <span className="spinner" style={{ width: 32, height: 32, borderColor: 'rgba(255,255,255,0.3)', borderTopColor: '#fff' }}></span>
    </div>
  )

  // Not logged in → show login page
  if (!user) return <Login />

  // Logged in → show the app
  return (
    <div className="app-layout">
      <Sidebar
        onCurrencyClick={() => setShowCurrency(true)}
        onWhatsNewClick={() => setShowWhatsNew(true)}
        onProfileClick={() => setShowProfile(true)}
        unreadCount={unreadCount}
        newLeadsCount={newLeadsCount}
        theme={theme}
        onToggleTheme={toggleTheme}
      />
      <main className="main-content">
        <FxReminderBanner updatedAt={fxUpdatedAt} onOpenRates={() => setShowCurrency(true)} />
        <div key={location.pathname} className="page-enter">
          <Suspense fallback={
            <div style={{ padding: 60, textAlign: 'center' }}>
              <span className="spinner spinner-dark" style={{ width: 28, height: 28 }}></span>
            </div>
          }>
          <Routes>
            <Route path="/"         element={<Dashboard />} />
            <Route path="/jobs"     element={<MovementTracker />} />
            <Route path="/jobs/:id" element={<JobDetail />} />
            <Route path="/intake"   element={<EmailIntake />} />
            <Route path="/stats"    element={<CompanyStats />} />
            <Route path="/quote"    element={<QuoteCalculator />} />
            <Route path="/leads"    element={<Leads />} />
            <Route path="/rates"    element={<RateCards />} />
            <Route path="/auth/callback" element={<AuthCallback />} />
            <Route path="/auth/reset"    element={<ResetPassword />} />
          </Routes>
          </Suspense>
        </div>
      </main>
      {showCurrency && <CurrencyConverter onClose={() => setShowCurrency(false)} onRatesSaved={rates => { setFxUpdatedAt(new Date().toISOString()) }} />}
      {showWhatsNew && <WhatsNewModal onClose={() => setShowWhatsNew(false)} />}
      {showProfile && (
        <Suspense fallback={null}>
          <ProfileModal onClose={() => setShowProfile(false)} />
        </Suspense>
      )}
    </div>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppShell />
      </AuthProvider>
    </BrowserRouter>
  )
}
