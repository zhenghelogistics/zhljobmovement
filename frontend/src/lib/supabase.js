import { createClient } from '@supabase/supabase-js'

// Captured at module load, BEFORE createClient runs.
//
// Supabase only honours a redirectTo that appears in its Redirect URLs allowlist. When
// it does not, it silently falls back to the project's Site URL — so a recovery link
// lands on the app homepage instead of the reset page, and the user is never asked for
// a new password. This flag lets the app recognise that case and route itself.
//
// It has to be read here because createClient with detectSessionInUrl consumes and
// clears the fragment during construction; anything reading window.location.hash later
// finds nothing.
const initialUrl = typeof window !== 'undefined' ? window.location.hash + window.location.search : ''
export const arrivedViaRecoveryLink = /type=recovery/.test(initialUrl)

// Whether the session should outlive the browser being closed.
//
// Supabase already persists to localStorage by default, so staying signed in was
// always the behaviour — it just wasn't visible or controllable. This makes it an
// explicit choice, and lets someone on a shared machine opt out.
const REMEMBER_KEY = 'motus_remember_me'

export const isRemembered = () => localStorage.getItem(REMEMBER_KEY) !== 'false'
export const setRemembered = (on) => localStorage.setItem(REMEMBER_KEY, on ? 'true' : 'false')

// Routes each read/write to localStorage or sessionStorage based on the preference at
// the time of the call. Deciding once at module load would be wrong: the user ticks the
// box and signs in within the same page life, and the client is already constructed by
// then. Reading the flag per operation means the choice applies immediately.
//
// Every accessor is guarded because storage throws outright in some contexts — a
// private window with site data blocked, or an embedded browser — and an exception here
// would take down sign-in entirely rather than merely forgetting a preference.
const store = () => (isRemembered() ? window.localStorage : window.sessionStorage)

const switchableStorage = {
  getItem: (key) => {
    try { return store().getItem(key) } catch { return null }
  },
  setItem: (key, value) => {
    try { store().setItem(key, value) } catch { /* session simply won't persist */ }
  },
  removeItem: (key) => {
    // Clear both, so toggling the preference can never strand a stale session in the
    // store that is no longer being read.
    try { window.localStorage.removeItem(key) } catch { /* ignore */ }
    try { window.sessionStorage.removeItem(key) } catch { /* ignore */ }
  },
}

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
  {
    auth: {
      storage: switchableStorage,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  }
)
