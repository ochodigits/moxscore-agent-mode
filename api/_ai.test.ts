import { afterEach, describe, expect, it, vi } from 'vitest'

import { AiProviderError, aiProviderConfiguration, complete, type AiProviderConfiguration } from './_ai'

const base: AiProviderConfiguration = {
  provider: 'openai',
  model: 'approved-model-v1',
  apiKey: 'server-secret',
  connectTimeoutMs: 500,
  readTimeoutMs: 1_000,
  totalTimeoutMs: 2_000,
  maxResponseBytes: 4_096,
  maxOutputTokens: 256,
  siteUrl: 'https://moxscore.example',
  appName: 'Moxscore',
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
}

describe('AI provider adapter', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  it('requires an explicit supported provider, model, and server key', () => {
    expect(aiProviderConfiguration({})).toBeNull()
    expect(aiProviderConfiguration({ AI_PROVIDER: 'openai', AI_MODEL: 'model' })).toBeNull()
    expect(aiProviderConfiguration({ AI_PROVIDER: 'other', AI_MODEL: 'model', AI_PROVIDER_API_KEY: 'key' })).toBeNull()
    expect(aiProviderConfiguration({ AI_PROVIDER: 'openai', AI_MODEL: 'bad model!', AI_PROVIDER_API_KEY: 'key' })).toBeNull()
    expect(aiProviderConfiguration({
      AI_PROVIDER: 'openai', AI_MODEL: 'approved/model-v1', AI_PROVIDER_API_KEY: 'key',
    })).toMatchObject({ provider: 'openai', model: 'approved/model-v1' })
  })

  it('calls only OpenAI Responses with storage disabled and strict output', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      output: [{ type: 'message', content: [{ type: 'output_text', text: '{"ok":true}' }] }],
      usage: { input_tokens: 33, output_tokens: 9 },
    }))

    const result = await complete('system', 'user', base)

    expect(result).toEqual({ text: '{"ok":true}', provider: 'openai', model: 'approved-model-v1', inputTokens: 33, outputTokens: 9 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.openai.com/v1/responses')
    const body = JSON.parse(String(init?.body))
    expect(body).toMatchObject({ model: 'approved-model-v1', store: false, text: { format: { type: 'json_schema', strict: true } } })
    expect(init?.headers).toMatchObject({ authorization: 'Bearer server-secret' })
  })

  it('calls only Anthropic Messages and accounts for cache token usage', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      content: [{ type: 'text', text: '{"schemaVersion":"v1"}' }],
      usage: { input_tokens: 20, cache_creation_input_tokens: 5, cache_read_input_tokens: 7, output_tokens: 4 },
    }))
    const result = await complete('system', 'user', { ...base, provider: 'anthropic' })
    expect(result).toMatchObject({ provider: 'anthropic', inputTokens: 32, outputTokens: 4 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.anthropic.com/v1/messages')
  })

  it('calls OpenRouter Chat Completions with structured JSON and attribution headers', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      choices: [{ message: { content: '{"schemaVersion":"moxscore.tune-explanations.provider.v1","explanations":[]}' } }],
      usage: { prompt_tokens: 40, completion_tokens: 12 },
    }))
    const result = await complete('system', 'user', {
      ...base,
      provider: 'openrouter',
      model: 'anthropic/claude-haiku-4.5',
    })
    expect(result).toEqual({
      text: '{"schemaVersion":"moxscore.tune-explanations.provider.v1","explanations":[]}',
      provider: 'openrouter',
      model: 'anthropic/claude-haiku-4.5',
      inputTokens: 40,
      outputTokens: 12,
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(init?.headers).toMatchObject({
      authorization: 'Bearer server-secret',
      'HTTP-Referer': 'https://moxscore.example',
      'X-Title': 'Moxscore',
    })
    const body = JSON.parse(String(init?.body))
    expect(body).toMatchObject({
      model: 'anthropic/claude-haiku-4.5',
      temperature: 0,
      provider: { require_parameters: true },
      response_format: { type: 'json_schema', json_schema: { strict: true } },
    })
  })

  it('accepts openrouter as an explicit configured provider', () => {
    expect(aiProviderConfiguration({
      AI_PROVIDER: 'openrouter',
      AI_MODEL: 'anthropic/claude-haiku-4.5',
      AI_PROVIDER_API_KEY: 'or-key',
      PUBLIC_ORIGIN: 'https://moxscore-8digits-git-agent-moxscore-v2-pro-ai-kisspz.vercel.app',
    })).toMatchObject({
      provider: 'openrouter',
      model: 'anthropic/claude-haiku-4.5',
      siteUrl: 'https://moxscore-8digits-git-agent-moxscore-v2-pro-ai-kisspz.vercel.app',
      appName: 'Moxscore',
    })
  })

  it('does not retry or switch provider after a non-success status', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('no', { status: 429 }))
    await expect(complete('system', 'user', base)).rejects.toMatchObject({ code: 'provider_status' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rejects advertised and streamed responses above the byte cap', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('x', { headers: { 'content-length': '5000' } }))
    await expect(complete('system', 'user', base)).rejects.toMatchObject({ code: 'response_too_large' })

    vi.restoreAllMocks()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'x'.repeat(5_000) }] }] }))
    await expect(complete('system', 'user', base)).rejects.toMatchObject({ code: 'response_too_large' })
  })

  it('normalizes transport and malformed provider payloads to bounded errors', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('socket detail must not escape'))
    await expect(complete('system', 'user', base)).rejects.toEqual(new AiProviderError('timeout'))
    expect(fetchMock).toHaveBeenCalledTimes(1)

    vi.restoreAllMocks()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ output: [] }))
    await expect(complete('system', 'user', base)).rejects.toMatchObject({ code: 'invalid_response' })
  })

  it('enforces the connect timeout with an abort path', async () => {
    vi.useFakeTimers()
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    }))
    const pending = complete('system', 'user', base)
    const expectation = expect(pending).rejects.toMatchObject({ code: 'timeout' })
    await vi.advanceTimersByTimeAsync(base.connectTimeoutMs)
    await expectation
  })

  it('enforces the streaming read-idle timeout with an abort path', async () => {
    vi.useFakeTimers()
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => new Response(new ReadableStream({
      start(controller) {
        init?.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')))
      },
    })))
    const pending = complete('system', 'user', base)
    const expectation = expect(pending).rejects.toMatchObject({ code: 'timeout' })
    await vi.advanceTimersByTimeAsync(base.readTimeoutMs)
    await expectation
  })

  it('enforces the total timeout independently of a longer connect timer', async () => {
    vi.useFakeTimers()
    const totalFirst = { ...base, connectTimeoutMs: 5_000, totalTimeoutMs: 2_000 }
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    }))
    const pending = complete('system', 'user', totalFirst)
    const expectation = expect(pending).rejects.toMatchObject({ code: 'timeout' })
    await vi.advanceTimersByTimeAsync(totalFirst.totalTimeoutMs)
    await expectation
  })
})
