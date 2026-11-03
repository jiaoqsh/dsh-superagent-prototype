import { ADDRESSED_NOISE, DECLINE_AFTER, GLOBAL_PROBES, NOISE, TASKS, THREAD_PROBES, type GlobalProbe, type TaskProbe } from './corpus.ts'

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
  /** A hard case (`corpus.ts`): `expect` lists the outcomes a correct Router may reach; `task` is the task it is about, if any. */
  | { kind: 'probe'; probe: ProbeKind; task?: string; expect: ProbeOutcome[]; extraSec: number }

/** A hard case: about a task, about none, or a refusal whose task only the context names (`DECLINE_AFTER`). */
export type ProbeKind = TaskProbe | GlobalProbe | 'declineAfter' | keyof typeof THREAD_PROBES

/** How a message ended: a new ticket, attached to its task's ticket, its task's ticket stopped, or no ticket at all. */
export type ProbeOutcome = 'accept' | 'attach' | 'stop' | 'ignore'
export const PROBE_EXPECT: Record<ProbeKind, ProbeOutcome[]> = {
  stop: ['stop'],
  // Answering is enough; attaching wakes the worker to answer, also right.
  status: ['ignore', 'attach'],
  // The same work again: anything but a second ticket. dispatch.md forbids attaching a message that is not explicit, so
  // the product's own answer is ignore.
  duplicate: ['ignore', 'attach'],
  similarNew: ['accept'],
  vague: ['ignore'], question: ['ignore'], hold: ['ignore'], decline: ['ignore'], polite: ['accept'],
  // The person just asked about that task: stopping it is right, asking which work they mean is too.
  declineAfter: ['stop', 'ignore'],
  // On the task's own thread: the message reaches the ticket (attach); the Router must stop it on a stop, and may on a refusal,
  // which the ticket's worker otherwise decides.
  threadStop: ['stop'], threadDecline: ['stop', 'attach'],
}

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
  /** Hard cases per request, about its task (`TaskProbe`, in rotation), each while the task is open. */
  probesPerRequest: number
  /** Hard cases about no task (`GlobalProbe`, in rotation), after the first fifth of the window. */
  globalProbes: number
  /** Kinds the hard cases about no task rotate through; default all. */
  globalKinds?: GlobalProbe[]
  /**
   * Refusals with context (`declineAfter`): on up to this many tasks without a stop, the person who asked about the task's
   * status (its `status` probe, added when it has none) declines 45 s later without naming it; later follow-ups come before.
   */
  contextDeclines?: number
  /**
   * On up to this many further tasks without a stop, the person who asked ends it on the task's own thread at 90% of its work
   * time, alternately with a stop (`threadStop`) and a refusal (`threadDecline`); follow-ups come before.
   */
  threadProbes?: number
  /** Indices into `TASKS` in the order requests use them; default in order. */
  taskOrder?: number[]
}
export const DEFAULT_GENERATE: GenerateOptions = {
  seed: 1, durationSec: 3600, requests: 20, noise: 220, addressedNoise: 10, followupsPerRequest: 2,
  crossFraction: 0.25, crossAddressed: 0.5, ciPerRequest: 1, ciFailure: 0.3, workSec: [600, 1800], extraSec: [120, 600],
  probesPerRequest: 0, globalProbes: 0,
}

const TASK_PROBES: TaskProbe[] = ['similarNew', 'duplicate', 'status', 'stop']

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
  let declined = 0
  let threaded = 0
  for (let i = 0; i < o.requests; i++) {
    const task = `task-${i}`
    const thread = `oc_team:om_req${i}`
    const order = o.taskOrder ?? TASKS.map((_, index) => index)
    const text = TASKS[order[i % order.length]!]!
    const at = Math.round(random() * o.durationSec)
    const workSec = between(o.workSec)
    const actor = pick(members)
    events.push({ at, thread, actor, human: true, addressed: true, text: text.request, truth: { kind: 'request', task, workSec } })
    const kinds = Array.from({ length: o.probesPerRequest }, (_, j) => TASK_PROBES[(i + j) % TASK_PROBES.length]!)
    // A stop comes last, so the task's other messages find it open.
    let stopAt = kinds.includes('stop') ? at + Math.round(workSec * 0.9) : Infinity
    const probe = (probe: TaskProbe, when: number, by: string) => events.push({ at: when, thread: `oc_team:om_probe${i}-${probe}`, actor: by,
      human: true, addressed: true, text: text.probes[probe], truth: { kind: 'probe', probe, task, expect: PROBE_EXPECT[probe], extraSec: between(o.extraSec) } })
    let status: { when: number; by: string } | undefined
    for (const kind of kinds) {
      const when = kind === 'stop' ? stopAt : at + Math.round(90 + random() * workSec * 0.6)
      // A duplicate usually comes from someone who missed the first request.
      const by = kind === 'duplicate' ? pick(members.filter(member => member !== actor)) : pick(members)
      probe(kind, when, by)
      if (kind === 'status') status = { when, by }
    }
    if (stopAt === Infinity && declined < (o.contextDeclines ?? 0)) {
      if (!status) { status = { when: at + Math.round(workSec * 0.6), by: pick(members) }; probe('status', status.when, status.by) }
      stopAt = status.when + 45
      events.push({ at: stopAt, thread: `oc_team:om_probe${i}-declineAfter`, actor: status.by, human: true, addressed: true,
        text: DECLINE_AFTER[declined % DECLINE_AFTER.length]!, truth: { kind: 'probe', probe: 'declineAfter', task, expect: PROBE_EXPECT.declineAfter, extraSec: 0 } })
      declined++
    } else if (stopAt === Infinity && threaded < (o.threadProbes ?? 0)) {
      const kind = threaded % 2 ? 'threadDecline' : 'threadStop'
      stopAt = at + Math.round(workSec * 0.9)
      events.push({ at: stopAt, thread, actor, human: true, addressed: true, text: THREAD_PROBES[kind][Math.floor(threaded / 2) % 3]!,
        truth: { kind: 'probe', probe: kind, task, expect: PROBE_EXPECT[kind], extraSec: 0 } })
      threaded++
    }
    // Each follow-up text once per task: the j-th of a kind takes text j where it is free, else the first free one, else
    // the follow-up becomes the other kind, so no task repeats a message word for word.
    const used = { cross: new Set<number>(), followup: new Set<number>() }
    const textOf = (kind: 'cross' | 'followup', j: number) => {
      const list = kind === 'cross' ? text.cross : text.followups
      const free = (n: number) => !used[kind].has(n)
      const index = free(j % list.length) ? j % list.length : list.findIndex((_, n) => free(n))
      if (index < 0) return undefined
      used[kind].add(index)
      return list[index]!
    }
    for (let j = 0; j < o.followupsPerRequest; j++) {
      const later = Math.min(stopAt - 60, at + Math.round(60 + random() * workSec * 1.2))
      const extraSec = between(o.extraSec)
      const crossWanted = random() < o.crossFraction
      let addressed = crossWanted && random() < o.crossAddressed
      const first = crossWanted ? 'cross' : 'followup'
      const second = crossWanted ? 'followup' : 'cross'
      let kind: 'cross' | 'followup' = first
      let body = textOf(first, j)
      if (body === undefined) {
        kind = second
        body = textOf(second, j)
        if (kind === 'cross') addressed = random() < o.crossAddressed
      }
      if (body === undefined) continue
      if (kind === 'cross') {
        events.push({ at: later, thread: `oc_team:om_cross${i}-${j}`, actor: pick(members), human: true, addressed,
          text: `${addressed ? '@agent ' : ''}${body}`, truth: { kind: 'cross', task, extraSec } })
      } else {
        events.push({ at: later, thread, actor: pick(members), human: true, addressed: false, text: body,
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
  const globals = o.globalKinds ?? Object.keys(GLOBAL_PROBES) as GlobalProbe[]
  for (let i = 0; i < o.globalProbes; i++) {
    const probe = globals[i % globals.length]!
    const texts = GLOBAL_PROBES[probe]
    events.push({ at: Math.round(o.durationSec * (0.2 + random() * 0.8)), thread: `oc_team:om_g${i}`, actor: pick(members), human: true,
      addressed: true, text: texts[Math.floor(i / globals.length) % texts.length]!,
      truth: { kind: 'probe', probe, expect: PROBE_EXPECT[probe], extraSec: between(o.extraSec) } })
  }
  events.sort((a, b) => a.at - b.at)
  return { name: `synthetic-seed${o.seed}`, members, events: events.map((event, index) => ({ ...event, id: `m${String(index).padStart(4, '0')}` })) }
}
