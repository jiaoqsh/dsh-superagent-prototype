/**
 * Runs replay experiments and prints a report.
 *
 *   node --experimental-transform-types --no-warnings bench/replay/run.ts <experiment> [--json] [--runs N] [--out file.json]
 *
 * Oracle experiments (deterministic, free): baseline, sweep-rate, sweep-router, sweep-workers, sweep-errors, sweep-poll, sweep-cross.
 * Model experiments (call the API in DEEPSEEK_API_KEY, model ROUTER_MODEL or deepseek-flash): model-small, model-burst.
 */
import { writeFile } from 'node:fs/promises'
import { generate, type GenerateOptions } from './scenario.ts'
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
  model?: { calls: number; promptTokens: number; cachedTokens: number; completionTokens: number; latencyP50: number; latencyP95: number; toolCalls: Record<string, number> }
  errors: string[]
}
export function summarize(label: string, results: SimResult[]): Summary {
  const requests = results.flatMap(r => r.requests)
  const acks = requests.flatMap(r => r.ackAt !== undefined ? [r.ackAt - r.arrivedAt] : [])
  const done = requests.flatMap(r => r.resultAt !== undefined ? [r.resultAt - r.arrivedAt] : [])
  const stats = results.map(r => r.routerStats)
  const models = stats.flatMap(st => st.model ? [st.model] : [])
  const cross = { total: 0, reachedRouter: 0, attachedRight: 0, attachedWrong: 0, acceptedAsNew: 0, lost: 0 }
  for (const r of results) for (const k of Object.keys(cross) as (keyof typeof cross)[]) cross[k] += r.score.cross[k]
  return {
    label, runs: results.length,
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
  const results: SimResult[] = []
  for (let i = 0; i < runs; i++) results.push(await simulate(generate({ ...gen, seed: i + 1 }), { ...sim, seed: i + 1 }, router()))
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
  ['cross@router right/wrong/new/lost', r => `${r.cross.attachedRight}/${r.cross.attachedWrong}/${r.cross.acceptedAsNew}/${r.cross.lost} of ${r.cross.reachedRouter}`],
  ['ack p50/p95', r => `${s(r.ackP50)}/${s(r.ackP95)}`],
  ['batch mean/max', r => `${r.meanBatch.toFixed(2)}/${r.maxBatch}`],
  ['unavail', r => String(r.unavailable)],
  ['refusals', r => String(r.refusals)],
  ['calls', r => String(r.model?.calls ?? '—')],
  ['latency p50/p95', r => r.model ? `${s(r.model.latencyP50)}/${s(r.model.latencyP95)}` : '—'],
  ['tokens in(cached)/out', r => r.model ? `${(r.model.promptTokens / 1000).toFixed(0)}k(${(r.model.cachedTokens / 1000).toFixed(0)}k)/${(r.model.completionTokens / 1000).toFixed(1)}k` : '—'],
]

async function model(): Promise<() => Router> {
  await loadEnv()
  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY is not set (put it in .env)')
  const baseUrl = process.env.ROUTER_BASE_URL ?? 'https://api.deepseek.com'
  const name = process.env.ROUTER_MODEL ?? 'deepseek-flash'
  const verbose = args.includes('--verbose')
  return () => modelRouter({ baseUrl, apiKey, model: name, ...verbose ? { onStep: step => console.error(
    `  ${step.atSec.toFixed(0).padStart(5)}s  ${step.latencySec.toFixed(1).padStart(5)}s  +${step.jobs} job(s)  ${step.toolCalls.join(',') || '(text)'}${step.text ? `  “${step.text.replace(/\s+/g, ' ').slice(0, 80)}”` : ''}`) } : {} })
}
/** A small team hour: 8 requests with follow-ups (half of the cross-thread ones addressed), chatter, and addressed small talk. */
const SMALL: Partial<GenerateOptions> = { durationSec: 1800, requests: 8, noise: 40, addressedNoise: 8, followupsPerRequest: 2, crossFraction: 0.5,
  crossAddressed: 1, ciPerRequest: 1, workSec: [300, 900], extraSec: [60, 180] }
/** A burst for batching: 12 requests and 12 addressed small talk messages within 3 minutes, all cross-thread follow-ups addressed. */
const BURST: Partial<GenerateOptions> = { durationSec: 180, requests: 12, noise: 20, addressedNoise: 12, followupsPerRequest: 1, crossFraction: 1,
  crossAddressed: 1, ciPerRequest: 0, workSec: [300, 600], extraSec: [60, 120] }

const experiments: Record<string, () => Promise<{ rows: Summary[]; columns: typeof SCHEDULING }>> = {
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
}
async function sequence<T>(items: T[], run: (item: T) => Promise<Summary>): Promise<Summary[]> {
  const rows: Summary[] = []
  for (const item of items) rows.push(await run(item))
  return rows
}

const name = args.find(arg => !arg.startsWith('--') && args[args.indexOf(arg) - 1] !== '--runs' && args[args.indexOf(arg) - 1] !== '--out') ?? 'baseline'
const experiment = experiments[name]
if (!experiment) { console.error(`Unknown experiment ${name}; one of ${Object.keys(experiments).join(', ')}`); process.exit(1) }
const { rows, columns } = await experiment()
if (args.includes('--json')) console.log(JSON.stringify(rows, null, 2))
else { console.log(`# ${name} (${RUNS} seed${RUNS === 1 ? '' : 's'} per row)\n`); table(rows, columns) }
const out = flag('--out')
if (out) await writeFile(out, JSON.stringify({ rows, results: all.map(r => ({ ...r, requests: r.requests, score: r.score })) }, null, 2))
