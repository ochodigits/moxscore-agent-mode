import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import PrivacyPage from './PrivacyPage'
import TermsPage from './TermsPage'

describe('billing legal disclosures', () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllEnvs()
  })

  it('discloses Stripe processing and retained billing metadata when Preview billing is enabled', () => {
    vi.stubEnv('VITE_ENABLE_BILLING', 'true')

    render(<MemoryRouter><PrivacyPage /></MemoryRouter>)

    expect(screen.getByText(/test-mode Pro subscription/i)).toBeInTheDocument()
    expect(screen.getByText(/Payment-card and bank details are collected by Stripe/i)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Privacy Policy' })).toHaveAttribute('href', 'https://stripe.com/privacy')
    expect(screen.getByText(/first deletes the linked Stripe test customer/i)).toBeInTheDocument()
    expect(screen.getByText(/live billing remains closed/i)).toBeInTheDocument()
  })

  it('discloses renewal, cancellation, refunds, and current Pro scope when Preview billing is enabled', () => {
    vi.stubEnv('VITE_ENABLE_BILLING', 'true')

    render(<MemoryRouter><TermsPage /></MemoryRouter>)

    expect(screen.getByRole('heading', { name: 'Pro test-mode exercise' })).toBeInTheDocument()
    expect(screen.getByText(/monthly and annual price hypotheses/i)).toBeInTheDocument()
    expect(screen.getByText(/can renew/i)).toBeInTheDocument()
    expect(screen.getByText(/not final public cancellation, withdrawal, refund, dispute, dunning, tax, or invoicing terms/i)).toBeInTheDocument()
    expect(screen.getByText(/Live billing remains closed/i)).toBeInTheDocument()
    expect(screen.getByText(/Planned AI, advanced Pod Check, and Discord features are not included/i)).toBeInTheDocument()
  })

  it('keeps payment disclosures and subscription terms hidden while billing is off', () => {
    vi.stubEnv('VITE_ENABLE_BILLING', '')

    const privacy = render(<MemoryRouter><PrivacyPage /></MemoryRouter>)
    expect(screen.getByText(/does not require an account, collect payment/i)).toBeInTheDocument()
    expect(screen.queryByText(/hosts Checkout and the Customer Portal/i)).not.toBeInTheDocument()
    privacy.unmount()

    render(<MemoryRouter><TermsPage /></MemoryRouter>)
    expect(screen.queryByRole('heading', { name: 'Pro test-mode exercise' })).not.toBeInTheDocument()
  })
})
