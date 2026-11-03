/**
 * Runs replay experiments and prints a report.
 *
 *   node --experimental-transform-types --no-warnings bench/replay/run.ts <experiment> [--json] [--runs N] [--out file.json]
 *
 * Oracle experiments (deterministic, free): baseline, sweep-rate, sweep-router, sweep-workers, sweep-errors, sweep-poll, sweep-cross.
 * Model experiments (call the API in DEEPSEEK_API_KEY, model ROUTER_MODEL or deepseek-flash): model-small, model-burst,
 * model-hard (oracle and every model in ROUTER_MODELS, default deepseek-flash,deepseek-v4-pro), model-saturation, model-batch,
 * model-released, model-prompt, model-stop.
 * Model runs of one row run their seeds concurrently.
 */
import { writeFile } from 'node:fs/promises'
import { HARD_ORDER } from './corpus.ts'
import { PROBE_EXPECT, generate, type GenerateOptions } from './scenario.ts'
import { simulate, oracleRouter, type Router, type SimOptions, type SimResult } from './sim.ts'
import { loadEnv, modelRouter } from './llm-router.ts'

const quantile = (values: number[], q: number) => {
  if (!values.length) return NaN
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!
}
const min = (sec: number) => Number.isNaN(sec) ? '—' : `${(sec / 60).toFixed(1)}m`
const s = (sec: number) => Number.isNaN(sec) ? '—' : `${sec.toFixed(1)}s`
const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : NaN
const sum = <T>(items: T[], value: (item: T) => number) => items.reduce((a, item) => a + value(item), 0)

export interface Summary {
  label: string
  runs: number
  requests: number; accepted: number; completed: number
  ackP50: number; ackP95: number; resultP50: number; resultP95: number
  followFast: number; followTotal: number
  cross: SimResult['score']['cross']
  noiseAtRouter: number; noiseAccepted: number; falseTickets: number
  routerTurns: number; routerSteps: number; meanBatch: number; maxBatch: number; routerBusy: number; perItemSec: number
  evals: number; gateRejected: number; unavailable: number; refusals: number
  peakWorkers: number; slotWaitP95: number
  /** Hard cases by kind, pooled over runs. */
  probes: Record<string, { total: number; reachedRouter: number; right: number; outcomes: Record<string, number> }>
  /** Addressed messages per minute within the generation window: the peak rate offered to the Router. */
  cardsPerMin: number
  released: SimResult['score']['released']
  stops: SimResult['score']['stops']
  /** `Score.harm`, pooled, and hard cases right per seed (the spread between runs). */
  harm: number
  probeSeeds: number[]
  model?: { calls: number; promptTokens: number; cachedTokens: number; completionTokens: number; latencyP50: number; latencyP95: number; toolCalls: Record<string, number>; retries: number; slowCalls: number }
  errors: string[]
}
/** A model call slower than this hints the API was overloaded; its wall time passed on the virtual clock. */
const SLOW_CALL_SEC = 30

export function summarize(label: string, results: (SimResult & { window?: number; arrivals?: number })[]): Summary {
  const requests = results.flatMap(r => r.requests)
  const acks = requests.flatMap(r => r.ackAt !== undefined ? [r.ackAt - r.arrivedAt] : [])
  const done = requests.flatMap(r => r.resultAt !== undefined ? [r.resultAt - r.arrivedAt] : [])
  const stats = results.map(r => r.routerStats)
  const models = stats.flatMap(st => st.model ? [st.model] : [])
  const cross = { total: 0, reachedRouter: 0, attachedRight: 0, attachedWrong: 0, acceptedAsNew: 0, lost: 0, moot: 0 }
  for (const r of results) for (const k of Object.keys(cross) as (keyof typeof cross)[]) cross[k] += r.score.cross[k]
  const probes: Summary['probes'] = {}
  for (const r of results) for (const [kind, tally] of Object.entries(r.score.probes)) {
    const into = probes[kind] ??= { total: 0, reachedRouter: 0, right: 0, outcomes: {} }
    into.total += tally.total; into.reachedRouter += tally.reachedRouter; into.right += tally.right
    for (const [outcome, n] of Object.entries(tally.outcomes)) into.outcomes[outcome] = (into.outcomes[outcome] ?? 0) + n
  }
  const released = { total: 0, reachedRouter: 0, rescued: 0, lostAtRouter: 0, lostAtGate: 0 }
  for (const r of results) for (const k of Object.keys(released) as (keyof typeof released)[]) released[k] += r.score.released[k]
  return {
    label, runs: results.length, probes, released,
    stops: { right: sum(results, r => r.score.stops.right), wrong: sum(results, r => r.score.stops.wrong) },
    harm: sum(results, r => r.score.harm),
    probeSeeds: results.map(r => Object.values(r.score.probes).reduce((n, t) => n + t.right, 0)),
    cardsPerMin: sum(results, r => r.arrivals ?? 0) / Math.max(1, sum(results, r => r.window ?? 1)),
    requests: requests.length, accepted: sum(results, r => r.score.requests.accepted), completed: done.length,
    ackP50: quantile(acks, 0.5), ackP95: quantile(acks, 0.95), resultP50: quantile(done, 0.5), resultP95: quantile(done, 0.95),
    followFast: sum(results, r => r.score.followups.fast), followTotal: sum(results, r => r.score.followups.total), cross,
    noiseAtRouter: sum(results, r => r.score.noise.reachedRouter), noiseAccepted: sum(results, r => r.score.noise.accepted),
    falseTickets: sum(results, r => r.score.falseTickets),
    routerTurns: sum(stats, st => st.turns), routerSteps: sum(stats, st => st.steps),
    meanBatch: mean(stats.flatMap(st => st.batches.filter(n => n > 0))), maxBatch: Math.max(0, ...stats.flatMap(st => st.batches)),
    routerBusy: sum(stats, st => st.busySec) / Math.max(1, sum(results, r => r.endSec)),
    perItemSec: sum(stats, st => st.busySec) / Math.max(1, sum(stats, st => st.items)),
    evals: sum(results, r => r.evals), gateRejected: sum(results, r => r.gateRejected), unavailable: sum(results, r => r.decisions.unavailable ?? 0),
    refusals: sum(stats, st => st.refusals.length),
    peakWorkers: Math.max(...results.map(r => r.workers.peak)), slotWaitP95: quantile(results.flatMap(r => r.workers.slotWaitSec), 0.95),
    ...models.length ? { model: {
      calls: sum(models, m => m.calls), promptTokens: sum(models, m => m.promptTokens), cachedTokens: sum(models, m => m.cachedTokens),
      completionTokens: sum(models, m => m.completionTokens),
      latencyP50: quantile(models.flatMap(m => m.latencySec), 0.5), latencyP95: quantile(models.flatMap(m => m.latencySec), 0.95),
      toolCalls: models.reduce<Record<string, number>>((a, m) => { for (const [k, v] of Object.entries(m.toolCalls)) a[k] = (a[k] ?? 0) + v; return a }, {}),
      retries: sum(models, m => m.retries ?? 0), slowCalls: models.flatMap(m => m.latencySec).filter(sec => sec > SLOW_CALL_SEC).length,
    } } : {},
    errors: results.flatMap(r => r.errors),
  }
}

const args = process.argv.slice(2)
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const RUNS = Number(flag('--runs') ?? 10)
const all: SimResult[] = []

async function pooled(label: string, gen: Partial<GenerateOptions>, sim: Partial<SimOptions>, router: () => Router = () => oracleRouter,
  runs = RUNS): Promise<Summary> {
  const one = (i: number) => {
    const scenario = generate({ ...gen, seed: i + 1 })
    // Addressed messages per minute within the generation window (follow-ups trail after it).
    const window = (gen.durationSec ?? 3600) / 60
    const arrivals = scenario.events.filter(e => e.addressed && e.at < window * 60).length
    return simulate(scenario, { ...sim, seed: i + 1 }, router()).then(result => Object.assign(result, { window, arrivals }))
  }
  const seeds = Array.from({ length: runs }, (_, i) => i)
  // Model runs wait on the network, so their seeds run together; oracle runs are CPU-bound and run in turn.
  const results: (SimResult & { window: number; arrivals: number })[] = router().name === 'oracle'
    ? await seeds.reduce<Promise<(SimResult & { window: number; arrivals: number })[]>>(async (done, i) => [...await done, await one(i)], Promise.resolve([]))
    : await Promise.all(seeds.map(one))
  all.push(...results)
  const summary = summarize(label, results)
  if (summary.errors.length) console.error(`[${label}] ${summary.errors.length} simulator errors, first: ${summary.errors.slice(0, 3).join(' | ')}`)
  return summary
}

function table(rows: Summary[], columns: [string, (row: Summary) => string][]) {
  const cells = [columns.map(([name]) => name), ...rows.map(row => columns.map(([, cell]) => cell(row)))]
  const widths = columns.map((_, i) => Math.max(...cells.map(line => line[i]!.length)))
  for (const [index, line] of cells.entries()) {
    console.log(line.map((cell, i) => cell.padEnd(widths[i]!)).join('  ').trimEnd())
    if (index === 0) console.log(widths.map(w => '-'.repeat(w)).join('  '))
  }
}
const SCHEDULING: [string, (row: Summary) => string][] = [
  ['case', r => r.label],
  ['req', r => String(r.requests)],
  ['done', r => String(r.completed)],
  ['ack p50/p95', r => `${s(r.ackP50)}/${s(r.ackP95)}`],
  ['result p50/p95', r => `${min(r.resultP50)}/${min(r.resultP95)}`],
  ['follow fast', r => `${r.followFast}/${r.followTotal}`],
  ['cross right/lost', r => `${r.cross.attachedRight}/${r.cross.lost} of ${r.cross.total}`],
  ['router steps', r => String(r.routerSteps)],
  ['batch mean/max', r => `${r.meanBatch.toFixed(2)}/${r.maxBatch}`],
  ['s/item', r => r.perItemSec.toFixed(2)],
  ['router busy', r => `${(r.routerBusy * 100).toFixed(1)}%`],
  ['gate drop', r => String(r.gateRejected)],
  ['evals', r => String(r.evals)],
  ['slot wait p95', r => min(r.slotWaitP95)],
]
const JUDGEMENT: [string, (row: Summary) => string][] = [
  ['case', r => r.label],
  ['requests accepted', r => `${r.accepted}/${r.requests}`],
  ['noise→ticket', r => `${r.noiseAccepted}/${r.noiseAtRouter}`],
  ['false tickets', r => String(r.falseTickets)],
  ['cross@router right/wrong/new/lost', r => `${r.cross.attachedRight}/${r.cross.attachedWrong}/${r.cross.acceptedAsNew}/${r.cross.lost}${r.cross.moot ? ` (+${r.cross.moot} moot)` : ''} of ${r.cross.reachedRouter}`],
  ['ack p50/p95', r => `${s(r.ackP50)}/${s(r.ackP95)}`],
  ['batch mean/max', r => `${r.meanBatch.toFixed(2)}/${r.maxBatch}`],
  ['unavail', r => String(r.unavailable)],
  ['refusals', r => String(r.refusals)],
  ['calls', r => String(r.model?.calls ?? '—')],
  ['latency p50/p95', r => r.model ? `${s(r.model.latencyP50)}/${s(r.model.latencyP95)}` : '—'],
  ['retries/slow', r => r.model ? `${r.model.retries}/${r.model.slowCalls}` : '—'],
  ['tokens in(cached)/out', r => r.model ? `${(r.model.promptTokens / 1000).toFixed(0)}k(${(r.model.cachedTokens / 1000).toFixed(0)}k)/${(r.model.completionTokens / 1000).toFixed(1)}k` : '—'],
]

async function model(name = process.env.ROUTER_MODEL ?? 'deepseek-flash', extra: { released?: boolean; dispatch?: string } = {}): Promise<() => Router> {
  await loadEnv()
  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY is not set (put it in .env)')
  const baseUrl = process.env.ROUTER_BASE_URL ?? 'https://api.deepseek.com'
  const verbose = args.includes('--verbose')
  return () => modelRouter({ baseUrl, apiKey, model: name, ...extra, ...verbose ? { onStep: step => console.error(
    `  ${step.atSec.toFixed(0).padStart(5)}s  ${step.latencySec.toFixed(1).padStart(5)}s  +${step.jobs} job(s)  ${step.toolCalls.join(',') || '(text)'}${step.text ? `  “${step.text.replace(/\s+/g, ' ').slice(0, 80)}”` : ''}`) } : {} })
}
/** A small team hour: 8 requests with follow-ups (half of the cross-thread ones addressed), chatter, and addressed small talk. */
const SMALL: Partial<GenerateOptions> = { durationSec: 1800, requests: 8, noise: 40, addressedNoise: 8, followupsPerRequest: 2, crossFraction: 0.5,
  crossAddressed: 1, ciPerRequest: 1, workSec: [300, 900], extraSec: [60, 180] }
/** A burst for batching: 12 requests and 12 addressed small talk messages within 3 minutes, all cross-thread follow-ups addressed. */
const BURST: Partial<GenerateOptions> = { durationSec: 180, requests: 12, noise: 20, addressedNoise: 12, followupsPerRequest: 1, crossFraction: 1,
  crossAddressed: 1, ciPerRequest: 0, workSec: [300, 600], extraSec: [60, 120] }

/**
 * Hard cases (`corpus.ts`): eight tasks over 30 minutes, siblings first, so two tickets on the same page or feature are open
 * together; per task one cross-thread follow-up and two hard cases (stop, status, duplicate, similar new request, in
 * rotation), and ten hard cases about no task (vague reference, question, request on hold, refusal, indirect request).
 */
const HARD: Partial<GenerateOptions> = { durationSec: 1800, requests: 8, noise: 30, addressedNoise: 4, followupsPerRequest: 2, crossFraction: 0.5,
  crossAddressed: 1, ciPerRequest: 0, workSec: [900, 1500], extraSec: [60, 180], probesPerRequest: 2, globalProbes: 10, taskOrder: HARD_ORDER }
/**
 * Stop targets: the hard mix with six refusals that name no work (`decline`) as its hard cases about no task, and on three
 * tasks a refusal right after the same person asked about the task (`declineAfter`).
 */
const STOPS: Partial<GenerateOptions> = { ...HARD, globalProbes: 6, globalKinds: ['decline'], contextDeclines: 3 }
/**
 * Scripted hard cases: twelve tasks over 40 minutes with the hard cases of `HARD`, two refusals right after a status question
 * (`declineAfter`), and two stops and two refusals on a task's own thread (`threadStop`, `threadDecline`).
 */
const SCRIPTED: Partial<GenerateOptions> = { ...HARD, durationSec: 2400, requests: 12, contextDeclines: 2, threadProbes: 4 }
/** Saturation: the hard mix at nominally `perMin` cards per minute to the Router over 4 minutes, follow-ups trailing after it (requests, their cross-thread follow-ups and hard cases, small talk). */
const saturating = (perMin: number): Partial<GenerateOptions> => {
  const cards = perMin * 4
  // Per request: the request, a cross-thread follow-up and a hard case; the rest is hard cases about no task and small talk.
  const requests = Math.max(2, Math.round(cards * 0.2))
  return { durationSec: 240, requests, noise: 0, addressedNoise: Math.round(cards * 0.2), followupsPerRequest: 1, crossFraction: 1, crossAddressed: 1,
    ciPerRequest: 0, workSec: [150, 300], extraSec: [60, 120], probesPerRequest: 1, globalProbes: Math.round(cards * 0.2), taskOrder: HARD_ORDER }
}
/**
 * Forced batching: the hard mix with no repeated task (12 requests over 10 minutes, tickets open throughout), so between rows
 * only the batch size changes. Faster arrival (`saturating`) also repeats task texts and ends tickets early, which confounds it.
 */
const BATCHING: Partial<GenerateOptions> = { ...HARD, durationSec: 600, requests: 12, noise: 0, addressedNoise: 6, globalProbes: 10 }
/**
 * Released follow-ups: short tickets with several follow-ups each, so tickets often end (ready) while a follow-up waits
 * unread; the ticket lets it go and it comes back to Eval (`Tickets.letGo`).
 */
const RELEASE: Partial<GenerateOptions> = { durationSec: 900, requests: 10, noise: 0, addressedNoise: 4, followupsPerRequest: 4, crossFraction: 0.5,
  crossAddressed: 1, ciPerRequest: 0, workSec: [120, 300], extraSec: [30, 90] }
const RELEASED: [string, (row: Summary) => string][] = [
  ['case', r => r.label],
  ['released', r => String(r.released.total)],
  ['→router', r => String(r.released.reachedRouter)],
  ['rescued', r => String(r.released.rescued)],
  ['lost@router', r => String(r.released.lostAtRouter)],
  ['lost@gate', r => String(r.released.lostAtGate)],
  ['follow fast', r => `${r.followFast}/${r.followTotal}`],
  ['cross right/wrong/new/lost', r => `${r.cross.attachedRight}/${r.cross.attachedWrong}/${r.cross.acceptedAsNew}/${r.cross.lost} of ${r.cross.total}`],
  ['false tickets', r => String(r.falseTickets)],
  ['calls', r => String(r.model?.calls ?? '—')],
  ['tokens in', r => r.model ? `${(r.model.promptTokens / 1000).toFixed(0)}k` : '—'],
]
const MODELS = (process.env.ROUTER_MODELS ?? 'deepseek-flash,deepseek-v4-pro').split(',').map(name => name.trim()).filter(Boolean)

/**
 * One model row per dispatch text over `scenario`: the dispatch section as committed at DISPATCH_BEFORE (a git revision, default
 * HEAD; '' skips it), then the texts in DISPATCH_FILES (comma-separated paths), else the working tree's.
 */
async function dispatchRows(scenario: Partial<GenerateOptions>, sim: Partial<SimOptions> = {}): Promise<Summary[]> {
  const { execFileSync } = await import('node:child_process')
  const { readFile } = await import('node:fs/promises')
  const revision = process.env.DISPATCH_BEFORE ?? 'HEAD'
  const rows: Summary[] = []
  if (revision) {
    const before = execFileSync('git', ['show', `${revision}:prompts/dispatch.md`], { encoding: 'utf8' }).trimEnd()
    rows.push(await pooled(`dispatch@${revision}`, scenario, { maxWorkers: 16, ...sim }, await model(undefined, { dispatch: before })))
  }
  const files = (process.env.DISPATCH_FILES ?? '').split(',').filter(Boolean)
  for (const file of files) {
    const text = (await readFile(file, 'utf8')).trimEnd()
    rows.push(await pooled(`dispatch ${file.split('/').at(-1)}`, scenario, { maxWorkers: 16, ...sim }, await model(undefined, { dispatch: text })))
  }
  if (!files.length) rows.push(await pooled('dispatch (working tree)', scenario, { maxWorkers: 16, ...sim }, await model()))
  return rows
}

const experiments: Record<string, () => Promise<{ rows: Summary[]; columns: typeof SCHEDULING; probes?: boolean }>> = {
  baseline: async () => ({ rows: [await pooled('baseline', {}, {})], columns: SCHEDULING }),
  'sweep-rate': async () => ({ rows: await sequence([3600, 1200, 600, 300, 120], duration =>
    pooled(`window ${duration / 60}m`, { durationSec: duration, workSec: [60, 180], extraSec: [30, 90] }, {})), columns: SCHEDULING }),
  /** §7.2: Router-bound rate from ~1 to ~60 per minute over 10 minutes (half requests, half addressed small talk), workers not limiting. */
  'sweep-router': async () => ({ rows: await sequence([1, 5, 10, 20, 40, 60], rate => pooled(`${rate}/min to Router`,
    { durationSec: 600, requests: rate * 5, addressedNoise: Math.round(rate * 5 / 1.3), noise: 0, followupsPerRequest: 0, ciPerRequest: 0,
      workSec: [60, 120] }, { maxWorkers: 16 })), columns: SCHEDULING }),
  'sweep-workers': async () => ({ rows: await sequence([1, 2, 3, 5, 8], maxWorkers => pooled(`maxWorkers=${maxWorkers}`, {}, { maxWorkers })), columns: SCHEDULING }),
  'sweep-errors': async () => ({ rows: await sequence([0, 0.05, 0.1, 0.2], routerErrorRate => pooled(`routerError=${routerErrorRate}`, {}, { routerErrorRate })),
    columns: JUDGEMENT }),
  /** L3: polling vs push. */
  'sweep-poll': async () => ({ rows: await sequence([0, 10, 60, 120], pollSec => pooled(`poll=${pollSec}s`, {}, { pollSec })), columns: SCHEDULING }),
  /** D3: how many cross-thread follow-ups survive when people do or do not address the agent. */
  'sweep-cross': async () => ({ rows: await sequence([0, 0.5, 1], crossAddressed => pooled(`crossAddressed=${crossAddressed}`,
    { crossFraction: 0.5, crossAddressed }, {})), columns: SCHEDULING }),
  /** D1/D3/D4 with a real model: judgement on a small team hour, against the oracle. */
  'model-small': async () => {
    const router = await model()
    return { rows: [await pooled('oracle', SMALL, { maxWorkers: 8 }), await pooled(`model`, SMALL, { maxWorkers: 8 }, router)], columns: JUDGEMENT }
  },
  /** D2 with a real model: does judgement hold when cards batch up? */
  'model-burst': async () => {
    const router = await model()
    return { rows: [await pooled('oracle', BURST, { maxWorkers: 16 }), await pooled(`model`, BURST, { maxWorkers: 16 }, router)], columns: JUDGEMENT }
  },
  /** Hard cases: oracle against each model in ROUTER_MODELS. */
  'model-hard': async () => {
    const rows = [await pooled('oracle', HARD, { maxWorkers: 16 })]
    for (const name of MODELS) rows.push(await pooled(name, HARD, { maxWorkers: 16 }, await model(name)))
    return { rows, columns: JUDGEMENT, probes: true }
  },
  /** D2: the Router-bound rate rises until cards queue up and batch on their own (ROUTER_MODEL). */
  'model-saturation': async () => {
    const router = await model()
    return { rows: await sequence((process.env.SAT_RATES ?? '20,60,120').split(',').map(Number), perMin => pooled(`${perMin}/min`, saturating(perMin), { maxWorkers: 16 }, router)),
      columns: [...JUDGEMENT.slice(0, 1), ['arrivals/min', r => r.cardsPerMin.toFixed(0)], ...JUDGEMENT.slice(1)], probes: true }
  },
  /**
   * A dispatch prompt change: the hard cases with the dispatch section as committed at DISPATCH_BEFORE (a git revision, default
   * HEAD) against the working tree's, in one process (ROUTER_MODEL).
   */
  'model-prompt': async () => ({ rows: await dispatchRows(HARD), columns: JUDGEMENT, probes: true }),
  /**
   * Stop targets (#10): the hard mix with refusals instead of the other hard cases about no task, some right after the same
   * person asked about a task, compared like model-prompt (DISPATCH_BEFORE, DISPATCH_FILES); ORACLE_ONLY=1 checks the scenario.
   */
  /**
   * Scripted hard cases (#7) with follow_up notices: every hard case, refusals right after a status question, and stops and
   * refusals on a task's own thread, which reach the ticket and the Router hears of by notice; compared like model-prompt.
   */
  'model-script': async () => {
    const rows = [await pooled('oracle', SCRIPTED, { maxWorkers: 16, followupNotices: true })]
    if (!process.env.ORACLE_ONLY) rows.push(...await dispatchRows(SCRIPTED, { followupNotices: true }))
    return { rows, columns: JUDGEMENT, probes: true }
  },
  'model-stop': async () => {
    const rows = [await pooled('oracle', STOPS, { maxWorkers: 16 })]
    if (!process.env.ORACLE_ONLY) rows.push(...await dispatchRows(STOPS))
    return { rows, columns: JUDGEMENT, probes: true }
  },
  /** Released follow-ups: the Router with `released` cards and their dispatch rule, and without them (SKIP_BASELINE=1 skips that row). */
  'model-released': async () => {
    const SIM = { maxWorkers: 16, workerStepSec: Number(process.env.WORKER_STEP ?? 60) }
    const rows = [await pooled('oracle', RELEASE, SIM)]
    if (process.env.ORACLE_ONLY) return { rows, columns: RELEASED }
    if (!process.env.SKIP_BASELINE) rows.push(await pooled('model without released', RELEASE, SIM, await model(undefined, { released: false })))
    rows.push(await pooled('model', RELEASE, SIM, await model()))
    return { rows, columns: RELEASED }
  },
  /** D2, controlled: the same hard mix, the Router held until `minBatch` cards wait (ROUTER_MODEL). */
  'model-batch': async () => {
    const router = await model()
    // A long hold so batches reach their size; each size also runs the oracle, since holding alone costs some follow-ups.
    const rows: Summary[] = []
    for (const minBatch of (process.env.BATCH_SIZES ?? '1,5,10,20').split(',').map(Number)) {
      const sim = { maxWorkers: 16, minBatch, batchHoldSec: 600 }
      rows.push(await pooled(`oracle minBatch=${minBatch}`, BATCHING, sim), await pooled(`model minBatch=${minBatch}`, BATCHING, sim, router))
    }
    return { rows, columns: JUDGEMENT, probes: true }
  },
}
async function sequence<T>(items: T[], run: (item: T) => Promise<Summary>): Promise<Summary[]> {
  const rows: Summary[] = []
  for (const item of items) rows.push(await run(item))
  return rows
}

const name = args.find(arg => !arg.startsWith('--') && args[args.indexOf(arg) - 1] !== '--runs' && args[args.indexOf(arg) - 1] !== '--out') ?? 'baseline'
const experiment = experiments[name]
if (!experiment) { console.error(`Unknown experiment ${name}; one of ${Object.keys(experiments).join(', ')}`); process.exit(1) }
const { rows, columns, probes } = await experiment()
if (args.includes('--json')) console.log(JSON.stringify(rows, null, 2))
else {
  console.log(`# ${name} (${RUNS} seed${RUNS === 1 ? '' : 's'} per row)\n`)
  table(rows, columns)
  if (probes) {
    console.log('\n## Hard cases: right/total (outcomes)\n')
    const kinds = [...new Set(rows.flatMap(row => Object.keys(row.probes)))]
    const all = (row: Summary) => Object.values(row.probes).reduce((a, t) => [a[0]! + t.right, a[1]! + t.total], [0, 0])
    const spread = (r: Summary) => r.probeSeeds.length > 1 ? ` (${Math.min(...r.probeSeeds)}–${Math.max(...r.probeSeeds)})` : ''
    table(rows, [['case', r => r.label], ['all (per seed)', r => `${all(r)[0]}/${all(r)[1]}${spread(r)}`], ['harm', r => String(r.harm)],
      ['stops right/wrong', r => `${r.stops.right}/${r.stops.wrong}`], ...kinds.map(kind => [kind, (r: Summary) => {
      const t = r.probes[kind]
      if (!t) return '—'
      const wrong = Object.entries(t.outcomes).filter(([outcome]) => !PROBE_EXPECT[kind as keyof typeof PROBE_EXPECT].includes(outcome as never))
      return `${t.right}/${t.total}${wrong.length ? ` (${wrong.map(([o, n]) => `${o}:${n}`).join(' ')})` : ''}`
    }] as [string, (row: Summary) => string])])
  }
}
// A row whose Router failed, retried or waited long on the API ran in another world than the others: say so.
const degraded = rows.filter(row => row.errors.length || (row.model && (row.model.retries || row.model.slowCalls)))
if (degraded.length && !args.includes('--json')) {
  console.log(`\n## Degraded rows (API errors, retries, or calls over ${SLOW_CALL_SEC} s): compare with care or rerun\n`)
  for (const row of degraded) console.log(`- ${row.label}: ${row.errors.length} router error(s), ${row.model?.retries ?? 0} retries, ${row.model?.slowCalls ?? 0} slow calls${row.errors[0] ? `; first: ${row.errors[0].slice(0, 160)}` : ''}`)
}
const out = flag('--out')
if (out) await writeFile(out, JSON.stringify({ rows, results: all.map(r => ({ ...r, requests: r.requests, score: r.score })) }, null, 2))
