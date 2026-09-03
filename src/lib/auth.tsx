import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { User } from '@supabase/supabase-js'
import { accountsUiEnabled, getSupabaseClient } from './supabaseClient'
import { AuthContext, type AuthContextValue, type AuthStatus } from './authContext'

function redirectUrl(): string | undefined {
  return typeof window === 'undefined' ? undefined : `${window.location.origin}/auth/callback`
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const accountsEnabled = accountsUiEnabled()
  const [status, setStatus] = useState<AuthStatus>(accountsEnabled ? 'loading' : 'unavailable')
  const [user, setUser] = useState<User | null>(null)

  useEffect(() => {
    let active = true
    let unsubscribe: (() => void) | undefined

    void getSupabaseClient().then((supabase) => {
      if (!active) return
      if (!supabase) {
        setStatus('unavailable')
        return
      }

      void supabase.auth.getSession().then(({ data, error }) => {
        if (!active) return
        if (error) {
          setUser(null)
          setStatus('anonymous')
          return
        }
        setUser(data.session?.user ?? null)
        setStatus(data.session?.user ? 'authenticated' : 'anonymous')
      })

      const { data } = supabase.auth.onAuthStateChange((_event, session) => {
        if (!active) return
        setUser(session?.user ?? null)
        setStatus(session?.user ? 'authenticated' : 'anonymous')
      })
      unsubscribe = () => data.subscription.unsubscribe()
    })

    return () => {
      active = false
      unsubscribe?.()
    }
  }, [])

  const value = useMemo<AuthContextValue>(() => ({
    status,
    user,
    async sendMagicLink(email: string) {
      const supabase = await getSupabaseClient()
      if (!supabase) throw new Error('Accounts are not enabled in this environment.')
      const { error } = await supabase.auth.signInWithOtp({
        email: email.trim(),
        options: { emailRedirectTo: redirectUrl() },
      })
      if (error) throw error
    },
    async signOut() {
      const supabase = await getSupabaseClient()
      if (!supabase) return
      const { error } = await supabase.auth.signOut()
      if (error) throw error
    },
    async authenticatedFetch(input: string, init: RequestInit = {}) {
      if (!input.startsWith('/')) throw new Error('Account requests must use a same-origin path.')
      const supabase = await getSupabaseClient()
      if (!supabase) throw new Error('Accounts are not enabled in this environment.')
      const { data, error } = await supabase.auth.getSession()
      if (error || !data.session?.access_token) throw new Error('Your session has expired. Sign in again.')
      const headers = new Headers(init.headers)
      headers.set('Authorization', `Bearer ${data.session.access_token}`)
      return fetch(input, { ...init, headers })
    },
  }), [status, user])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
