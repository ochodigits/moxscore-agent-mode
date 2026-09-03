export type Locale = 'en'

export const LOCALES: { id: Locale; label: string }[] = [
  { id: 'en', label: 'English' },
]

/** Scryfall `lang:` code for the active UI locale. */
export function scryfallLang(locale: Locale): string {
  return locale
}
