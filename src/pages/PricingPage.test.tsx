import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import PricingPage from './PricingPage'

vi.mock('../lib/useAuth', () => ({
  useAuth: () => ({ status: 'anonymous', authenticatedFetch: vi.fn() }),
}))

describe('Preview-safe pricing claims', () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllEnvs()
  })

  it('labels enabled billing as test mode and offers only the implemented Pro limit', () => {
    vi.stubEnv('VITE_ENABLE_BILLING', 'true')

    render(<MemoryRouter><PricingPage /></MemoryRouter>)

    expect(screen.getByText(/No real payment is collected in this Preview/i)).toBeInTheDocument()
    expect(screen.getByText('Up to 100 saved decks (20 versions each)')).toBeInTheDocument()
    expect(screen.queryByText('AI explanations for deterministic tuner swaps (monthly quota)')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign in to subscribe' })).toBeInTheDocument()
  })

  it('keeps checkout closed and future capabilities labelled as planned while billing is off', () => {
    vi.stubEnv('VITE_ENABLE_BILLING', '')

    render(<MemoryRouter><PricingPage /></MemoryRouter>)

    expect(screen.getByRole('heading', { name: 'Start free. Pro is not for sale yet.' })).toBeInTheDocument()
    expect(screen.getByText('AI explanations for deterministic tuner swaps (monthly quota)')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Coming soon' })).toBeDisabled()
  })
})
