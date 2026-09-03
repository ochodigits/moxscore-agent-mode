type ServerEnv = Record<string, string | undefined>

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function present(value: string | undefined): boolean {
  return (value?.trim().length ?? 0) > 0
}

function validRetention(value: string | undefined): boolean {
  if (!value || !/^\d{1,4}$/.test(value)) return false
  const days = Number(value)
  return Number.isInteger(days) && days >= 1 && days <= 3650
}

/**
 * Defense in depth for anonymous writes. The public legal values are expected
 * to be visible in the built policy, so requiring them server-side prevents a
 * flag-only environment change from releasing Share with placeholder copy.
 */
export function sharingWritesEnabled(env: ServerEnv = process.env): boolean {
  return env.MOXSCORE_ENABLE_SHARING === 'true' &&
    env.VITE_ENABLE_SHARING === 'true' &&
    present(env.VITE_LEGAL_CONTROLLER_NAME) &&
    EMAIL_RE.test(env.VITE_PRIVACY_CONTACT_EMAIL?.trim() ?? '') &&
    validRetention(env.VITE_SHARED_DECK_RETENTION_DAYS)
}
