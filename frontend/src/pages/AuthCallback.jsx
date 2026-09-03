import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { CheckCircle } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/AuthContext'

// Landing page for every emailed link: signup confirmation and password recovery both
// come back here.
//
// Recovery needs distinguishing from confirmation. A recovery link signs the user in
// with a temporary session, so simply redirecting them into the app — which is what
// this page used to do for everything — would leave the forgotten password still set
// and lock them out again next time. When it's a recovery we hold them here to choose
// a new one.
export default function AuthCallback() {
  const navigate = useNavigate()
  const { setNewPassword } = useAuth()
  const [error, setError] = useState('')
  const [recovery, setRecovery] = useState(
    // Supabase puts the flow type in the URL fragment. Read it synchronously so the
    // recovery form renders immediately rather than flashing the redirect first.
    () => /type=recovery/.test(window.location.hash)
  )
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [saving, setSaving] = useState(false)
  const [done, setDone] = useState(false)

  useEffect(() => {
    if (recovery) return   // hold here; the form drives what happens next

    supabase.auth.getSession().then(({ data: { session }, error }) => {
      if (error) setError(error.message)
      else if (session) navigate('/', { replace: true })
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      // Fires when the emailed link is a recovery one and the fragment check missed it.
      if (event === 'PASSWORD_RECOVERY') { setRecovery(true); return }
      if (event === 'SIGNED_IN' && session) navigate('/', { replace: true })
    })
    return () => subscription.unsubscribe()
  }, [navigate, recovery])

  async function submit(e) {
    e.preventDefault()
    setError('')
    if (password.length < 8) return setError('Password must be at least 8 characters.')
    if (password !== confirm) return setError('Passwords do not match.')

    setSaving(true)
    try {
      await setNewPassword(password)
      setDone(true)
      // Brief pause so the confirmation is actually readable before the app appears.
      setTimeout(() => navigate('/', { replace: true }), 1600)
    } catch (err) {
      setError(err.message || 'Could not set your password. The link may have expired — request a new one.')
      setSaving(false)
    }
  }

  const shell = (children) => (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'linear-gradient(135deg, var(--navy) 0%, var(--blue) 100%)',
    }}>
      <div style={{
        background: '#fff', borderRadius: 16, padding: '40px 36px', width: '100%', maxWidth: 380,
        boxShadow: '0 20px 60px rgba(0,0,0,0.25)', textAlign: 'center',
      }}>
        <div style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 56, height: 56, borderRadius: 14, background: 'var(--navy)',
          fontSize: 20, fontWeight: 900, color: '#fff', letterSpacing: '-1px', marginBottom: 16,
        }}>ZHL</div>
        {children}
      </div>
    </div>
  )

  if (done) return shell(
    <>
      <div style={{ marginBottom: 14 }}><CheckCircle size={40} color="var(--green)" /></div>
      <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--heading)', marginBottom: 6 }}>Password updated</div>
      <div style={{ fontSize: 13, color: '#6B7E93' }}>Signing you in…</div>
    </>
  )

  if (recovery) return shell(
    <form onSubmit={submit} style={{ textAlign: 'left' }}>
      <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--heading)', marginBottom: 6, textAlign: 'center' }}>
        Choose a new password
      </div>
      <div style={{ fontSize: 12.5, color: '#6B7E93', marginBottom: 20, textAlign: 'center', lineHeight: 1.6 }}>
        You&apos;ll be signed in straight after.
      </div>

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
    </form>
  )

  if (error) return shell(
    <>
      <div style={{ fontSize: 16, fontWeight: 800, color: '#991B1B', marginBottom: 8 }}>Link could not be verified</div>
      <div style={{ fontSize: 13, color: '#6B7E93', marginBottom: 20 }}>{error}</div>
      <a href="/" style={{ fontSize: 13, color: 'var(--navy)', fontWeight: 700 }}>Back to sign in</a>
    </>
  )

  return shell(
    <>
      <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'center' }}>
        <span className="spinner" style={{ width: 28, height: 28, borderColor: 'rgba(0,48,135,0.2)', borderTopColor: 'var(--navy)' }}></span>
      </div>
      <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--heading)', marginBottom: 6 }}>Verifying…</div>
      <div style={{ fontSize: 13, color: '#6B7E93' }}>You&apos;ll be signed in automatically.</div>
    </>
  )
}
