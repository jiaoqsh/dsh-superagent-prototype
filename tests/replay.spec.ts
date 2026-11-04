import { describe, expect, it } from 'vitest'
import { generate } from '../bench/replay/scenario.ts'
import { simulate } from '../bench/replay/sim.ts'

describe('replay simulator', { timeout: 60_000 }, () => {
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
  it('launches an assignment once however often the Engine asks for it', async () => {
    // The Engine asks again for an assignment that waits for a slot; a second launch would restart its work.
    for (const seed of [1, 2, 3]) expect((await simulate(generate({ seed }), { seed })).errors).toEqual([])
  })
  it('lets an injected hang hold its slot until a Watchdog notices it', async () => {
    const scenario = generate({ seed: 4 })
    const hung = await simulate(scenario, { seed: 4, hangRate: 0.3 })
    expect(hung.faults.hung).toBeGreaterThan(0)
    expect(hung.faults.unnoticed).toBe(hung.faults.hung)
    expect(hung.faults.detectedSec).toEqual([])
    const watched = await simulate(scenario, { seed: 4, hangRate: 0.3, watchdogSec: 1200 })
    expect(watched.faults.unnoticed).toBe(0)
    expect(watched.faults.detectedSec.length).toBe(watched.faults.hung)
    expect(new Set(watched.faults.detectedSec)).toEqual(new Set([1200]))
    expect(watched.faults.neverStarted).toBe(0)
  })
  it('lets a runaway worker past an activity Watchdog, and stops it at its turn budget', async () => {
    const scenario = generate({ seed: 4 })
    const watched = await simulate(scenario, { seed: 4, loopRate: 0.3, watchdogSec: 1200 })
    expect(watched.faults.looped).toBeGreaterThan(0)
    expect(watched.faults.loopUnnoticed).toBe(watched.faults.looped)
    const budgeted = await simulate(scenario, { seed: 4, loopRate: 0.3, watchdogSec: 1200, turnBudgetSec: 3600 })
    expect(budgeted.errors).toEqual([])
    expect(budgeted.faults.loopUnnoticed).toBe(0)
    expect(budgeted.faults.loopStoppedSec.length).toBe(budgeted.faults.looped)
    expect(budgeted.faults.neverStarted).toBe(0)
  })
  it('drops what a failing main Session took in, and expires its candidates as unavailable', async () => {
    const scenario = generate({ seed: 1 })
    const out = await simulate(scenario, { seed: 1, routerOutage: { atSec: 1200, sec: 1800, mode: 'fail' } })
    expect(out.errors).toEqual([])
    expect(out.routerStats.dropped?.candidate).toBeGreaterThan(0)
    expect(out.decisions.timeout).toBeGreaterThan(0)
    // A stalled one loses nothing: its requests wait until the model is back.
    const stalled = await simulate(scenario, { seed: 1, routerOutage: { atSec: 1200, sec: 1800, mode: 'stall' } })
    expect(stalled.decisions.timeout ?? 0).toBe(0)
    expect(stalled.score.requests.missed).toBe(0)
  })
  it('loses no message when the host restarts with workers running', async () => {
    for (const sessionLost of [false, true]) {
      const scenario = generate({ seed: 2 })
      const calm = await simulate(scenario, { seed: 2 })
      const restarted = await simulate(scenario, { seed: 2, restartAtSec: 1800, sessionLost })
      expect(restarted.errors).toEqual([])
      expect(restarted.faults.interrupted).toBeGreaterThan(0)
      expect(restarted.requests.filter(r => r.resultAt !== undefined)).toHaveLength(calm.requests.length)
      expect(restarted.followups.filter(f => f.ackAt !== undefined).length).toBe(calm.followups.filter(f => f.ackAt !== undefined).length)
    }
  })
  it('is deterministic for a seed', async () => {
    const run = () => simulate(generate({ seed: 5, requests: 3, noise: 10 }), { seed: 5, pollSec: 30 })
    expect((await run()).requests).toEqual((await run()).requests)
  })
})
