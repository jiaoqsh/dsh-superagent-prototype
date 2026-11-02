/**
 * Runs replay scenarios and prints a report.
 *
 *   node --experimental-transform-types --no-warnings bench/replay/run.ts [baseline|sweep-rate|sweep-workers|sweep-errors|sweep-poll] [--json]
 */
import { generate, type GenerateOptions } from './scenario.ts'
import { simulate, type SimOptions, type SimResult } from './sim.ts'

const quantile = (values: number[], q: number) => {
  if (!values.length) return NaN
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!
}
const min = (sec: number) => Number.isNaN(sec) ? '—' : `${(sec / 60).toFixed(1)}m`
const s = (sec: number) => Number.isNaN(sec) ? '—' : `${sec.toFixed(1)}s`
const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : NaN

export interface Summary {
  label: string
  requests: number
  acked: number
  completed: number
  ackP50: number; ackP95: number
  resultP50: number; resultP95: number
  followups: number; fastPath: number; viaRouter: number; lost: number
  followAckP50: number
  routerSteps: number; meanBatch: number; maxBatch: number; routerBusy: number; perDecisionSec: number
  evals: number; gateRejected: number; decisions: Record<string, number>
  peakWorkers: number; slotWaitP95: number
  mistakes: SimResult['mistakes']; refusals: number; errors: number
}
export function summarize(label: string, result: SimResult): Summary {
  const acks = result.requests.flatMap(r => r.ackAt !== undefined ? [r.ackAt - r.arrivedAt] : [])
  const results = result.requests.flatMap(r => r.resultAt !== undefined ? [r.resultAt - r.arrivedAt] : [])
  const followAcks = result.followups.flatMap(f => f.ackAt !== undefined ? [f.ackAt - f.arrivedAt] : [])
  const r = result.router
  return {
    label, requests: result.requests.length, acked: acks.length, completed: results.length,
    ackP50: quantile(acks, 0.5), ackP95: quantile(acks, 0.95), resultP50: quantile(results, 0.5), resultP95: quantile(results, 0.95),
    followups: result.followups.length, fastPath: result.followups.filter(f => f.path === 'fast').length,
    viaRouter: result.followups.filter(f => f.path === 'router').length, lost: result.followups.filter(f => f.path === 'lost').length,
    followAckP50: quantile(followAcks, 0.5),
    routerSteps: r.steps, meanBatch: mean(r.batches), maxBatch: Math.max(0, ...r.batches), routerBusy: r.busySec / Math.max(1, result.endSec),
    perDecisionSec: r.items ? r.busySec / r.items : NaN,
    evals: result.evals, gateRejected: result.gateRejected, decisions: result.decisions,
    peakWorkers: result.workers.peak, slotWaitP95: quantile(result.workers.slotWaitSec, 0.95),
    mistakes: result.mistakes, refusals: r.refusals.length, errors: result.errors.length,
  }
}
/** Runs `runs` seeds and pools their per-request numbers into one Summary. */
function pooled(label: string, runs: number, gen: Partial<GenerateOptions>, sim: Partial<SimOptions>): Summary {
  const results = Array.from({ length: runs }, (_, i) => simulate(generate({ ...gen, seed: i + 1 }), { ...sim, seed: i + 1 }))
  const merged: SimResult = {
    ...results[0]!,
    endSec: results.reduce((a, r) => a + r.endSec, 0),
    requests: results.flatMap(r => r.requests), followups: results.flatMap(r => r.followups),
    router: {
      steps: results.reduce((a, r) => a + r.router.steps, 0), items: results.reduce((a, r) => a + r.router.items, 0),
      batches: results.flatMap(r => r.router.batches), busySec: results.reduce((a, r) => a + r.router.busySec, 0),
      candidateItems: results.reduce((a, r) => a + r.router.candidateItems, 0), relayItems: results.reduce((a, r) => a + r.router.relayItems, 0),
      refusals: results.flatMap(r => r.router.refusals),
    },
    decisions: results.reduce<Record<string, number>>((a, r) => { for (const [k, v] of Object.entries(r.decisions)) a[k] = (a[k] ?? 0) + v; return a }, {}),
    gateRejected: results.reduce((a, r) => a + r.gateRejected, 0), evals: results.reduce((a, r) => a + r.evals, 0),
    workers: { peak: Math.max(...results.map(r => r.workers.peak)), slotWaitSec: results.flatMap(r => r.workers.slotWaitSec) },
    mistakes: {
      falseAccepts: results.reduce((a, r) => a + r.mistakes.falseAccepts, 0), missedRequests: results.reduce((a, r) => a + r.mistakes.missedRequests, 0),
      missedAttaches: results.reduce((a, r) => a + r.mistakes.missedAttaches, 0),
    },
    errors: results.flatMap(r => r.errors),
  }
  if (merged.errors.length) console.error(`[${label}] simulator errors:\n  ${merged.errors.slice(0, 5).join('\n  ')}`)
  return summarize(label, merged)
}

function table(rows: Summary[], columns: [string, (row: Summary) => string][]) {
  const cells = [columns.map(([name]) => name), ...rows.map(row => columns.map(([, cell]) => cell(row)))]
  const widths = columns.map((_, i) => Math.max(...cells.map(line => line[i]!.length)))
  for (const [index, line] of cells.entries()) {
    console.log(line.map((cell, i) => cell.padEnd(widths[i]!)).join('  '))
    if (index === 0) console.log(widths.map(w => '-'.repeat(w)).join('  '))
  }
}
const COLUMNS: [string, (row: Summary) => string][] = [
  ['case', r => r.label],
  ['req', r => String(r.requests)],
  ['done', r => String(r.completed)],
  ['ack p50/p95', r => `${s(r.ackP50)}/${s(r.ackP95)}`],
  ['result p50/p95', r => `${min(r.resultP50)}/${min(r.resultP95)}`],
  ['follow fast/router/lost', r => `${r.fastPath}/${r.viaRouter}/${r.lost}`],
  ['router steps', r => String(r.routerSteps)],
  ['batch mean/max', r => `${r.meanBatch.toFixed(2)}/${r.maxBatch}`],
  ['s/decision', r => r.perDecisionSec.toFixed(2)],
  ['router busy', r => `${(r.routerBusy * 100).toFixed(1)}%`],
  ['gate drop', r => String(r.gateRejected)],
  ['evals', r => String(r.evals)],
  ['slot wait p95', r => min(r.slotWaitP95)],
  ['falseAcc/missReq/missAtt', r => `${r.mistakes.falseAccepts}/${r.mistakes.missedRequests}/${r.mistakes.missedAttaches}`],
]

const RUNS = 10
const experiments: Record<string, () => Summary[]> = {
  baseline: () => [pooled('baseline', RUNS, {}, {})],
  /** D2: Router load. Compress the same scenario into shorter windows to raise the arrival rate. */
  'sweep-rate': () => [3600, 1200, 600, 300, 120].map(duration =>
    pooled(`${Math.round((20 + 10) / (duration / 60))}/min addressed`, RUNS, { durationSec: duration, workSec: [60, 180], extraSec: [30, 90] }, {})),
  /** §7.2: Router-bound rate from ~1 to ~60 per minute over 10 minutes (half work requests, half addressed small talk), workers not limiting. */
  'sweep-router': () => [1, 5, 10, 20, 40, 60].map(rate => pooled(`${rate}/min to Router`, RUNS,
    { durationSec: 600, requests: rate * 5, addressedNoise: Math.round(rate * 5 / 1.3), noise: 0, followupsPerRequest: 0, ciPerRequest: 0,
      workSec: [60, 120] }, { maxWorkers: 16 })),
  'sweep-workers': () => [1, 2, 3, 5, 8].map(maxWorkers => pooled(`maxWorkers=${maxWorkers}`, RUNS, {}, { maxWorkers })),
  'sweep-errors': () => [0, 0.05, 0.1, 0.2].map(routerErrorRate => pooled(`routerError=${routerErrorRate}`, RUNS, {}, { routerErrorRate })),
  /** L3: polling vs push. */
  'sweep-poll': () => [0, 10, 60, 120].map(pollSec => pooled(`poll=${pollSec}s`, RUNS, {}, { pollSec })),
  /** D3: how many cross-thread follow-ups survive when people do or do not address the agent. */
  'sweep-cross': () => [0, 0.5, 1].map(crossAddressed => pooled(`crossAddressed=${crossAddressed}`, RUNS, { crossFraction: 0.5, crossAddressed }, {})),
}

const name = process.argv[2] ?? 'baseline'
const run = experiments[name]
if (!run) { console.error(`Unknown experiment ${name}; one of ${Object.keys(experiments).join(', ')}`); process.exit(1) }
const rows = run()
if (process.argv.includes('--json')) console.log(JSON.stringify(rows, null, 2))
else { console.log(`# ${name} (${RUNS} seeds pooled)\n`); table(rows, COLUMNS) }
