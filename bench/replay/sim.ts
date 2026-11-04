/**
 * Discrete-event replay of a Scenario through the real core Engine and the real settings Policy (gate), on a virtual clock.
 *
 * Modelled, not real: workers take `launchSec` to start, hold one of `maxWorkers` slots until their turn ends, read
 * delivered inputs after `workerStepSec`, and work for the time the scenario gives; a Source delivers a message after a
 * uniform share of `pollSec` (0 = push). The main Session (Router) is pluggable:
 *
 * - `oracleRouter` (default): one step takes every queued card; step time `routerBaseSec + routerPerItemSec × items`
 *   (defaults fit the article's §7.2: 2.5 s at 1 item, 3.9 s at 2.8); decisions come from the scenario's ground truth,
 *   flipped with probability `routerErrorRate`. It measures scheduling and routing mechanics, not judgement.
 * - a model Router (`llm-router.ts`): the real orchestrator prompt and tools over a real model; each model call takes its
 *   measured wall time in virtual time, and cards that arrive meanwhile are steered into the same turn, as in DSH.
 */
import { Engine, MemoryRepositories, followupOwners, key, liveTicket, reasonText, runningAssignment } from '../../src/core/index.ts'
import type { Candidate, DomainEvent, EngineOptions, Executor, OutboundMessage, Trigger } from '../../src/core/index.ts'
import { SettingsSchema, settingsPolicy, type Settings } from '../../src/policy.ts'
import { rng, type ProbeOutcome, type Scenario, type ScenarioEvent, type Truth } from './scenario.ts'

export const SOURCE = 'feishu'

export interface SimOptions {
  seed: number
  maxWorkers: number
  routerBaseSec: number
  routerPerItemSec: number
  /** Oracle Router only: probability that it decides a candidate wrongly (accepts noise, ignores a request, misses an attach). */
  routerErrorRate: number
  launchSec: number
  workerStepSec: number
  /** Source polling interval; a message waits a uniform share of it before the Engine receives it. */
  pollSec: number
  /** Engine pass interval (`Passes` runs every 2 s). */
  tickSec: number
  evalTimeoutSec: number
  /** Accept mode: `off` | `observe` | `auto`. */
  mode: 'off' | 'observe' | 'auto'
  /**
   * Forced batching, to measure judgement against batch size: the Router starts a turn, and takes jobs steered in, only
   * once `minBatch` jobs wait or the oldest has waited `batchHoldSec`. 1 = as DSH does (no hold).
   */
  minBatch: number
  batchHoldSec: number
  /**
   * Tell the Router of a person's message that reached a live ticket by its thread (a `follow_up` notice, as the runtime
   * does), so it may stop the work on it. Off by default, as in the runs before it was modelled.
   */
  followupNotices: boolean
  /**
   * Fault injection (#8): the share of first assignments whose worker hangs at a random point of its work, holding its slot
   * without reporting or reading input (a stuck tool or model call; the prototype has no timer for a running turn).
   */
  hangRate: number
  /**
   * A Watchdog that notices a worker with no activity for this many seconds, ends its turn as failed (the person is told and
   * may retry) and frees its slot; 0 is none, as in the prototype.
   */
  watchdogSec: number
  /**
   * Fault injection (#8): the share of first assignments whose worker runs away at a random point of its work: it goes on
   * working, reading input and holding its slot, but never converges or reports. Its activity hides it from `watchdogSec`.
   */
  loopRate: number
  /** A budget on one worker turn (wall time standing in for steps, tokens or cost): past it the turn ends as failed; 0 is none. */
  turnBudgetSec: number
  /**
   * The model behind the main Session is down from `atSec` for `sec`: `stall` holds a step until it is back (the model
   * request is retried), `fail` ends each turn that starts meanwhile without acting on what it took in. Oracle Router only.
   */
  routerOutage?: { atSec: number; sec: number; mode: 'stall' | 'fail' }
  /**
   * The host restarts at this second (0 = never): running worker turns are interrupted and the Engine decides how each goes on
   * (`assignmentInterrupted`). A kept Session goes on from where it stopped; a lost one (`sessionLost`) does the work again.
   */
  restartAtSec: number
  sessionLost: boolean
}
export const DEFAULT_SIM: SimOptions = {
  seed: 1, maxWorkers: 3, routerBaseSec: 1.72, routerPerItemSec: 0.78, routerErrorRate: 0, launchSec: 30, workerStepSec: 15,
  pollSec: 0, tickSec: 2, evalTimeoutSec: 120, mode: 'off', minBatch: 1, batchHoldSec: 60,
  followupNotices: false, hangRate: 0, watchdogSec: 0,
  loopRate: 0, turnBudgetSec: 0, restartAtSec: 0, sessionLost: false,
}

/** What waits for the main Session: a candidate card, or a worker's ready report to relay. */
export type Job = { kind: 'candidate'; candidate: Candidate } | { kind: 'relay'; ticketId: string; summary: string }
  /** A person's message that reached a live ticket by its thread (`followupNotices`). */
  | { kind: 'followup'; triggerId: string }

export interface RouterStats {
  /** Turns of the main Session; a turn runs from its first job until it stops with nothing queued. */
  turns: number
  /** Model steps (oracle: one per turn), and how many jobs each step took in (first step: the turn's batch; later: steered). */
  steps: number
  batches: number[]
  items: number
  busySec: number
  refusals: string[]
  /** Model Routers: calls, tokens, and wall-time latency per call. */
  /** Jobs a turn took in and dropped because the model was down (`routerOutage` mode `fail`), by kind. */
  dropped?: Partial<Record<Job['kind'], number>>
  model?: { calls: number; promptTokens: number; cachedTokens: number; completionTokens: number; latencySec: number[]; toolCalls: Record<string, number>; retries?: number }
}
/** What a Router sees of the world: the real Engine and records, virtual time, and jobs steered in while it works. */
export interface RouterWorld {
  readonly engine: Engine
  readonly repo: MemoryRepositories
  readonly settings: Settings
  readonly stats: RouterStats
  readonly options: SimOptions
  /** Every Trigger received and every Decision recorded, in order, for the main Session's list resources. */
  readonly triggers: readonly Trigger[]
  readonly decisionIds: readonly string[]
  now(): number
  /** Lets `sec` of virtual time pass while the Router works; events due meanwhile run, and jobs they queue wait for `takeSteered`. */
  advance(sec: number): void
  /** Jobs queued since the turn started or since the last call. */
  takeSteered(): Job[]
  /** Records that a step took `jobs` into the Router's context; a candidate's Eval deadline starts here. */
  delivered(jobs: Job[]): void
  pump(): void
  /** Runs commands whose events tell the Router nothing it did not do itself (the runtime's `quietly`). */
  quietly<T>(run: () => T): T
  /** Runs a command the main Session issues; a refusal is recorded and returned as its message. */
  command<T>(run: () => T): T | { refused: string }
  /** Oracle only: the scenario's label, and the ticket of a task. */
  truth(triggerId: string): Truth | undefined
  ticketOf(task: string): string | undefined
  random(): number
}
export interface Router { readonly name: string; turn(jobs: Job[], world: RouterWorld): Promise<void> }

/** Ground-truth Router with the article's step-time model; `routerErrorRate` flips a decision. */
export const oracleRouter: Router = {
  name: 'oracle',
  async turn(jobs, world) {
    world.delivered(jobs)
    const outage = world.options.routerOutage
    if (outage && world.now() >= outage.atSec && world.now() < outage.atSec + outage.sec) {
      if (outage.mode === 'stall') world.advance(outage.atSec + outage.sec - world.now())
      else {
        world.advance(world.options.routerBaseSec)
        const dropped = world.stats.dropped ??= {}
        for (const job of jobs) dropped[job.kind] = (dropped[job.kind] ?? 0) + 1
        return
      }
    }
    world.advance(world.options.routerBaseSec + world.options.routerPerItemSec * jobs.length)
    const wrong = () => world.random() < world.options.routerErrorRate
    for (const job of jobs) {
      if (job.kind === 'relay') { world.command(() => world.engine.reply({ purpose: 'result', ticketId: job.ticketId, text: 'Done.' })); continue }
      if (job.kind === 'followup') {
        // Its ticket's worker decides it; the main Session only stops the work when the person asks.
        const label = world.truth(job.triggerId)
        const ticketId = label?.kind === 'probe' && label.task && label.expect[0] === 'stop' ? world.ticketOf(label.task) : undefined
        if (ticketId) world.command(() => world.engine.decide(job.triggerId, { kind: 'stop', ticketId, reason: { code: 'humanStop' } }))
        continue
      }
      const live = world.engine.candidate(job.candidate.triggers[0]!.id)
      if (!live || live.evalId !== job.candidate.evalId) continue
      // Attach follow-ups to their task's ticket first, as dispatch asks: cross-thread ones, and same-thread ones that came
      // back to Eval because their ticket ended before its worker read them.
      const followup = (id: string) => ['cross', 'followup'].includes(world.truth(id)?.kind ?? '')
      for (const trigger of live.triggers) {
        const label = world.truth(trigger.id)
        if (label?.kind !== 'cross' && label?.kind !== 'followup') continue
        const ticketId = world.ticketOf(label.task)
        if (ticketId && !wrong()) world.command(() => world.engine.attach(ticketId, trigger.id))
      }
      const rest = live.triggers.filter(trigger => !followup(trigger.id))
      if (!rest.length) continue
      const probe = world.truth(rest[0]!.id)
      if (probe?.kind === 'probe') {
        const ticketId = probe.task ? world.ticketOf(probe.task) : undefined
        const want = probe.expect[0]!
        if (want === 'attach' && ticketId) { world.command(() => world.engine.attach(ticketId, rest[0]!.id)); continue }
        if (want === 'stop' && ticketId) {
          world.command(() => world.engine.decide(rest[0]!.id, { kind: 'stop', ticketId, reason: { code: 'humanStop' } }))
          continue
        }
        if (want !== 'accept') {
          world.command(() => world.engine.decide(rest[0]!.id, { kind: 'ignore', reason: 'no work asked', evalId: live.evalId }))
          continue
        }
      }
      const request = rest.find(trigger => world.truth(trigger.id)?.kind === 'request')
      const wanted = !!request || (probe?.kind === 'probe' && probe.expect[0] === 'accept')
      const accept = wrong() ? !wanted : wanted
      const head = request ?? rest[0]!
      const label = world.truth(head.id)
      const task = label?.kind === 'request' ? label.task : `new-${head.id}`
      world.command(() => world.engine.decide(head.id, accept
        ? { kind: 'accept', title: task, scope: task, reason: { code: 'explicitRouted' }, acknowledgement: 'On it.', name: 'oracle-task', evalId: live.evalId }
        : { kind: 'ignore', reason: 'no work asked', evalId: live.evalId }))
    }
  },
}

interface Worker {
  ticketId: string; assignmentId: string; remaining: number; resumedAt: number; token: number; busy: boolean; hungAt?: number
  /** When it ran away (`loopRate`), and when its current turn began (`turnBudgetSec`). */
  loopAt?: number; turnAt: number
  /** A restart interrupted its turn: it reads and reports nothing more. */
  gone?: boolean
}
interface RequestStat { triggerId: string; task: string; arrivedAt: number; ackAt?: number; resultAt?: number }
export interface FollowupStat { triggerId: string; kind: 'followup' | 'cross'; task: string; arrivedAt: number; addressed: boolean; ackAt?: number }

/** How each labelled message ended, read from the records after the run; the same for every Router. */
export interface Score {
  requests: { total: number; accepted: number; missed: number; reachedRouter: number }
  /** Tickets created for no request: noise accepted, or a cross-thread follow-up accepted as new work instead of attached. */
  falseTickets: number
  noise: { reachedRouter: number; accepted: number }
  /** Cross-thread follow-ups; `moot` ones did not reach a ticket a person stopped no later than the Router decided them (so right). */
  cross: { total: number; reachedRouter: number; attachedRight: number; attachedWrong: number; acceptedAsNew: number; lost: number; moot: number }
  /** Same-thread follow-ups, and those that reached their task's ticket (by subscription, or in the accepted batch). */
  followups: { total: number; fast: number }
  /**
   * Follow-ups a ticket let go unread when it ended (`Tickets.letGo`), so they went back to Eval: how many, how many then
   * reached the Router, and how many ended on their task's ticket after all.
   */
  released: { total: number; reachedRouter: number; rescued: number; lostAtRouter: number; lostAtGate: number }
  /** Hard cases by kind: how many, how many reached the Router, how many ended as expected, and each outcome's count. */
  probes: Record<string, { total: number; reachedRouter: number; right: number; outcomes: Record<string, number> }>
  /**
   * Stops the Router decided: of the ticket a hard case asked to stop (`expect` has stop), or of any other ticket (a guess;
   * it ends work someone wanted, and a person's stop keeps the ticket from resuming).
   */
  stops: { right: number; wrong: number }
  /**
   * Mistakes weighted by what they cost (`HARM`): a wrong stop loses work someone wanted; a wrong attach subscribes a ticket
   * to a whole thread for good; a false ticket wastes a worker; a lost follow-up or missed request needs saying again.
   */
  harm: number
  /** Per message that reached the Router: what it was and what the Router did with it, for error analysis. */
  routed: { triggerId: string; truth: Truth['kind']; outcome: string; reason?: string; text: string }[]
}

export interface SimResult {
  scenario: string
  router: string
  options: SimOptions
  endSec: number
  requests: RequestStat[]
  followups: FollowupStat[]
  routerStats: RouterStats
  decisions: Record<string, number>
  gateRejected: number
  evals: number
  workers: { peak: number; slotWaitSec: number[] }
  /**
   * Injected hangs: how many, after how long the Watchdog noticed each, how many nobody noticed by the end, the slot-seconds
   * they held (unnoticed ones until the run ended, so a floor), and tickets still waiting for a slot when the run ended.
   */
  faults: { hung: number; detectedSec: number[]; unnoticed: number; slotSec: number; neverStarted: number
    /** Runaway workers (`loopRate`): how many, after how long the turn budget stopped each, how many ran on to the end. */
    looped: number; loopStoppedSec: number[]; loopUnnoticed: number
    /** Healthy turns the budget stopped (false alarms), and hung ones it stopped. */
    healthyStopped: number; hungStopped: number
    /** Host restart: running turns interrupted, and worker seconds done again because a lost Session started over. */
    interrupted: number; redoSec: number }
  score: Score
  errors: string[]
  /** The run's records, for analysis; not serialized. */
  repo?: MemoryRepositories
}

const BASE = Date.UTC(2026, 10, 2, 0, 0, 0)

export async function simulate(scenario: Scenario, options: Partial<SimOptions> = {}, router: Router = oracleRouter): Promise<SimResult> {
  const o = { ...DEFAULT_SIM, ...options }
  const random = rng(o.seed * 7919 + 17)
  let now = 0
  let seq = 0
  const queue: { at: number; seq: number; run: () => void }[] = []
  const later = (delay: number, run: () => void) => {
    const item = { at: now + Math.max(0, delay), seq: seq++, run }
    let i = queue.length
    while (i > 0 && (queue[i - 1]!.at > item.at || (queue[i - 1]!.at === item.at && queue[i - 1]!.seq > item.seq))) i--
    queue.splice(i, 0, item)
  }
  const iso = (sec = now) => new Date(BASE + Math.round(sec * 1000)).toISOString()

  const events = new Map<string, ScenarioEvent>(scenario.events.map(event => [event.id, event]))
  const truth = (id: string) => events.get(id)?.truth
  const stats: RouterStats = { turns: 0, steps: 0, batches: [], items: 0, busySec: 0, refusals: [] }
  const result: SimResult = {
    scenario: scenario.name, router: router.name, options: o, endSec: 0, requests: [], followups: [], routerStats: stats,
    decisions: {}, gateRejected: 0, evals: 0, workers: { peak: 0, slotWaitSec: [] }, faults: { hung: 0, detectedSec: [], unnoticed: 0, slotSec: 0, neverStarted: 0, looped: 0, loopStoppedSec: [], loopUnnoticed: 0, healthyStopped: 0, hungStopped: 0, interrupted: 0, redoSec: 0 }, score: undefined as unknown as Score, errors: [],
  }
  const requests = new Map<string, RequestStat>()
  const followups = new Map<string, FollowupStat>()
  const taskTicket = new Map<string, string>()
  const ticketTask = new Map<string, string>()
  /** Triggers whose card reached the Router. */
  const routed = new Set<string>()
  /** Triggers a ticket let go unread (an Input of a ticket they no longer reach), and those of them whose card then reached the Router. */
  const released = new Set<string>()
  const releasedRouted = new Set<string>()
  const wasLetGo = (triggerId: string) => repo.tickets.list().some(ticket => ticket.inputs.some(input => input.kind === 'trigger'
    && input.triggerId === triggerId) && !repo.triggers.disposition(triggerId)?.fanout.includes(ticket.id))
  const received: Trigger[] = []
  const decisionIds: string[] = []

  // --- Engine with the real settings Policy ---------------------------------------------------------------------
  const settings = SettingsSchema.parse({
    policy: { sources: { [SOURCE]: { allowed: scenario.members.map(id => ({ id })) } } },
    eval: { mode: o.mode, timeoutSeconds: o.evalTimeoutSec },
    executor: { maxWorkers: o.maxWorkers },
  })
  const scope: EngineOptions['scope'] = { scope: () => ({ listened: true, observed: true, row: 'team' }) }
  const policy = settingsPolicy(settings, scope)
  const repo = new MemoryRepositories()
  const sent = new Map<string, OutboundMessage>()
  const outbox: EngineOptions['outbox'] = {
    send: message => {
      if (sent.has(message.id)) return
      sent.set(message.id, message)
      later(0, () => onSent(message))
    },
    status: id => sent.has(id) ? 'sent' : undefined,
    withdraw: () => {},
  }

  // --- Router (main Session) ------------------------------------------------------------------------------------
  const jobs: Job[] = []
  const seenEvals = new Set<string>()
  let routerBusy = false
  let turnDue = false
  const assessor: EngineOptions['assessor'] = {
    request: candidate => {
      for (const trigger of candidate.triggers) if (wasLetGo(trigger.id)) released.add(trigger.id)
      if (seenEvals.has(candidate.evalId)) return
      seenEvals.add(candidate.evalId)
      result.evals++
      later(0, () => { jobs.push({ kind: 'candidate', candidate }); kickRouter() })
    },
    release: evalId => {
      const index = jobs.findIndex(job => job.kind === 'candidate' && job.candidate.evalId === evalId)
      if (index >= 0) jobs.splice(index, 1)
    },
  }
  let holdUntil: number | undefined
  /** Whether queued jobs make a batch: always without forced batching; else `minBatch` of them or the hold has run out. */
  function batchReady(): boolean {
    if (!jobs.length) { holdUntil = undefined; return false }
    if (o.minBatch <= 1 || jobs.length >= o.minBatch) return true
    if (holdUntil === undefined) {
      const until = holdUntil = now + o.batchHoldSec
      later(o.batchHoldSec, () => { if (holdUntil === until) kickRouter() })
    }
    return now >= holdUntil
  }
  function kickRouter() { if (!routerBusy && batchReady()) { holdUntil = undefined; turnDue = true } }
  const world: RouterWorld = {
    get engine() { return engine }, repo, settings, stats, options: o, triggers: received, decisionIds,
    now: () => now,
    advance: sec => { const until = now + Math.max(0, sec); while (queue.length && queue[0]!.at <= until) step(); now = until },
    takeSteered: () => {
      if (!batchReady()) return []
      holdUntil = undefined
      return jobs.splice(0)
    },
    delivered: delivered => {
      stats.steps++
      stats.batches.push(delivered.length)
      stats.items += delivered.length
      for (const job of delivered) {
        if (job.kind === 'followup') routed.add(job.triggerId)
        if (job.kind !== 'candidate') continue
        for (const trigger of job.candidate.triggers) {
          routed.add(trigger.id)
          if (released.has(trigger.id)) releasedRouted.add(trigger.id)
        }
        guard(() => engine.candidateDelivered(job.candidate.evalId))
      }
    },
    pump: () => pump(),
    quietly: run => { quiet++; try { return run() } finally { quiet-- } },
    command: run => {
      try { return run() } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        stats.refusals.push(`${now.toFixed(0)}s ${message}`)
        return { refused: message }
      }
    },
    truth, ticketOf: task => taskTicket.get(task), random,
  }
  async function runTurn() {
    turnDue = false
    routerBusy = true
    stats.turns++
    const start = now
    const batch = jobs.splice(0)
    try { await router.turn(batch, world) } catch (error) { result.errors.push(`${now.toFixed(0)}s router: ${String(error)}`) }
    stats.busySec += now - start
    routerBusy = false
    pump()
    kickRouter()
  }

  // --- Executor (workers) ---------------------------------------------------------------------------------------
  const launchQueue: { ticketId: string; assignmentId: string; queuedAt: number }[] = []
  const workers = new Map<string, Worker>()
  let launching = 0
  /** Assignments taken from the queue and starting (`launchSec`), so a request meanwhile does not queue them again. */
  const inLaunch = new Set<string>()
  const busyCount = () => [...workers.values()].filter(worker => worker.busy).length + launching
  const executor: Executor = {
    // The Engine asks again for an assignment that waits for a slot; one launch per assignment, as the DSH executor keys it.
    start: (ticket, assignment) => later(0, () => {
      if (launchQueue.some(item => item.assignmentId === assignment.id) || inLaunch.has(assignment.id) || workers.get(ticket.id)?.assignmentId === assignment.id) return
      launchQueue.push({ ticketId: ticket.id, assignmentId: assignment.id, queuedAt: now })
      kickLaunch()
    }),
    deliver: ticket => later(0, () => deliverInputs(ticket.id)),
    stop: ticket => later(0, () => { const worker = workers.get(ticket.id); if (worker) { worker.busy = false; worker.token++ } kickLaunch() }),
  }
  const workOf = (task: string | undefined) => {
    const event = task ? requests.get(task) : undefined
    const label = event && truth(event.triggerId)
    return label?.kind === 'request' ? label.workSec : 300
  }
  function kickLaunch() {
    while (launchQueue.length && busyCount() < o.maxWorkers) {
      const next = launchQueue.shift()!
      result.workers.slotWaitSec.push(now - next.queuedAt)
      launching++
      inLaunch.add(next.assignmentId)
      later(o.launchSec, () => {
        launching--
        inLaunch.delete(next.assignmentId)
        const ticket = repo.tickets.get(next.ticketId)
        if (!ticket || ticket.ended || ticket.assignments.at(-1)?.id !== next.assignmentId) { kickLaunch(); return }
        if (!guard(() => engine.assignmentStarted(next.ticketId, next.assignmentId))) { kickLaunch(); return }
        const first = ticket.assignments.length === 1
        // A resumed assignment's worker first reads the Inputs that woke it, so it cannot report before taking them up; one a
        // restart interrupted still has its work left.
        const carried = carry.get(next.ticketId)
        carry.delete(next.ticketId)
        const worker: Worker = { ticketId: next.ticketId, assignmentId: next.assignmentId,
          remaining: first ? workOf(ticketTask.get(next.ticketId)) : (carried ?? 0) + o.workerStepSec + 1,
          resumedAt: now, token: (workers.get(next.ticketId)?.token ?? 0) + 1, busy: true, turnAt: now }
        if (workers.get(next.ticketId)?.assignmentId === next.assignmentId) result.errors.push(`${now.toFixed(0)}s assignment ${next.assignmentId} launched twice`)
        workers.set(next.ticketId, worker)
        result.workers.peak = Math.max(result.workers.peak, busyCount())
        schedule(worker)
        deliverInputs(next.ticketId)
        if (first && o.hangRate > 0 && faultRandom() < o.hangRate) hang(worker, faultRandom() * worker.remaining)
        if (first && o.loopRate > 0 && faultRandom() < o.loopRate) runAway(worker, faultRandom() * worker.remaining)
        budget(worker)
      })
    }
  }
  /** Separate draws, so injecting faults leaves the rest of a run as it was. */
  const faultRandom = rng(o.seed * 7919 + 17)
  /** The worker stops after `afterSec`: it keeps its slot and neither reports nor reads; a Watchdog may notice it. */
  function hang(worker: Worker, afterSec: number) {
    later(afterSec, () => {
      if (!worker.busy || worker.hungAt !== undefined) return
      worker.hungAt = now
      worker.token++
      result.faults.hung++
      const since = now
      if (!o.watchdogSec) return
      later(o.watchdogSec, () => {
        if (worker.hungAt === undefined || !worker.busy) return
        result.faults.detectedSec.push(now - since)
        result.faults.slotSec += now - since
        endTurn(worker, `Watchdog: no activity for ${Math.round(o.watchdogSec / 60)} min; the turn was stopped.`)
      })
    })
  }
  /** Ends a worker's turn as failed (the person is told and may retry) and frees its slot. */
  function endTurn(worker: Worker, summary: string) {
    worker.busy = false
    worker.token++
    const ticket = repo.tickets.get(worker.ticketId)
    if (ticket && !ticket.ended) {
      world.command(() => engine.report(worker.ticketId, { state: 'failed', summary }))
      guard(() => engine.turnEnded(worker.ticketId, worker.assignmentId))
    }
    kickLaunch()
  }
  /** The worker runs away after `afterSec`: busy and reading input, it never converges or reports. */
  function runAway(worker: Worker, afterSec: number) {
    later(afterSec, () => {
      if (!worker.busy || worker.hungAt !== undefined || worker.loopAt !== undefined) return
      worker.loopAt = now
      worker.token++
      result.faults.looped++
    })
  }
  /** Ends the worker's current turn once it has run `turnBudgetSec`, whatever it is doing. */
  function budget(worker: Worker) {
    if (!o.turnBudgetSec) return
    const at = worker.turnAt
    later(o.turnBudgetSec, () => {
      if (!worker.busy || worker.turnAt !== at || workers.get(worker.ticketId) !== worker) return
      if (worker.loopAt !== undefined) { result.faults.loopStoppedSec.push(now - worker.loopAt); result.faults.slotSec += now - worker.loopAt }
      else if (worker.hungAt !== undefined) { result.faults.hungStopped++; result.faults.slotSec += now - worker.hungAt }
      else result.faults.healthyStopped++
      endTurn(worker, `The turn ran past its budget of ${Math.round(o.turnBudgetSec / 60)} min and was stopped.`)
    })
  }
  /** Work left to running turns a restart interrupted, by ticket, for the assignment the Engine starts in their place. */
  const carry = new Map<string, number>()
  function restart() {
    for (const worker of workers.values()) {
      if (!worker.busy || worker.hungAt !== undefined || worker.loopAt !== undefined) continue
      const ticket = repo.tickets.get(worker.ticketId)
      if (!ticket || ticket.ended || runningAssignment(ticket)?.id !== worker.assignmentId) continue
      const done = now - worker.resumedAt
      const left = Math.max(0, worker.remaining - done)
      worker.busy = false
      worker.gone = true
      worker.token++
      result.faults.interrupted++
      // A kept Session goes on where it stopped; a lost one starts the assignment over (an upper bound: its files remain).
      const total = left + (o.sessionLost ? done : 0)
      if (o.sessionLost) result.faults.redoSec += done
      carry.set(worker.ticketId, total)
      guard(() => engine.assignmentInterrupted(worker.ticketId, worker.assignmentId))
      // The Engine kept the assignment (its worker had reported and read nothing since): its Session goes on with it.
      if (runningAssignment(repo.tickets.get(worker.ticketId)!)?.id === worker.assignmentId) {
        carry.delete(worker.ticketId)
        Object.assign(worker, { gone: false, busy: true, remaining: total })
        schedule(worker)
      }
    }
    kickLaunch()
  }
  function schedule(worker: Worker) {
    const token = ++worker.token
    worker.resumedAt = now
    later(worker.remaining, () => {
      if (worker.token !== token || !worker.busy) return
      worker.remaining = 0
      worker.busy = false
      const ticket = repo.tickets.get(worker.ticketId)
      if (ticket && !ticket.ended) {
        const summary = `Done: ${ticket.title}. Changes are in a pull request, checks pass.`
        world.command(() => engine.report(worker.ticketId, { state: 'ready', summary }))
        guard(() => engine.turnEnded(worker.ticketId, worker.assignmentId))
        jobs.push({ kind: 'relay', ticketId: worker.ticketId, summary })
        kickRouter()
      }
      kickLaunch()
    })
  }
  function deliverInputs(ticketId: string) {
    const ticket = repo.tickets.get(ticketId)
    const worker = workers.get(ticketId)
    const assignment = ticket && runningAssignment(ticket)
    if (!ticket || !worker || worker.hungAt !== undefined || worker.gone || !assignment || assignment.id !== worker.assignmentId || !ticket.undelivered.length) return
    const inputIds = [...ticket.undelivered]
    if (!guard(() => engine.inputsDelivered(ticketId, assignment.id, inputIds))) return
    later(o.workerStepSec, () => {
      // A worker that hung or was interrupted meanwhile reads nothing more.
      if (worker.hungAt !== undefined || worker.gone) return
      guard(() => engine.inputsRead(ticketId, inputIds))
      const current = repo.tickets.get(ticketId)!
      let extra = 0
      for (const input of current.inputs) {
        if (input.kind !== 'trigger' || !inputIds.includes(input.id)) continue
        const label = truth(input.triggerId)
        if (!label || label.kind === 'noise' || label.kind === 'request') continue
        extra += label.extraSec
        if (input.human && !current.ended && !('refused' in (world.command(() =>
          engine.reply({ purpose: 'acknowledgement', ticketId, triggerId: input.triggerId, text: 'Will do.' })) as object))) {
          const stat = followups.get(input.triggerId)
          if (stat && stat.ackAt === undefined) stat.ackAt = now
        }
      }
      if (!extra || worker.loopAt !== undefined) return
      // Work arriving after a ready report reopens the worker's turn; otherwise it extends the current one.
      if (worker.busy) worker.remaining = Math.max(0, worker.remaining - (now - worker.resumedAt)) + extra
      else {
        worker.busy = true; worker.remaining = extra; worker.turnAt = now
        result.workers.peak = Math.max(result.workers.peak, busyCount())
        budget(worker)
      }
      schedule(worker)
    })
  }

  // --- Engine ---------------------------------------------------------------------------------------------------
  /** Commands run `quietly` (see `RouterWorld.quietly`), and the follow-ups already told to the Router. */
  let quiet = 0
  const told = new Set<string>()
  const emit = (event: DomainEvent) => {
    if (o.followupNotices && !quiet && (event.type === 'trigger.received' || event.type === 'ticket.resumed' || event.type === 'trigger.followup')) {
      const triggerId = event.data.triggerId
      // As the runtime: a person's message that a live ticket's worker decides, told once.
      later(0, () => {
        const trigger = repo.triggers.get(triggerId)
        const fanout = repo.triggers.disposition(triggerId)?.fanout ?? []
        if (!trigger || told.has(triggerId) || !followupOwners(trigger, repo).length) return
        if (!fanout.some(id => { const ticket = repo.tickets.get(id); return ticket && liveTicket(ticket) })) return
        told.add(triggerId)
        jobs.push({ kind: 'followup', triggerId })
        kickRouter()
      })
    }
    if (event.type === 'decision.recorded') {
      result.decisions[event.data.kind] = (result.decisions[event.data.kind] ?? 0) + 1
      decisionIds.push(event.data.decisionId)
      const decision = repo.decisions.get(event.data.decisionId)
      // Unavailable for want of the Router (its Evals ran out of requeues), not because a ticket took the messages meanwhile.
      if (decision?.kind === 'unavailable' && JSON.stringify(decision.reason).includes('"timeout"')) result.decisions.timeout = (result.decisions.timeout ?? 0) + decision.triggerIds.length
      for (const id of decision?.triggerIds ?? []) if (wasLetGo(id)) released.add(id)
      // An ignore whose Eval never reached the Router is the gate's (program layer) refusal.
      if (decision?.kind === 'ignore' && !seenEvals.has(decision.evalId)) result.gateRejected += decision.triggerIds.length
    }
    if (event.type === 'ticket.created') {
      const decision = repo.decisions.get(event.data.decisionId)
      const request = decision?.triggerIds.map(id => truth(id)).find(label => label?.kind === 'request')
      const task = request?.kind === 'request' ? request.task : `false-${event.data.ticketId}`
      if (!taskTicket.has(task)) taskTicket.set(task, event.data.ticketId)
      ticketTask.set(event.data.ticketId, task)
    }
  }
  const engine = new Engine({ repo, scope, policy: () => policy, assessor, executor, outbox, emit, now: () => iso() })

  function onSent(message: OutboundMessage) {
    const task = message.ticketId ? ticketTask.get(message.ticketId) : undefined
    const stat = task ? requests.get(task) : undefined
    if (!stat) return
    if (message.kind === 'acknowledgement' && message.id === key('ack', stat.triggerId) && stat.ackAt === undefined) stat.ackAt = now
    if (message.kind === 'reply' && stat.resultAt === undefined) stat.resultAt = now
  }
  function guard(run: () => void): boolean {
    try { run(); return true } catch (error) { result.errors.push(`${now.toFixed(0)}s ${String(error)}`); return false }
  }
  function pump() { guard(() => engine.evaluateDue()) }

  function receive(event: ScenarioEvent) {
    const trigger: Trigger = {
      id: event.id, source: SOURCE, threads: [{ source: SOURCE, id: event.thread }], actor: { source: SOURCE, id: event.actor }, human: event.human,
      at: iso(), text: event.text, ...(event.addressed ? { addressed: 'mention' as const } : {}),
      ...(event.human ? { channel: { source: SOURCE, thread: `${SOURCE}:${event.thread}`, address: { message: event.id } } } : {}), meta: {},
    }
    const label = event.truth
    if (label.kind === 'request') requests.set(label.task, { triggerId: event.id, task: label.task, arrivedAt: now })
    if (label.kind === 'followup' || label.kind === 'cross') {
      followups.set(event.id, { triggerId: event.id, kind: label.kind, task: label.task, arrivedAt: now, addressed: event.addressed })
    }
    received.push(trigger)
    guard(() => engine.receive(trigger))
    pump()
  }

  // --- Run ------------------------------------------------------------------------------------------------------
  for (const event of scenario.events) {
    const delay = o.pollSec ? random() * o.pollSec : 0
    queue.push({ at: event.at + delay, seq: seq++, run: () => receive(event) })
  }
  queue.sort((a, b) => a.at - b.at || a.seq - b.seq)
  const lastArrival = Math.max(...queue.map(item => item.at))
  const tick = () => { pump(); if (now < lastArrival || queue.length) later(o.tickSec, tick) }
  later(0, tick)
  if (o.restartAtSec) later(o.restartAtSec, restart)
  function step() {
    const item = queue.shift()!
    now = Math.max(now, item.at)
    item.run()
  }
  let steps = 0
  while ((queue.length || turnDue) && steps++ < 5_000_000) {
    if (turnDue) { await runTurn(); continue }
    step()
    if (!turnDue && !routerBusy && !queue.some(next => next.run !== tick) && now > lastArrival) break
  }
  result.endSec = now
  for (const worker of workers.values()) {
    if (!worker.busy) continue
    if (worker.hungAt !== undefined) { result.faults.unnoticed++; result.faults.slotSec += now - worker.hungAt }
    else if (worker.loopAt !== undefined) { result.faults.loopUnnoticed++; result.faults.slotSec += now - worker.loopAt }
  }
  result.faults.neverStarted = launchQueue.length
  result.requests = [...requests.values()]
  result.followups = [...followups.values()]
  result.score = score(scenario, repo, routed, taskTicket, released, releasedRouted)
  Object.defineProperty(result, 'repo', { value: repo, enumerable: false })
  return result
}

/** Reads how every labelled message ended from the records, whatever Router decided it. */
/** Weights of `Score.harm`, by what a mistake costs the team. */
export const HARM = { wrongStop: 5, wrongAttach: 3, falseTicket: 2, lost: 2, other: 1 }

export function score(scenario: Scenario, repo: MemoryRepositories, routed: ReadonlySet<string>, taskTicket: ReadonlyMap<string, string>,
  released: ReadonlySet<string> = new Set(), releasedRouted: ReadonlySet<string> = new Set()): Score {
  const s: Score = {
    requests: { total: 0, accepted: 0, missed: 0, reachedRouter: 0 }, falseTickets: 0, noise: { reachedRouter: 0, accepted: 0 },
    cross: { total: 0, reachedRouter: 0, attachedRight: 0, attachedWrong: 0, acceptedAsNew: 0, lost: 0, moot: 0 }, followups: { total: 0, fast: 0 },
    probes: {}, stops: { right: 0, wrong: 0 }, harm: 0, routed: [], released: { total: 0, reachedRouter: 0, rescued: 0, lostAtRouter: 0, lostAtGate: 0 },
  }
  const decisionOf = (id: string) => {
    const decisionId = repo.triggers.disposition(id)?.decisionId
    return decisionId ? repo.decisions.get(decisionId) : undefined
  }
  const requestTickets = new Set<string>()
  /** When a person's stop (a hard case that asked for it) ended each task's ticket. */
  const personStop = new Map<string, string>()
  for (const event of scenario.events) {
    const label = event.truth
    const decision = decisionOf(event.id)
    if (label.kind !== 'probe' || !label.task || !label.expect.includes('stop') || decision?.kind !== 'stop') continue
    if (decision.ticketId !== taskTicket.get(label.task)) continue
    const earlier = personStop.get(label.task)
    if (!earlier || decision.at < earlier) personStop.set(label.task, decision.at)
  }
  let otherProbeErrors = 0
  let wrongAttaches = 0
  /** Tickets a hard case rightly started (new work phrased indirectly, or on a similar subject); not false. */
  const probeTickets = new Set<string>()
  for (const event of scenario.events) {
    const disposition = repo.triggers.disposition(event.id)
    const decision = decisionOf(event.id)
    // The tickets it reached: those it still reaches, and those whose worker took it up (acknowledged it), since a ticket
    // that ended lets go of the messages it holds even when its worker read them.
    const fanout = [...new Set([...disposition?.fanout ?? [], ...disposition?.acked ?? []])]
    const label = event.truth
    const reached = routed.has(event.id)
    const outcome = decision?.kind === 'accept' ? `accept → ${decision.ticketId}` : fanout.length ? `reached ${fanout.join(',')}` : decision?.kind ?? 'none'
    const reason = decision ? reasonText(decision.reason) : undefined
    if (reached) s.routed.push({ triggerId: event.id, truth: label.kind, outcome, ...reason ? { reason } : {}, text: event.text })
    if (decision?.kind === 'stop') {
      const asked = label.kind === 'probe' && label.expect.includes('stop') && label.task && decision.ticketId === taskTicket.get(label.task)
      s.stops[asked ? 'right' : 'wrong']++
    }
    if (label.kind === 'request') {
      s.requests.total++
      if (reached) s.requests.reachedRouter++
      const ticketId = decision?.kind === 'accept' ? decision.ticketId : fanout[0]
      if (ticketId) { s.requests.accepted++; requestTickets.add(ticketId) } else s.requests.missed++
    } else if (label.kind === 'noise') {
      if (reached) s.noise.reachedRouter++
      if (decision?.kind === 'accept' && decision.triggerIds[0] === event.id) s.noise.accepted++
    } else if (label.kind === 'cross') {
      s.cross.total++
      if (reached) s.cross.reachedRouter++
      const right = taskTicket.get(label.task)
      if (decision?.kind === 'accept' && decision.ticketId !== right) s.cross.acceptedAsNew++
      else if (right && fanout.includes(right)) s.cross.attachedRight++
      else if (fanout.length) s.cross.attachedWrong++
      else if (personStop.has(label.task) && (!decision || decision.at >= personStop.get(label.task)!)) s.cross.moot++
      else s.cross.lost++
    } else if (label.kind === 'probe') {
      const tally = s.probes[label.probe] ??= { total: 0, reachedRouter: 0, right: 0, outcomes: {} }
      tally.total++
      if (reached) tally.reachedRouter++
      const right = label.task ? taskTicket.get(label.task) : undefined
      let ended: ProbeOutcome | 'attach-wrong' | 'stop-wrong' | 'expired'
      if (decision?.kind === 'stop') ended = decision.ticketId === right ? 'stop' : 'stop-wrong'
      else if (decision?.kind === 'accept' && decision.ticketId !== right) ended = 'accept'
      else if (right && fanout.includes(right)) ended = 'attach'
      else if (fanout.length) ended = 'attach-wrong'
      else if (decision?.kind === 'unavailable' || !decision) ended = 'expired'
      else ended = 'ignore'
      tally.outcomes[ended] = (tally.outcomes[ended] ?? 0) + 1
      // A wrong stop, attach or accept is weighed as such (a wrong accept as a false ticket); any other wrong outcome weighs 1.
      if (ended === 'attach-wrong') wrongAttaches++
      else if (!(label.expect as string[]).includes(ended) && ended !== 'accept' && ended !== 'stop-wrong') otherProbeErrors++
      if ((label.expect as string[]).includes(ended)) {
        tally.right++
        if (ended === 'accept' && decision?.ticketId) probeTickets.add(decision.ticketId)
      }
    } else if (label.kind === 'followup') {
      s.followups.total++
      // It reached the ticket by subscription, or arrived before the accept and went into the ticket with its request's batch.
      const ticketId = taskTicket.get(label.task) ?? ''
      if (fanout.includes(ticketId) || decision?.ticketId === ticketId) s.followups.fast++
    }
  }
  for (const ticket of repo.tickets.list()) if (!requestTickets.has(ticket.id) && !probeTickets.has(ticket.id)) s.falseTickets++
  s.harm = HARM.wrongStop * s.stops.wrong + HARM.wrongAttach * (s.cross.attachedWrong + wrongAttaches) + HARM.falseTicket * s.falseTickets
    + HARM.lost * (s.cross.lost + s.requests.missed) + HARM.other * otherProbeErrors
  for (const event of scenario.events) {
    const label = event.truth
    if (!released.has(event.id) || (label.kind !== 'cross' && label.kind !== 'followup')) continue
    s.released.total++
    const right = taskTicket.get(label.task)
    const reached = releasedRouted.has(event.id)
    if (reached) s.released.reachedRouter++
    const disposition = repo.triggers.disposition(event.id)
    if (right && (disposition?.fanout.includes(right) || disposition?.acked?.includes(right))) s.released.rescued++
    else if (reached) s.released.lostAtRouter++
    else s.released.lostAtGate++
  }
  return s
}
