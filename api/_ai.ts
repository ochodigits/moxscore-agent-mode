import { AI_TUNE_PROVIDER_SCHEMA } from './_aiContract.js'

export type AiProvider = 'anthropic' | 'openai' | 'openrouter'
type ServerEnv = Record<string, string | undefined>

const SUPPORTED_PROVIDERS = new Set<AiProvider>(['anthropic', 'openai', 'openrouter'])

export interface AiProviderConfiguration {
  provider: AiProvider
  model: string
  apiKey: string
  connectTimeoutMs: number
  readTimeoutMs: number
  totalTimeoutMs: number
  maxResponseBytes: number
  maxOutputTokens: number
  /** OpenRouter attribution headers only; ignored by other adapters. */
  siteUrl: string | null
  appName: string | null
}

export interface AiCompletion {
  text: string
  provider: AiProvider
  model: string
  inputTokens: number
  outputTokens: number
}

export class AiProviderError extends Error {
  readonly code: 'configuration' | 'timeout' | 'response_too_large' | 'provider_status' | 'invalid_response'

  constructor(code: AiProviderError['code']) {
    super(`AI provider ${code}`)
    this.code = code
  }
}

function boundedInteger(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = Number(raw)
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback
}

/** No provider, model, or key is selected implicitly. */
export function aiProviderConfiguration(env: ServerEnv = process.env): AiProviderConfiguration | null {
  const providerRaw = env.AI_PROVIDER?.trim()
  const model = env.AI_MODEL?.trim() ?? ''
  const apiKey = env.AI_PROVIDER_API_KEY?.trim() ?? ''
  if (!providerRaw || !SUPPORTED_PROVIDERS.has(providerRaw as AiProvider) || !model || !apiKey) return null
  const provider = providerRaw as AiProvider
  if (model.length > 100 || !/^[A-Za-z0-9._:/-]+$/.test(model)) return null
  const connectTimeoutMs = boundedInteger(env.MOXSCORE_AI_CONNECT_TIMEOUT_MS, 5_000, 500, 15_000)
  const readTimeoutMs = boundedInteger(env.MOXSCORE_AI_READ_TIMEOUT_MS, 15_000, 1_000, 30_000)
  const totalTimeoutMs = boundedInteger(env.MOXSCORE_AI_TOTAL_TIMEOUT_MS, 25_000, 2_000, 45_000)
  if (connectTimeoutMs >= totalTimeoutMs || readTimeoutMs >= totalTimeoutMs) return null
  const siteUrl = env.AI_OPENROUTER_SITE_URL?.trim() || env.PUBLIC_ORIGIN?.trim() || null
  const appName = env.AI_OPENROUTER_APP_NAME?.trim() || 'Moxscore'
  return {
    provider,
    model,
    apiKey,
    connectTimeoutMs,
    readTimeoutMs,
    totalTimeoutMs,
    maxResponseBytes: boundedInteger(env.MOXSCORE_AI_MAX_RESPONSE_BYTES, 32_768, 4_096, 65_536),
    maxOutputTokens: boundedInteger(env.MOXSCORE_AI_MAX_OUTPUT_TOKENS, 800, 128, 2_000),
    siteUrl: siteUrl && siteUrl.length <= 200 ? siteUrl : null,
    appName: appName.length <= 80 ? appName : 'Moxscore',
  }
}

async function readBoundedJson(
  response: Response,
  controller: AbortController,
  readTimeoutMs: number,
  maxResponseBytes: number,
): Promise<unknown> {
  const advertised = Number(response.headers.get('content-length'))
  if (Number.isFinite(advertised) && advertised > maxResponseBytes) {
    controller.abort()
    throw new AiProviderError('response_too_large')
  }
  if (response.body === null) throw new AiProviderError('invalid_response')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const arm = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => controller.abort(), readTimeoutMs)
  }
  try {
    arm()
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > maxResponseBytes) {
        controller.abort()
        throw new AiProviderError('response_too_large')
      }
      chunks.push(chunk.value)
      arm()
    }
  } catch (error) {
    if (error instanceof AiProviderError) throw error
    throw new AiProviderError('timeout')
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw new AiProviderError('invalid_response')
  }
}

async function postJson(url: string, body: unknown, headers: Record<string, string>, config: AiProviderConfiguration): Promise<unknown> {
  const controller = new AbortController()
  const totalTimer = setTimeout(() => controller.abort(), config.totalTimeoutMs)
  const connectTimer = setTimeout(() => controller.abort(), config.connectTimeoutMs)
  try {
    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch {
      throw new AiProviderError('timeout')
    } finally {
      clearTimeout(connectTimer)
    }
    if (!response.ok) {
      controller.abort()
      throw new AiProviderError('provider_status')
    }
    return await readBoundedJson(response, controller, config.readTimeoutMs, config.maxResponseBytes)
  } finally {
    clearTimeout(connectTimer)
    clearTimeout(totalTimer)
  }
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0
}

async function completeAnthropic(system: string, user: string, config: AiProviderConfiguration): Promise<AiCompletion> {
  const raw = await postJson('https://api.anthropic.com/v1/messages', {
    model: config.model,
    max_tokens: config.maxOutputTokens,
    system,
    messages: [{ role: 'user', content: user }],
  }, {
    'x-api-key': config.apiKey,
    'anthropic-version': '2023-06-01',
  }, config) as {
    content?: Array<{ type?: unknown; text?: unknown }>
    usage?: {
      input_tokens?: unknown
      cache_creation_input_tokens?: unknown
      cache_read_input_tokens?: unknown
      output_tokens?: unknown
    }
  }
  const text = (raw.content ?? [])
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('')
  if (!text) throw new AiProviderError('invalid_response')
  return {
    text,
    provider: 'anthropic',
    model: config.model,
    inputTokens: numberOrZero(raw.usage?.input_tokens)
      + numberOrZero(raw.usage?.cache_creation_input_tokens)
      + numberOrZero(raw.usage?.cache_read_input_tokens),
    outputTokens: numberOrZero(raw.usage?.output_tokens),
  }
}

const OPENAI_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'explanations'],
  properties: {
    schemaVersion: { type: 'string', const: AI_TUNE_PROVIDER_SCHEMA },
    explanations: {
      type: 'array',
      maxItems: 10,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['pairIndex', 'cut', 'add', 'reasoning'],
        properties: {
          pairIndex: { type: 'integer', minimum: 0, maximum: 9 },
          cut: { type: 'string', maxLength: 120 },
          add: { type: 'string', maxLength: 120 },
          reasoning: { type: 'string', maxLength: 280 },
        },
      },
    },
  },
} as const

async function completeOpenAi(system: string, user: string, config: AiProviderConfiguration): Promise<AiCompletion> {
  const raw = await postJson('https://api.openai.com/v1/responses', {
    model: config.model,
    instructions: system,
    input: user,
    max_output_tokens: config.maxOutputTokens,
    store: false,
    text: {
      format: {
        type: 'json_schema',
        name: 'moxscore_tune_explanations',
        strict: true,
        schema: OPENAI_OUTPUT_SCHEMA,
      },
    },
  }, { authorization: `Bearer ${config.apiKey}` }, config) as {
    output?: Array<{ type?: unknown; content?: Array<{ type?: unknown; text?: unknown }> }>
    usage?: { input_tokens?: unknown; output_tokens?: unknown }
  }
  const text = (raw.output ?? [])
    .filter((item) => item.type === 'message')
    .flatMap((item) => item.content ?? [])
    .filter((part) => part.type === 'output_text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('')
  if (!text) throw new AiProviderError('invalid_response')
  return {
    text,
    provider: 'openai',
    model: config.model,
    inputTokens: numberOrZero(raw.usage?.input_tokens),
    outputTokens: numberOrZero(raw.usage?.output_tokens),
  }
}

/**
 * OpenRouter Chat Completions. One explicit model slug; swap via AI_MODEL.
 * Spend is controlled by OpenRouter account limits plus Moxscore budget env.
 */
async function completeOpenRouter(system: string, user: string, config: AiProviderConfiguration): Promise<AiCompletion> {
  const headers: Record<string, string> = { authorization: `Bearer ${config.apiKey}` }
  if (config.siteUrl) headers['HTTP-Referer'] = config.siteUrl
  if (config.appName) headers['X-Title'] = config.appName

  const raw = await postJson('https://openrouter.ai/api/v1/chat/completions', {
    model: config.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    max_tokens: config.maxOutputTokens,
    temperature: 0,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'moxscore_tune_explanations',
        strict: true,
        schema: OPENAI_OUTPUT_SCHEMA,
      },
    },
    // Prefer routes that honor structured-output parameters.
    provider: { require_parameters: true },
  }, headers, config) as {
    choices?: Array<{ message?: { content?: unknown } }>
    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown }
  }

  const content = raw.choices?.[0]?.message?.content
  const text = typeof content === 'string' ? content : ''
  if (!text) throw new AiProviderError('invalid_response')
  return {
    text,
    provider: 'openrouter',
    model: config.model,
    inputTokens: numberOrZero(raw.usage?.prompt_tokens),
    outputTokens: numberOrZero(raw.usage?.completion_tokens),
  }
}

/** Exactly one explicitly configured provider is called. There is no retry or fallback provider. */
export async function complete(
  system: string,
  user: string,
  config: AiProviderConfiguration | null = aiProviderConfiguration(),
): Promise<AiCompletion> {
  if (config === null) throw new AiProviderError('configuration')
  if (config.provider === 'anthropic') return completeAnthropic(system, user, config)
  if (config.provider === 'openrouter') return completeOpenRouter(system, user, config)
  return completeOpenAi(system, user, config)
}
