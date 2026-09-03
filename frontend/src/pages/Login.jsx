import { useState } from 'react'
import { CheckCircle, MailCheck } from 'lucide-react'
import { useAuth } from '../lib/AuthContext'
import { isRemembered, setRemembered } from '../lib/supabase'

const ALLOWED_DOMAIN = '@zhenghe.com.sg'

export default function Login() {
  const { signIn, signUp, requestPasswordReset } = useAuth()
  // 'login' | 'signup' | 'success' | 'forgot' | 'sent'
  const [mode, setMode] = useState('login')
  const [remember, setRemember] = useState(isRemembered())
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  function switchMode(m) {
    setMode(m)
    setError('')
    setPassword('')
    setConfirm('')
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')

    if (mode === 'forgot') {
      setLoading(true)
      try {
        await requestPasswordReset(email)
        setMode('sent')
      } catch (err) {
        setError(err.message || 'Could not send the reset email. Please try again.')
      } finally {
        setLoading(false)
      }
      return
    }

    if (mode === 'signup') {
      if (!email.toLowerCase().endsWith(ALLOWED_DOMAIN)) {
        return setError(`Only ${ALLOWED_DOMAIN} email addresses can create an account.`)
      }
      if (password.length < 8) {
        return setError('Password must be at least 8 characters.')
      }
      if (password !== confirm) {
        return setError('Passwords do not match.')
      }
    }

    setLoading(true)
    try {
      if (mode === 'login') {
        // Set before signing in: the storage adapter reads this flag when Supabase
        // writes the new session, so the choice has to be in place first.
        setRemembered(remember)
        await signIn(email, password)
      } else {
        await signUp(email, password)
        setMode('success')
      }
    } catch (err) {
      setError(err.message || 'Something went wrong. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'linear-gradient(135deg, var(--navy) 0%, var(--blue) 100%)',
    }}>
      <div style={{
        background: '#fff', borderRadius: 16, padding: '40px 36px', width: '100%', maxWidth: 400,
        boxShadow: '0 20px 60px rgba(0,0,0,0.25)',
      }}>

        {/* Logo */}
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <div style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 56, height: 56, borderRadius: 14, background: 'var(--navy)',
            fontSize: 20, fontWeight: 900, color: '#fff', letterSpacing: '-1px', marginBottom: 12,
          }}>ZHL</div>
          <div style={{ fontSize: 18, fontWeight: 800, color: 'var(--heading)' }}>Zhenghe Logistics</div>
          <div style={{ fontSize: 12, color: '#6B7E93', marginTop: 2 }}>Operations Portal</div>
        </div>

        {/* Tab toggle */}
        {!['success', 'forgot', 'sent'].includes(mode) && (
          <div style={{
            display: 'flex', background: '#F1F4F7', borderRadius: 10, padding: 3, marginBottom: 24,
          }}>
            {['login', 'signup'].map(m => (
              <button key={m} onClick={() => switchMode(m)} style={{
                flex: 1, padding: '8px 0', borderRadius: 8, border: 'none', cursor: 'pointer',
                fontWeight: 700, fontSize: 13, fontFamily: 'var(--font)',
                background: mode === m ? '#fff' : 'transparent',
                color: mode === m ? 'var(--navy)' : '#6B7E93',
                boxShadow: mode === m ? '0 1px 4px rgba(0,0,0,0.12)' : 'none',
                transition: 'all 0.15s',
              }}>
                {m === 'login' ? 'Sign In' : 'Create Account'}
              </button>
            ))}
          </div>
        )}

        {/* Reset email sent */}
        {mode === 'sent' ? (
          <div style={{ textAlign: 'center', padding: '12px 0 8px' }}>
            <div style={{ marginBottom: 16 }}><MailCheck size={40} color="var(--green)" /></div>
            <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--heading)', marginBottom: 8 }}>
              Check your email
            </div>
            <div style={{ fontSize: 13, color: '#6B7E93', marginBottom: 20, lineHeight: 1.6 }}>
              If <strong>{email}</strong> has an account, a reset link is on its way. The link
              works once and expires after an hour.
            </div>
            <div style={{ fontSize: 12, color: '#9CA3AF', marginBottom: 20, lineHeight: 1.6 }}>
              Nothing after a few minutes? Check spam. Repeated requests in quick succession
              may be held back by the mail provider — wait a while before trying again.
            </div>
            <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center', height: 44 }}
              onClick={() => switchMode('login')}>
              Back to Sign In
            </button>
          </div>
        ) : mode === 'success' ? (
          <div style={{ textAlign: 'center', padding: '12px 0 8px' }}>
            <div style={{ marginBottom: 16 }}><CheckCircle size={40} color="var(--green)" /></div>
            <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--heading)', marginBottom: 8 }}>
              Account created!
            </div>
            <div style={{ fontSize: 13, color: '#6B7E93', marginBottom: 24, lineHeight: 1.6 }}>
              Check your email <strong>{email}</strong> for a confirmation link, then come back and sign in.
            </div>
            <button
              className="btn btn-primary"
              style={{ width: '100%', justifyContent: 'center', height: 44 }}
              onClick={() => switchMode('login')}
            >
              Back to Sign In
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            <div className="form-group" style={{ marginBottom: 14 }}>
              <label className="form-label">Email</label>
              <input
                type="email"
                className="form-control"
                placeholder={`you${ALLOWED_DOMAIN}`}
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
                autoFocus
              />
              {mode === 'signup' && (
                <div style={{ fontSize: 11, color: '#9CA3AF', marginTop: 4 }}>
                  Must be a {ALLOWED_DOMAIN} address
                </div>
              )}
            </div>

            {mode === 'forgot' && (
              <div style={{ fontSize: 12.5, color: '#6B7E93', lineHeight: 1.6, marginBottom: 16, marginTop: -4 }}>
                Enter your work email and we&apos;ll send you a link to set a new password.
              </div>
            )}

            <div className="form-group" style={{ marginBottom: mode === 'signup' ? 14 : 24, display: mode === 'forgot' ? 'none' : undefined }}>
              <label className="form-label">Password</label>
              <input
                type="password"
                className="form-control"
                placeholder={mode === 'signup' ? 'At least 8 characters' : '••••••••'}
                value={password}
                onChange={e => setPassword(e.target.value)}
                required={mode !== 'forgot'}
              />
            </div>

            {mode === 'signup' && (
              <div className="form-group" style={{ marginBottom: 24 }}>
                <label className="form-label">Confirm Password</label>
                <input
                  type="password"
                  className="form-control"
                  placeholder="••••••••"
                  value={confirm}
                  onChange={e => setConfirm(e.target.value)}
                  required
                />
              </div>
            )}

            {mode === 'login' && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, marginTop: -8 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, color: '#4A5568', cursor: 'pointer' }}>
                  <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />
                  Keep me signed in
                </label>
                <button type="button" onClick={() => switchMode('forgot')} style={{
                  background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                  fontSize: 12.5, color: 'var(--blue)', fontWeight: 600, fontFamily: 'var(--font)',
                }}>
                  Forgot password?
                </button>
              </div>
            )}

            {error && (
              <div style={{
                background: '#FEF2F2', border: '1px solid #FECACA', color: '#991B1B',
                borderRadius: 8, padding: '10px 14px', fontSize: 13, marginBottom: 16,
              }}>
                {error}
              </div>
            )}

            <button
              type="submit"
              className="btn btn-primary"
              style={{ width: '100%', justifyContent: 'center', height: 44, fontSize: 15, fontWeight: 700 }}
              disabled={loading}
            >
              {loading
                ? <><span className="spinner"></span> {
                    mode === 'login' ? 'Signing in...' : mode === 'forgot' ? 'Sending...' : 'Creating account...'
                  }</>
                : mode === 'login' ? 'Sign In' : mode === 'forgot' ? 'Send Reset Link' : 'Create Account'
              }
            </button>
          </form>
        )}

        {mode === 'forgot' && (
          <div style={{ textAlign: 'center', marginTop: 16 }}>
            <button type="button" onClick={() => switchMode('login')} style={{
              background: 'none', border: 'none', padding: 0, cursor: 'pointer',
              fontSize: 12.5, color: 'var(--blue)', fontWeight: 600, fontFamily: 'var(--font)',
            }}>
              Back to Sign In
            </button>
          </div>
        )}

        <div style={{ textAlign: 'center', marginTop: 20, fontSize: 11, color: '#9CA3AF' }}>
          Access restricted to authorised ZHL staff only.
        </div>
      </div>
    </div>
  )
}
