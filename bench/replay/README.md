# Replay bench

A discrete-event simulator that replays a timed message stream through the **real** core `Engine` and the **real** settings
`Policy` (`policy.gate`), on a virtual clock. It is the P0 evaluation bench of the Super-agent evaluation plan.

```sh
node --experimental-transform-types --no-warnings bench/replay/run.ts <experiment> [--json]
```

Options: `--runs N` (seeds per row, default 10), `--json`, `--out file.json` (rows plus every run's score and routed messages),
`--verbose` (one line per model step).

| Experiment | Router | What it asks |
|---|---|---|
| `baseline`, `sweep-workers`, `sweep-poll`, `sweep-rate` | oracle | Latency and capacity: where time goes |
| `sweep-router` | oracle | The article's §7.2 batching curve (a consistency check: step time is fitted to it) |
| `sweep-cross`, `sweep-errors` | oracle | How many cross-thread follow-ups survive the gate; how Router mistakes propagate |
| `model-small` | oracle vs model | Judgement on a small team hour (D1/D3/D4) |
| `model-burst` | oracle vs model | Judgement when cards batch up (D2) |

Model experiments read `DEEPSEEK_API_KEY` from the environment or `.env`; `ROUTER_BASE_URL` (default
`https://api.deepseek.com`) and `ROUTER_MODEL` (default `deepseek-flash`) pick another OpenAI-compatible endpoint.

## What is real and what is modelled

| Part | In the bench |
|---|---|
| Intake, dedup, subscription fan-out, Eval batching and deadlines, Mandates, Tickets, Assignments, Replies | Real (`src/core`) |
| Gate (who may originate work, follow-ups, accept mode) | Real (`settingsPolicy`) |
| Main Session (Router), oracle | One server; a step takes every queued card; step time `routerBaseSec + routerPerItemSec × items` (defaults fit the article's §7.2: 2.5 s at 1 item, 3.9 s at 2.8). Decisions come from the scenario's ground truth, flipped with `routerErrorRate` |
| Main Session (Router), model (`llm-router.ts`) | The real system prompt (`composePrompt`), tools (`mainTools`), candidate cards (`candidateCard`), worker report relays (`resultRelay`) and resource reader (`readResource`) over a real model. Each call's wall time passes on the virtual clock, and cards that arrive meanwhile are steered into the same turn. Simplified: a fixed history cap instead of DSH compaction, no DSH system prompt or skills, settings/prompt/inferred-assessment tools answer unavailable, no follow-up notices |
| Workers | `maxWorkers` slots, `launchSec` to start, inputs read after `workerStepSec`, work time from the scenario |
| Sources | A message waits a uniform share of `pollSec` before intake (0 = push) |
| Repositories | `MemoryRepositories` |

With the oracle, a run measures scheduling and routing mechanics; with a model, it also measures the Router's judgement.
Neither measures workers' code quality. Every run is scored the same way from the records (`score` in `sim.ts`): requests
accepted, tickets created for no request, cross-thread follow-ups attached to the right ticket, wrong one, accepted as new
work, or lost.

## Scenario

`scenario.ts` generates the article's ablation shape: ~20 work requests, their follow-ups (on the task's thread, or as a
new message in the general chat), CI results, unaddressed chatter, and addressed small talk. Group-chat threads follow the
Feishu Source: each top-level message is its own Thread and replies join it. Texts come from `corpus.ts`, a Chinese team
chat: requests, replies with more input, follow-ups posted elsewhere that name the task only by its subject, chatter (some
of it technical), and messages that address the agent without asking for work.
