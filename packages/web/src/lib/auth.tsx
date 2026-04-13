import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { supabase } from './supabase'
import type { Session, User } from '@supabase/supabase-js'

interface AuthCtx {
  session: Session | null
  user: User | null
  loading: boolean
  signIn: (email: string, password: string) => Promise<string | null>
  signUp: (email: string, password: string, meta?: Record<string, string>) => Promise<string | null>
  signOut: () => Promise<void>
}

const Ctx = createContext<AuthCtx>({} as AuthCtx)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setLoading(false) })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => subscription.unsubscribe()
  }, [])

  return (
    <Ctx.Provider value={{
      session, user: session?.user || null, loading,
      signIn: async (e, p) => { const { error } = await supabase.auth.signInWithPassword({ email: e, password: p }); return error?.message || null },
      signUp: async (e, p, m) => { const { error } = await supabase.auth.signUp({ email: e, password: p, options: { data: m } }); return error?.message || null },
      signOut: async () => { await supabase.auth.signOut() },
    }}>
      {children}
    </Ctx.Provider>
  )
}

export const useAuth = () => useContext(Ctx)
