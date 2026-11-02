import { describe, expect, it } from 'vitest'
import { generate } from '../bench/replay/scenario.ts'
import { simulate } from '../bench/replay/sim.ts'

describe('replay simulator', () => {
  it('replays a small scenario through the real Engine without errors', () => {
    const scenario = generate({ seed: 3, requests: 4, noise: 30, addressedNoise: 2, durationSec: 900, workSec: [120, 240], extraSec: [30, 60] })
    const result = simulate(scenario, { seed: 3 })
    expect(result.errors).toEqual([])
    expect(result.requests).toHaveLength(4)
    // Every request is acknowledged on the Router's accept and gets a result once its worker reports ready.
    for (const request of result.requests) {
      expect(request.ackAt).toBeGreaterThan(request.arrivedAt)
      expect(request.resultAt).toBeGreaterThan(request.ackAt!)
    }
    // Follow-ups on a task's own thread reach its worker without the Router.
    expect(result.followups.filter(f => f.kind === 'followup').every(f => f.path === 'fast')).toBe(true)
    expect(result.mistakes).toEqual({ falseAccepts: 0, missedRequests: 0, missedAttaches: 0 })
  })
  it('is deterministic for a seed', () => {
    const run = () => simulate(generate({ seed: 5, requests: 3, noise: 10 }), { seed: 5, pollSec: 30 })
    expect(run().requests).toEqual(run().requests)
  })
})
