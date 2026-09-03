import { useI18n } from '../lib/i18n'
import { LOCALES, type Locale } from '../lib/i18n-config'

export function LanguageSelector() {
  const { locale, setLocale } = useI18n()
  return (
    <select
      className="mox-langselect"
      value={locale}
      onChange={(e) => setLocale(e.target.value as Locale)}
      aria-label="Language"
      title="Language"
    >
      {LOCALES.map((l) => (
        <option key={l.id} value={l.id}>{l.id.toUpperCase()}</option>
      ))}
    </select>
  )
}
