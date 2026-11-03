import { describe, expect, it } from 'vitest'
import { generate } from '../bench/replay/scenario.ts'
import { simulate } from '../bench/replay/sim.ts'

describe('replay simulator', () => {
  it('replays a small scenario through the real Engine without errors', async () => {
    const scenario = generate({ seed: 3, requests: 4, noise: 30, addressedNoise: 2, durationSec: 900, workSec: [120, 240], extraSec: [30, 60] })
    const result = await simulate(scenario, { seed: 3 })
    expect(result.errors).toEqual([])
    expect(result.requests).toHaveLength(4)
    // Every request is acknowledged on the Router's accept and gets a result once its worker reports ready.
    for (const request of result.requests) {
      expect(request.ackAt).toBeGreaterThan(request.arrivedAt)
      expect(request.resultAt).toBeGreaterThan(request.ackAt!)
    }
    // Follow-ups on a task's own thread reach its worker without the Router.
    expect(result.score.followups.fast).toBe(result.score.followups.total)
    expect(result.score.requests).toMatchObject({ total: 4, accepted: 4, missed: 0 })
    expect(result.score.falseTickets).toBe(0)
    expect(result.score.cross.attachedWrong + result.score.cross.acceptedAsNew).toBe(0)
  })
  it('tells the Router of follow-ups on a ticket\'s thread, so a stop there ends the ticket, and scores every hard case', async () => {
    const options = { seed: 2, durationSec: 2400, requests: 12, noise: 10, addressedNoise: 2, followupsPerRequest: 2, crossFraction: 0.5,
      crossAddressed: 1, ciPerRequest: 0, workSec: [900, 1500] as [number, number], probesPerRequest: 2, globalProbes: 10, contextDeclines: 2, threadProbes: 4 }
    const scripted = generate(options)
    const result = await simulate(scripted, { seed: 2, maxWorkers: 16, followupNotices: true })
    expect(result.errors).toEqual([])
    expect(result.score.probes.threadStop).toMatchObject({ total: 2, right: 2 })
    expect(result.score.probes.threadDecline).toMatchObject({ total: 2, right: 2 })
    expect(result.score.stops.wrong).toBe(0)
    expect(result.score.harm).toBe(0)
    // Without notices the Router never hears of a stop on a ticket's own thread.
    const silent = await simulate(scripted, { seed: 2, maxWorkers: 16 })
    expect(silent.score.probes.threadStop!.right).toBe(0)
  })
  it('is deterministic for a seed', async () => {
    const run = () => simulate(generate({ seed: 5, requests: 3, noise: 10 }), { seed: 5, pollSec: 30 })
    expect((await run()).requests).toEqual((await run()).requests)
  })
})
