import { describe, it, expect } from 'vitest'
import { mapWithConcurrency } from './concurrency.js'

describe('mapWithConcurrency', () => {
  it('keeps input order even when later items finish first', async () => {
    const out = await mapWithConcurrency([30, 20, 10, 0], 4, async (ms, i) => {
      await new Promise(r => setTimeout(r, ms))
      return `${i}:${ms}`
    })
    expect(out).toEqual(['0:30', '1:20', '2:10', '3:0'])
  })

  it('never exceeds the concurrency limit', async () => {
    let inFlight = 0
    let peak = 0
    await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise(r => setTimeout(r, 5))
      inFlight--
      return null
    })
    expect(peak).toBe(4)
  })

  it('runs concurrently rather than sequentially', async () => {
    const started = Date.now()
    await mapWithConcurrency([20, 20, 20, 20], 4, async ms => {
      await new Promise(r => setTimeout(r, ms))
      return null
    })
    // Sequential would be ~80ms; four at once is ~20ms. Generous bound so the
    // test does not go flaky on a loaded box.
    expect(Date.now() - started).toBeLessThan(70)
  })

  it('propagates the first rejection, like the await-in-loop it replaces', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async n => {
        if (n === 2) throw new Error('boom')
        return n
      }),
    ).rejects.toThrow('boom')
  })

  it('handles an empty list and a limit wider than the list', async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([])
    expect(await mapWithConcurrency([1, 2], 99, async n => n * 2)).toEqual([2, 4])
  })
})
