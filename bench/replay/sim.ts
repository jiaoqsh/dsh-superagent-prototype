/**
 * Discrete-event replay of a Scenario through the real core Engine and the real settings Policy (gate), on a virtual clock.
 *
 * Modelled, not real: the main Session (Router) is one server that takes every queued card into its next step, with step
 * time `routerBaseSec + routerPerItemSec × items` (defaults fit the article's §7.2 numbers: 2.5 s at 1 item, 3.9 s at 2.8);
 * its decisions come from the scenario's ground truth, flipped with probability `routerErrorRate`. Workers take
 * `launchSec` to start, hold one of `maxWorkers` slots until their turn ends, read delivered inputs after `workerStepSec`,
 * and work for the time the scenario gives. Source polling latency is `pollSec` (0 = push).
 *
 * So a run measures the system's scheduling and routing mechanics, not model judgement or code quality.
 */
import { Engine, MemoryRepositories, followupOwners, key, runningAssignment } from '../../src/core/index.ts'
import type { Candidate, DomainEvent, EngineOptions, Executor, OutboundMessage, Trigger } from '../../src/core/index.ts'
import { SettingsSchema, settingsPolicy } from '../../src/policy.ts'
import { rng, type Scenario, type ScenarioEvent, type Truth } from './scenario.ts'

export interface SimOptions {
  seed: number
  maxWorkers: number
  routerBaseSec: number
  routerPerItemSec: number
  /** Probability that the simulated Router decides a candidate wrongly (accepts noise, ignores a request, misses an attach). */
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
}
export const DEFAULT_SIM: SimOptions = {
  seed: 1, maxWorkers: 3, routerBaseSec: 1.72, routerPerItemSec: 0.78, routerErrorRate: 0, launchSec: 30, workerStepSec: 15,
  pollSec: 0, tickSec: 2, evalTimeoutSec: 120, mode: 'off',
}

type Job = { kind: 'candidate'; candidate: Candidate } | { kind: 'relay'; ticketId: string }
interface Worker { ticketId: string; assignmentId: string; remaining: number; resumedAt: number; token: number; busy: boolean }
interface RequestStat { triggerId: string; task: string; arrivedAt: number; ackAt?: number; resultAt?: number }

export interface SimResult {
  scenario: string
  options: SimOptions
  endSec: number
  requests: RequestStat[]
  followups: { triggerId: string; kind: 'followup' | 'cross'; task: string; arrivedAt: number; path: 'fast' | 'router' | 'lost'; ackAt?: number }[]
  router: { steps: number; items: number; batches: number[]; busySec: number; candidateItems: number; relayItems: number; refusals: string[] }
  decisions: Record<string, number>
  gateRejected: number
  evals: number
  workers: { peak: number; slotWaitSec: number[] }
  mistakes: { falseAccepts: number; missedRequests: number; missedAttaches: number }
  errors: string[]
}

const BASE = Date.UTC(2026, 10, 2, 0, 0, 0)

export function simulate(scenario: Scenario, options: Partial<SimOptions> = {}): SimResult {
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

  const truth = new Map<string, Truth>(scenario.events.map(event => [event.id, event.truth]))
  const result: SimResult = {
    scenario: scenario.name, options: o, endSec: 0, requests: [], followups: [],
    router: { steps: 0, items: 0, batches: [], busySec: 0, candidateItems: 0, relayItems: 0, refusals: [] },
    decisions: {}, gateRejected: 0, evals: 0, workers: { peak: 0, slotWaitSec: [] },
    mistakes: { falseAccepts: 0, missedRequests: 0, missedAttaches: 0 }, errors: [],
  }
  const requests = new Map<string, RequestStat>()
  const followups = new Map<string, SimResult['followups'][number]>()
  const taskTicket = new Map<string, string>()
  const ticketTask = new Map<string, string>()

  // --- Engine with the real settings Policy ---------------------------------------------------------------------
  const settings = SettingsSchema.parse({
    policy: { sources: { chat: { allowed: scenario.members.map(id => ({ id })) } } },
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
  const assessor: EngineOptions['assessor'] = {
    request: candidate => {
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
  function kickRouter() {
    if (routerBusy || !jobs.length) return
    const batch = jobs.splice(0)
    routerBusy = true
    for (const job of batch) if (job.kind === 'candidate') guard(() => engine.candidateDelivered(job.candidate.evalId))
    const duration = o.routerBaseSec + o.routerPerItemSec * batch.length
    result.router.steps++
    result.router.items += batch.length
    result.router.batches.push(batch.length)
    result.router.busySec += duration
    later(duration, () => {
      for (const job of batch) {
        if (job.kind === 'candidate') { result.router.candidateItems++; routeCandidate(job.candidate) }
        else { result.router.relayItems++; refuse(() => engine.reply({ purpose: 'result', ticketId: job.ticketId, text: 'Done.' })) }
      }
      routerBusy = false
      pump()
      kickRouter()
    })
  }
  const wrong = () => random() < o.routerErrorRate
  function routeCandidate(candidate: Candidate) {
    const live = engine.candidate(candidate.triggers[0]!.id)
    if (!live || live.evalId !== candidate.evalId) return
    const triggers = live.triggers
    // Attach cross-thread follow-ups to their task's ticket first, as the dispatch prompt asks.
    for (const trigger of triggers) {
      const label = truth.get(trigger.id)
      if (label?.kind !== 'cross') continue
      const ticketId = taskTicket.get(label.task)
      if (!ticketId || wrong()) { result.mistakes.missedAttaches++; markFollowup(trigger.id, 'lost'); continue }
      if (refuse(() => engine.attach(ticketId, trigger.id))) markFollowup(trigger.id, 'router')
      else markFollowup(trigger.id, 'lost')
    }
    const rest = triggers.filter(trigger => truth.get(trigger.id)?.kind !== 'cross')
    if (!rest.length) return
    const request = rest.find(trigger => truth.get(trigger.id)?.kind === 'request')
    let accept = !!request
    if (wrong()) accept = !accept
    const head = request ?? rest[0]!
    if (accept) {
      const label = truth.get(head.id)
      const task = label?.kind === 'request' ? label.task : `false-${head.id}`
      if (label?.kind !== 'request') result.mistakes.falseAccepts++
      refuse(() => engine.decide(head.id, { kind: 'accept', title: task, scope: task, reason: { code: 'explicitRouted' }, acknowledgement: 'On it.',
        name: task, evalId: live.evalId }))
    } else {
      if (request) result.mistakes.missedRequests++
      refuse(() => engine.decide(head.id, { kind: 'ignore', reason: 'no work asked', evalId: live.evalId }))
    }
  }

  // --- Executor (workers) ---------------------------------------------------------------------------------------
  const launchQueue: { ticketId: string; assignmentId: string; queuedAt: number }[] = []
  const workers = new Map<string, Worker>()
  const busyCount = () => [...workers.values()].filter(worker => worker.busy).length + launching
  let launching = 0
  const executor: Executor = {
    start: (ticket, assignment) => later(0, () => { launchQueue.push({ ticketId: ticket.id, assignmentId: assignment.id, queuedAt: now }); kickLaunch() }),
    deliver: ticket => later(0, () => deliverInputs(ticket.id)),
    stop: ticket => later(0, () => { const worker = workers.get(ticket.id); if (worker) { worker.busy = false; worker.token++ } kickLaunch() }),
  }
  function kickLaunch() {
    while (launchQueue.length && busyCount() < o.maxWorkers) {
      const next = launchQueue.shift()!
      result.workers.slotWaitSec.push(now - next.queuedAt)
      launching++
      later(o.launchSec, () => {
        launching--
        const ticket = repo.tickets.get(next.ticketId)
        if (!ticket || ticket.ended || runningAssignment(ticket)?.id !== next.assignmentId && ticket.assignments.at(-1)?.id !== next.assignmentId) { kickLaunch(); return }
        if (!guard(() => engine.assignmentStarted(next.ticketId, next.assignmentId))) { kickLaunch(); return }
        const task = ticketTask.get(next.ticketId)
        const first = ticket.assignments.length === 1
        const work = first && task ? (requestOf(task)?.workSec ?? 300) : 0
        const worker: Worker = { ticketId: next.ticketId, assignmentId: next.assignmentId, remaining: work, resumedAt: now,
          token: (workers.get(next.ticketId)?.token ?? 0) + 1, busy: true }
        workers.set(next.ticketId, worker)
        result.workers.peak = Math.max(result.workers.peak, busyCount())
        schedule(worker)
        deliverInputs(next.ticketId)
      })
    }
  }
  const requestOf = (task: string) => {
    for (const label of truth.values()) if (label.kind === 'request' && label.task === task) return label
    return undefined
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
        refuse(() => engine.report(worker.ticketId, { state: 'ready', summary: 'Done.' }))
        guard(() => engine.turnEnded(worker.ticketId, worker.assignmentId))
        jobs.push({ kind: 'relay', ticketId: worker.ticketId })
        kickRouter()
      }
      kickLaunch()
    })
  }
  function deliverInputs(ticketId: string) {
    const ticket = repo.tickets.get(ticketId)
    const worker = workers.get(ticketId)
    const assignment = ticket && runningAssignment(ticket)
    if (!ticket || !worker || !assignment || assignment.id !== worker.assignmentId || !ticket.undelivered.length) return
    const inputIds = [...ticket.undelivered]
    if (!guard(() => engine.inputsDelivered(ticketId, assignment.id, inputIds))) return
    later(o.workerStepSec, () => {
      guard(() => engine.inputsRead(ticketId, inputIds))
      const current = repo.tickets.get(ticketId)!
      let extra = 0
      for (const input of current.inputs) {
        if (input.kind !== 'trigger' || !inputIds.includes(input.id)) continue
        const label = truth.get(input.triggerId)
        if (!label || label.kind === 'noise' || label.kind === 'request') continue
        extra += label.extraSec
        if (input.human && !current.ended) {
          if (refuse(() => engine.reply({ purpose: 'acknowledgement', ticketId, triggerId: input.triggerId, text: 'Will do.' }))) {
            const stat = followups.get(input.triggerId)
            if (stat && stat.ackAt === undefined) stat.ackAt = now
          }
        }
      }
      if (!extra) return
      // Work arriving after a ready report reopens the worker's turn; otherwise it extends the current one.
      if (worker.busy) worker.remaining = Math.max(0, worker.remaining - (now - worker.resumedAt)) + extra
      else { worker.busy = true; worker.remaining = extra; result.workers.peak = Math.max(result.workers.peak, busyCount()) }
      schedule(worker)
    })
  }

  // --- Engine ---------------------------------------------------------------------------------------------------
  const emit = (event: DomainEvent) => {
    if (event.type === 'decision.recorded') {
      result.decisions[event.data.kind] = (result.decisions[event.data.kind] ?? 0) + 1
      const decision = repo.decisions.get(event.data.decisionId)
      // An ignore whose Eval never reached the Router is the gate's (program layer) refusal.
      if (decision?.kind === 'ignore' && !seenEvals.has(decision.evalId)) result.gateRejected += decision.triggerIds.length
    }
    if (event.type === 'ticket.created') {
      const decision = repo.decisions.get(event.data.decisionId)
      const request = decision?.triggerIds.map(id => truth.get(id)).find(label => label?.kind === 'request')
      const task = request?.kind === 'request' ? request.task : `false-${event.data.ticketId}`
      taskTicket.set(task, event.data.ticketId)
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
  /** Runs a command a model would issue; a refusal is the answer it would get, not a simulator error. */
  function refuse(run: () => unknown): boolean {
    try { run(); return true } catch (error) { result.router.refusals.push(`${now.toFixed(0)}s ${error instanceof Error ? error.message : String(error)}`); return false }
  }
  function markFollowup(triggerId: string, path: 'fast' | 'router' | 'lost') {
    const stat = followups.get(triggerId)
    if (stat) stat.path = path
  }
  function pump() { guard(() => engine.evaluateDue()) }

  function receive(event: ScenarioEvent) {
    const trigger: Trigger = {
      id: event.id, source: 'chat', threads: [{ source: 'chat', id: event.thread }], actor: { source: 'chat', id: event.actor }, human: event.human,
      at: iso(), text: event.text, ...(event.addressed ? { addressed: 'mention' as const } : {}),
      ...(event.human ? { channel: { source: 'chat', thread: event.thread, address: { message: event.id } } } : {}), meta: {},
    }
    const label = event.truth
    if (label.kind === 'request') requests.set(label.task, { triggerId: event.id, task: label.task, arrivedAt: event.at })
    if (label.kind === 'followup' || label.kind === 'cross') followups.set(event.id, { triggerId: event.id, kind: label.kind, task: label.task, arrivedAt: event.at, path: 'lost' })
    guard(() => engine.receive(trigger))
    if (event.human && followupOwners(trigger, repo).length) markFollowup(event.id, 'fast')
    pump()
  }

  // --- Run ------------------------------------------------------------------------------------------------------
  for (const event of scenario.events) {
    const delay = o.pollSec ? random() * o.pollSec : 0
    const at = event.at + delay
    queue.push({ at, seq: seq++, run: () => receive(event) })
  }
  queue.sort((a, b) => a.at - b.at || a.seq - b.seq)
  const lastArrival = Math.max(...queue.map(item => item.at))
  const tick = () => { pump(); if (now < lastArrival || queue.length) later(o.tickSec, tick) }
  later(0, tick)
  let guardSteps = 0
  while (queue.length && guardSteps++ < 2_000_000) {
    const item = queue.shift()!
    now = item.at
    item.run()
    if (!queue.some(next => next.run !== tick) && now > lastArrival) break
  }
  result.endSec = now
  result.requests = [...requests.values()]
  result.followups = [...followups.values()]
  return result
}
