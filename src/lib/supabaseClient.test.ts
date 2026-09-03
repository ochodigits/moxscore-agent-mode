import { describe, expect, it } from 'vitest'
import { collectionsUiEnabled, persistenceUiEnabled, publicAuthConfig } from './supabaseClient'

describe('public Auth configuration', () => {
  it('keeps optional accounts unavailable without the explicit UI flag and both public credentials', () => {
    expect(publicAuthConfig({
      VITE_SUPABASE_URL: 'https://example.supabase.co',
      VITE_SUPABASE_ANON_KEY: 'public-key',
    }).enabled).toBe(false)
    expect(publicAuthConfig({ VITE_ENABLE_ACCOUNTS: 'true' }).enabled).toBe(false)
  })

  it('accepts only an explicit complete public configuration', () => {
    expect(publicAuthConfig({
      VITE_ENABLE_ACCOUNTS: 'true',
      VITE_SUPABASE_URL: 'https://example.supabase.co',
      VITE_SUPABASE_ANON_KEY: 'public-key',
    })).toEqual({
      enabled: true,
      url: 'https://example.supabase.co',
      anonKey: 'public-key',
    })
  })

  it('requires a separately explicit persistence UI flag', () => {
    const configured = {
      VITE_ENABLE_ACCOUNTS: 'true',
      VITE_SUPABASE_URL: 'https://example.supabase.co',
      VITE_SUPABASE_ANON_KEY: 'public-key',
    }
    expect(persistenceUiEnabled(configured)).toBe(false)
    expect(persistenceUiEnabled({ ...configured, VITE_ENABLE_PERSISTENCE: 'true' })).toBe(true)
    expect(collectionsUiEnabled({ ...configured, VITE_ENABLE_PERSISTENCE: 'true' })).toBe(false)
    expect(collectionsUiEnabled({ ...configured, VITE_ENABLE_PERSISTENCE: 'true', VITE_ENABLE_COLLECTIONS: 'true' })).toBe(true)
  })
})
