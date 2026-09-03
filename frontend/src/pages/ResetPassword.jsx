import { useState } from 'react'
import { CheckCircle } from 'lucide-react'
import { useAuth } from '../lib/AuthContext'

// Dedicated landing page for a password-recovery link.
//
// This has its own route rather than sharing /auth/callback and working out which kind
// of link arrived. Detection was unreliable: the Supabase client is constructed at
// module load with detectSessionInUrl, which consumes and clears the URL fragment
// before any component mounts, and the PASSWORD_RECOVERY event fires during that same
// construction — before a component could subscribe to hear it. Both signals were gone
// by the time anything could read them, so recovery links fell through to the ordinary
// redirect and dropped the user into the app with their old password still set.
//
// A distinct URL removes the guesswork entirely: arriving here means recovery.
export default function ResetPassword() {
  const { setNewPassword, signOut } = useAuth()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [done, setDone] = useState(false)

  async function submit(e) {
    e.preventDefault()
    setError('')
    if (password.length < 8) return setError('Password must be at least 8 characters.')
    if (password !== confirm) return setError('Passwords do not match.')

    setSaving(true)
    try {
      await setNewPassword(password)

      // Sign out and send them back to the login screen rather than dropping them
      // straight into the app. The recovery link left a session in place, so staying
      // signed in would mean nobody ever types the new password and nobody finds out
      // until the next login whether it took. Ending here proves it works, and proves
      // the old one no longer does.
      await signOut()
      setDone(true)
      // Full reload rather than a route change, so no recovery session or stale auth
      // state survives into the fresh login.
      setTimeout(() => { window.location.href = '/' }, 1800)
    } catch (err) {
      // The usual cause is an expired or already-used link, so say that rather than
      // showing a raw provider message.
      setError(err.message?.includes('session')
        ? 'This link has expired or has already been used. Request a new one from the sign-in page.'
        : (err.message || 'Could not set your password. Please request a new link.'))
      setSaving(false)
    }
  }

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'linear-gradient(135deg, var(--navy) 0%, var(--blue) 100%)',
    }}>
      <div style={{
        background: '#fff', borderRadius: 16, padding: '40px 36px', width: '100%', maxWidth: 380,
        boxShadow: '0 20px 60px rgba(0,0,0,0.25)',
      }}>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <div style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 56, height: 56, borderRadius: 14, background: 'var(--navy)',
            fontSize: 20, fontWeight: 900, color: '#fff', letterSpacing: '-1px', marginBottom: 12,
          }}>ZHL</div>
          {done ? (
            <>
              <div style={{ marginBottom: 12 }}><CheckCircle size={40} color="var(--green)" /></div>
              <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--heading)', marginBottom: 6 }}>Password updated</div>
              <div style={{ fontSize: 13, color: '#6B7E93', lineHeight: 1.6 }}>
                Your old password no longer works.<br />Taking you to the sign-in screen…
              </div>
            </>
          ) : (
            <>
              <div style={{ fontSize: 17, fontWeight: 800, color: 'var(--heading)' }}>Choose a new password</div>
              <div style={{ fontSize: 12.5, color: '#6B7E93', marginTop: 4 }}>You&apos;ll be signed in straight after.</div>
            </>
          )}
        </div>

        {!done && (
          <form onSubmit={submit}>
            <div className="form-group" style={{ marginBottom: 14 }}>
              <label className="form-label">New password</label>
              <input type="password" className="form-control" placeholder="At least 8 characters" autoFocus
                value={password} onChange={e => setPassword(e.target.value)} required />
            </div>
            <div className="form-group" style={{ marginBottom: 20 }}>
              <label className="form-label">Confirm password</label>
              <input type="password" className="form-control" placeholder="••••••••"
                value={confirm} onChange={e => setConfirm(e.target.value)} required />
            </div>

            {error && (
              <div style={{
                background: '#FEF2F2', border: '1px solid #FECACA', color: '#991B1B',
                borderRadius: 8, padding: '10px 14px', fontSize: 13, marginBottom: 16,
              }}>{error}</div>
            )}

            <button type="submit" className="btn btn-primary" disabled={saving}
              style={{ width: '100%', justifyContent: 'center', height: 44, fontSize: 15, fontWeight: 700 }}>
              {saving ? <><span className="spinner"></span> Saving…</> : 'Set Password'}
            </button>

            <div style={{ textAlign: 'center', marginTop: 16 }}>
              <a href="/" style={{ fontSize: 12.5, color: 'var(--blue)', fontWeight: 600 }}>Back to sign in</a>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
