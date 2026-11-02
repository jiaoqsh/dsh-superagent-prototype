# Replay bench

A discrete-event simulator that replays a timed message stream through the **real** core `Engine` and the **real** settings
`Policy` (`policy.gate`), on a virtual clock. It is the P0 evaluation bench of the Super-agent evaluation plan.

```sh
node --experimental-transform-types --no-warnings bench/replay/run.ts <experiment> [--json]
```

Experiments: `baseline`, `sweep-rate`, `sweep-workers`, `sweep-errors`, `sweep-poll`, `sweep-cross`. Each pools 10 seeds.

## What is real and what is modelled

| Part | In the bench |
|---|---|
| Intake, dedup, subscription fan-out, Eval batching and deadlines, Mandates, Tickets, Assignments, Replies | Real (`src/core`) |
| Gate (who may originate work, follow-ups, accept mode) | Real (`settingsPolicy`) |
| Main Session (Router) | One server; a step takes every queued card; step time `routerBaseSec + routerPerItemSec × items` (defaults fit the article's §7.2: 2.5 s at 1 item, 3.9 s at 2.8). Decisions come from the scenario's ground truth, flipped with `routerErrorRate` |
| Workers | `maxWorkers` slots, `launchSec` to start, inputs read after `workerStepSec`, work time from the scenario |
| Sources | A message waits a uniform share of `pollSec` before intake (0 = push) |
| Repositories | `MemoryRepositories` |

So a run measures scheduling and routing mechanics, not model judgement or code quality. Model judgement is the next
step: replace the oracle Router with one that calls a model on the real candidate cards.

## Scenario

`scenario.ts` generates the article's ablation shape: ~20 work requests, their follow-ups (on the task's thread, or as a
new message in the general chat), CI results, unaddressed chatter, and addressed small talk. Group-chat threads follow the
Feishu Source: each top-level message is its own Thread and replies join it.
