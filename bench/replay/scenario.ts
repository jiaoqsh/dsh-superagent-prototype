import { ADDRESSED_NOISE, NOISE, TASKS } from './corpus.ts'

/**
 * Replay scenarios: a timed message stream with a ground-truth label per message, so a run can be scored.
 * A scenario is plain data; `generate` builds a synthetic one shaped like the article's ablation load
 * (~300 messages, ~20 work requests, the rest chatter, follow-ups and CI).
 */

/** What a message really is; the simulated Router reads this as its oracle, and the report scores against it. */
export type Truth =
  | { kind: 'noise' }
  /** A new work request, addressed to the agent by an allowed member, on its own thread. */
  | { kind: 'request'; task: string; workSec: number }
  /** More input for a task on the task's own thread (the subscription fast path). */
  | { kind: 'followup'; task: string; extraSec: number }
  /** More input for a task written on another thread, such as the general chat (needs the Router to attach it). */
  | { kind: 'cross'; task: string; extraSec: number }
  /** A CI result on the task's thread; `extraSec` > 0 is a failure the worker must fix. */
  | { kind: 'ci'; task: string; extraSec: number }

/**
 * `thread` follows the Feishu Source: a group message starts its own Thread (chat + root message) and replies join it, so
 * each top-level message in the group chat is a Thread of its own (`<chat>:<root message>`).
 */
export interface ScenarioEvent {
  /** Seconds from the start of the run. */
  at: number
  id: string
  thread: string
  actor: string
  human: boolean
  addressed: boolean
  text: string
  truth: Truth
}
export interface Scenario { name: string; members: string[]; events: ScenarioEvent[] }

export interface GenerateOptions {
  seed: number
  /** Length of the window in which requests arrive, in seconds. */
  durationSec: number
  requests: number
  /** Unaddressed chatter in the general chat. */
  noise: number
  /** Chatter that addresses the agent but asks for no work ("@agent thanks"). */
  addressedNoise: number
  followupsPerRequest: number
  /** Share of follow-ups written on the general chat instead of the task's thread. */
  crossFraction: number
  /** Share of cross-thread follow-ups that address the agent; unaddressed ones test what the gate lets through. */
  crossAddressed: number
  ciPerRequest: number
  /** Share of CI results that fail. */
  ciFailure: number
  workSec: [number, number]
  extraSec: [number, number]
}
export const DEFAULT_GENERATE: GenerateOptions = {
  seed: 1, durationSec: 3600, requests: 20, noise: 220, addressedNoise: 10, followupsPerRequest: 2,
  crossFraction: 0.25, crossAddressed: 0.5, ciPerRequest: 1, ciFailure: 0.3, workSec: [600, 1800], extraSec: [120, 600],
}

/** Small deterministic PRNG (mulberry32) so a seed reproduces a scenario exactly. */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function generate(options: Partial<GenerateOptions> = {}): Scenario {
  const o = { ...DEFAULT_GENERATE, ...options }
  const random = rng(o.seed)
  const between = ([min, max]: [number, number]) => Math.round(min + random() * (max - min))
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!
  const members = ['alice', 'bob', 'carol']
  const guests = ['dave', 'erin']
  const events: Omit<ScenarioEvent, 'id'>[] = []
  for (let i = 0; i < o.requests; i++) {
    const task = `task-${i}`
    const thread = `oc_team:om_req${i}`
    const text = TASKS[i % TASKS.length]!
    const at = Math.round(random() * o.durationSec)
    const workSec = between(o.workSec)
    events.push({ at, thread, actor: pick(members), human: true, addressed: true, text: text.request, truth: { kind: 'request', task, workSec } })
    for (let j = 0; j < o.followupsPerRequest; j++) {
      const later = at + Math.round(60 + random() * workSec * 1.2)
      const extraSec = between(o.extraSec)
      if (random() < o.crossFraction) {
        const addressed = random() < o.crossAddressed
        events.push({ at: later, thread: `oc_team:om_cross${i}-${j}`, actor: pick(members), human: true, addressed,
          text: `${addressed ? '@agent ' : ''}${text.cross[j % text.cross.length]!}`, truth: { kind: 'cross', task, extraSec } })
      } else {
        events.push({ at: later, thread, actor: pick(members), human: true, addressed: false, text: text.followups[j % text.followups.length]!,
          truth: { kind: 'followup', task, extraSec } })
      }
    }
    for (let j = 0; j < o.ciPerRequest; j++) {
      const failed = random() < o.ciFailure
      events.push({ at: at + Math.round(workSec * (0.5 + random() * 0.5)), thread, actor: 'ci', human: false, addressed: false,
        text: failed ? `CI failed: 2 tests failed in ${task}` : `CI passed for ${task}`, truth: { kind: 'ci', task, extraSec: failed ? between(o.extraSec) : 0 } })
    }
  }
  for (let i = 0; i < o.noise; i++) {
    events.push({ at: Math.round(random() * o.durationSec * 1.3), thread: `oc_team:om_noise${i}`, actor: pick([...members, ...guests]), human: true,
      addressed: false, text: NOISE[i % NOISE.length]!, truth: { kind: 'noise' } })
  }
  for (let i = 0; i < o.addressedNoise; i++) {
    events.push({ at: Math.round(random() * o.durationSec * 1.3), thread: `oc_team:om_hi${i}`, actor: pick(members), human: true, addressed: true,
      text: ADDRESSED_NOISE[i % ADDRESSED_NOISE.length]!, truth: { kind: 'noise' } })
  }
  events.sort((a, b) => a.at - b.at)
  return { name: `synthetic-seed${o.seed}`, members, events: events.map((event, index) => ({ ...event, id: `m${String(index).padStart(4, '0')}` })) }
}
