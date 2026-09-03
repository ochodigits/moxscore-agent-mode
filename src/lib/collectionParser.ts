export const MAX_COLLECTION_BYTES = 1_000_000
export const MAX_COLLECTION_ROWS = 10_000

export interface CollectionCardInput {
  name: string
  quantity: number
}

export interface CollectionRowError {
  row: number
  message: string
}

export interface CollectionParseResult {
  source: 'manabox-csv' | 'generic-csv' | 'text'
  cards: CollectionCardInput[]
  errors: CollectionRowError[]
}

function addCard(cards: Map<string, CollectionCardInput>, name: string, quantity: number): void {
  const cleanName = name.trim()
  const key = cleanName.toLocaleLowerCase('en-US')
  const existing = cards.get(key)
  cards.set(key, { name: existing?.name ?? cleanName, quantity: (existing?.quantity ?? 0) + quantity })
}

/** RFC 4180-compatible enough for card names, including quoted commas. */
function csvRow(line: string, separator: string): string[] | null {
  const fields: string[] = []
  let field = ''
  let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        field += '"'
        index += 1
      } else {
        quoted = !quoted
      }
    } else if (char === separator && !quoted) {
      fields.push(field.trim())
      field = ''
    } else {
      field += char
    }
  }
  if (quoted) return null
  fields.push(field.trim())
  return fields
}

function headerKey(value: string): string {
  return value.toLocaleLowerCase('en-US').replace(/[^a-z0-9]/g, '')
}

function headerIndex(headers: string[], aliases: string[]): number {
  return headers.findIndex((header) => aliases.includes(headerKey(header)))
}

function validQuantity(value: string | undefined): number | null {
  if (value === undefined || !/^\d{1,4}$/.test(value.trim())) return null
  const quantity = Number(value)
  return quantity >= 1 && quantity <= 1000 ? quantity : null
}

function parseText(lines: string[]): CollectionParseResult {
  const cards = new Map<string, CollectionCardInput>()
  const errors: CollectionRowError[] = []
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith('//')) continue
    const prefix = /^(\d+)\s*x?\s+(.+)$/.exec(line)
    const suffix = /^(.+?)\s+x\s*(\d+)$/i.exec(line)
    const name = prefix?.[2] ?? suffix?.[1] ?? line
    const quantity = prefix?.[1] ?? suffix?.[2] ?? '1'
    const parsedQuantity = validQuantity(quantity)
    if (!name?.trim() || parsedQuantity === null) {
      errors.push({ row: index + 1, message: 'Use a card name and a quantity between 1 and 1000.' })
      continue
    }
    addCard(cards, name, parsedQuantity)
  }
  return { source: 'text', cards: [...cards.values()], errors }
}

/** Parse ManaBox CSV, generic name/quantity CSV, or simple text collections. */
export function parseCollection(input: string): CollectionParseResult {
  if (new TextEncoder().encode(input).byteLength > MAX_COLLECTION_BYTES) {
    return { source: 'text', cards: [], errors: [{ row: 0, message: 'Collection file is larger than 1 MB.' }] }
  }
  const lines = input.replace(/^\uFEFF/, '').split(/\r?\n/)
  if (lines.length > MAX_COLLECTION_ROWS + 1) {
    return { source: 'text', cards: [], errors: [{ row: 0, message: 'Collection has more than 10,000 rows.' }] }
  }
  const separator = lines[0]?.includes(';') && !lines[0]?.includes(',') ? ';' : ','
  const headers = lines[0] ? csvRow(lines[0], separator) : null
  const nameColumn = headers ? headerIndex(headers, ['name', 'cardname', 'card']) : -1
  const quantityColumn = headers ? headerIndex(headers, ['quantity', 'qty', 'count', 'number']) : -1
  if (nameColumn < 0) return parseText(lines)

  const cards = new Map<string, CollectionCardInput>()
  const errors: CollectionRowError[] = []
  for (let index = 1; index < lines.length; index += 1) {
    if (!lines[index]?.trim()) continue
    const fields = csvRow(lines[index]!, separator)
    if (fields === null) {
      errors.push({ row: index + 1, message: 'Unclosed quote in CSV row.' })
      continue
    }
    const name = fields[nameColumn]?.trim() ?? ''
    const quantity = quantityColumn >= 0 ? validQuantity(fields[quantityColumn]) : 1
    if (!name) {
      errors.push({ row: index + 1, message: 'Missing card name.' })
      continue
    }
    if (quantity === null) {
      errors.push({ row: index + 1, message: 'Quantity must be a whole number between 1 and 1000.' })
      continue
    }
    addCard(cards, name, quantity)
  }

  const isManaBox = headers?.some((header) => ['manaboxid', 'collectionname', 'setcode'].includes(headerKey(header))) ?? false
  return { source: isManaBox ? 'manabox-csv' : 'generic-csv', cards: [...cards.values()], errors }
}
