import { describe, expect, it, vi } from 'vitest'
import { runPodCheck } from './podCheckService'

const analysis = { commanders: ['Commander'], commanderImage: null, bracket: {} } as never

describe('transport-neutral Pod Check service', () => {
  it('preserves deck order and isolates an individual deck failure', async () => {
    const analyze = vi.fn()
      .mockResolvedValueOnce(analysis)
      .mockRejectedValueOnce(new Error('Import unavailable'))

    const outcomes = await runPodCheck([{ input: 'deck one' }, { input: 'deck two' }], { analyze })

    expect(outcomes).toEqual([
      { input: 'deck one', analysis, error: null },
      { input: 'deck two', analysis: null, error: 'Import unavailable' },
    ])
    expect(analyze).toHaveBeenCalledWith('deck one')
    expect(analyze).toHaveBeenCalledWith('deck two')
  })

  it('rejects an invalid pod before invoking the transport dependency', async () => {
    const analyze = vi.fn()
    await expect(runPodCheck([{ input: 'only one' }], { analyze })).rejects.toThrow('2–4 decks')
    expect(analyze).not.toHaveBeenCalled()
  })
})
