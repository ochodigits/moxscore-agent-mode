import { createContext } from 'react'
import type { User } from '@supabase/supabase-js'

export type AuthStatus = 'unavailable' | 'loading' | 'anonymous' | 'authenticated'

export interface AuthContextValue {
  status: AuthStatus
  user: User | null
  sendMagicLink(email: string): Promise<void>
  signOut(): Promise<void>
  authenticatedFetch(input: string, init?: RequestInit): Promise<Response>
}

export const AuthContext = createContext<AuthContextValue | null>(null)
