import { createContext, useContext, useEffect, useState } from 'react'
import { supabase } from './supabase'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // Supabase reports the session several times during a normal page load
    // (getSession resolves, then onAuthStateChange fires INITIAL_SESSION, and again
    // on any token refresh). Each report is a fresh object, so calling setUser every
    // time handed every `useEffect(..., [user])` in the app a new identity and made
    // it re-run — the dashboard was firing the same fx-rates and leads-count requests
    // three times per load. Only replace the object when it's genuinely a different
    // person signing in or out.
    //
    // Safe to hold onto the old object across a token refresh: the access token lives
    // on the session, not on user, and api.js reads it from supabase.auth.getSession()
    // at request time rather than from here.
    const apply = (session) => {
      const next = session?.user ?? null
      setUser(prev => (prev?.id === next?.id ? prev : next))
    }

    // Check if there's already a session when the app loads
    supabase.auth.getSession().then(({ data: { session } }) => {
      apply(session)
      setLoading(false)
    })

    // Listen for login / logout events
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      apply(session)
    })

    return () => subscription.unsubscribe()
  }, [])

  async function signIn(email, password) {
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) throw error
  }

  async function signUp(email, password) {
    if (!email.toLowerCase().endsWith('@zhenghe.com.sg')) {
      throw new Error('Only @zhenghe.com.sg email addresses are allowed')
    }
    const { error } = await supabase.auth.signUp({ email, password })
    if (error) throw error
  }

  async function signOut() {
    await supabase.auth.signOut()
  }

  // Sends the reset email. Supabase deliberately returns success whether or not the
  // address exists, so this never reveals who has an account — and we surface the same
  // wording either way rather than leaking that distinction ourselves.
  async function requestPasswordReset(email) {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/callback`,
    })
    if (error) throw error
  }

  // Used after arriving back from the emailed link, at which point Supabase has already
  // put a recovery session in place, so updateUser is authorised.
  async function setNewPassword(password) {
    const { error } = await supabase.auth.updateUser({ password })
    if (error) throw error
  }

  return (
    <AuthContext.Provider value={{ user, loading, signIn, signUp, signOut, requestPasswordReset, setNewPassword }}>
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => useContext(AuthContext)
