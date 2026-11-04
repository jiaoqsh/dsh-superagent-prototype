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
| `fault-hang` | oracle | Worker hangs (#8): `HANG_RATE` (default 0.15) of first assignments hang, holding their slot; without a Watchdog (the prototype has no timer for a running turn) and with one per `WATCHDOG_MIN` (default 60,30,20,10 minutes of no activity), which ends the turn as failed and frees the slot. `activity-gaps.py` measures how long healthy agent turns go without a step, from Claude Code transcripts, for the false alarms of each threshold |
| `fault-loop` | oracle | Runaway workers (#8): `LOOP_RATE` (default 0.15) of first assignments go on working and reading input but never converge or report; with nothing, with the 20-minute activity Watchdog alone (which they pass), and with a turn budget per `BUDGET_MIN` (default 120,60) that ends the turn as failed |
| `fault-router` | oracle | The main Session's model down from minute 20 for each of `OUTAGE_MIN` (default 5,15,30,60) minutes: `stall` (the request is retried until the model is back) and `fail` (each turn fails without acting on what it took in); counts messages whose Evals ran out of requeues (`unavailable`, timeout), results never relayed, and acknowledgement delays |
| `fault-restart` | oracle | A host restart at minute `RESTART_MIN` (default 30) with workers running, through the Engine's `assignmentInterrupted`; Sessions kept (work goes on) or lost (work done again, an upper bound); checks that no request, follow-up or acknowledgement is lost |
| `model-small` | oracle vs model | Judgement on a small team hour (D1/D3/D4) |
| `model-burst` | oracle vs model | Judgement on a short burst |
| `model-hard` | oracle vs each model in `ROUTER_MODELS` | Hard cases: sibling tickets, stop, status, duplicate, similar new request, vague reference, question, hold, refusal, indirect request |
| `model-saturation` | model | The hard mix at rising rates (nominal 20/60/120 per minute, `SAT_RATES`). Confounded at high rates: tasks repeat and short tickets end early (released inputs come back to Eval), so use `model-batch` for D2 |
| `model-released` | oracle, model, model + fix | Follow-ups a ticket lets go unread when it ends (`Tickets.letGo`): how many the Router recovers with `released` on cards and its dispatch rule, and without them (`released: false` in `llm-router.ts`; `SKIP_BASELINE=1` skips that row). `WORKER_STEP` sets how long a worker takes to read new input (default 60 s) |
| `model-prompt` | model per dispatch text | A dispatch prompt change: the dispatch section at `DISPATCH_BEFORE` (a git revision, default `HEAD`) against the working tree's, or the texts in `DISPATCH_FILES` (comma-separated paths), one row each, over the hard cases |
| `model-stop` | oracle, then model per dispatch text | Stop targets (#10): the hard mix with refusals that name no work, and refusals right after the same person asked about a task; compared like `model-prompt`. The `stops right/wrong` column counts every stop the Router decided, wrong ones being stops of a ticket nobody asked to stop |
| `model-script` | oracle, then model per dispatch text | Scripted hard cases (#7) with follow_up notices on: every hard case, refusals right after a status question, and stops and refusals on a task's own thread; compared like `model-prompt` |
| `model-batch` | oracle and model per size | D2, controlled: a fixed hard mix (no repeated task, tickets open throughout) with the Router held until `minBatch` cards wait (1/5/10/20, `BATCH_SIZES`); judgement only, the hold inflates acknowledgement times |

Model experiments read `DEEPSEEK_API_KEY` from the environment or `.env`; `ROUTER_BASE_URL` (default
`https://api.deepseek.com`) and `ROUTER_MODEL` (default `deepseek-flash`) pick another OpenAI-compatible endpoint;
`ROUTER_MODELS` (default `deepseek-flash,deepseek-v4-pro`) lists the models `model-hard` compares. A model row runs its seeds
concurrently.

## What is real and what is modelled

| Part | In the bench |
|---|---|
| Intake, dedup, subscription fan-out, Eval batching and deadlines, Mandates, Tickets, Assignments, Replies | Real (`src/core`) |
| Gate (who may originate work, follow-ups, accept mode) | Real (`settingsPolicy`) |
| Main Session (Router), oracle | One server; a step takes every queued card; step time `routerBaseSec + routerPerItemSec × items` (defaults fit the article's §7.2: 2.5 s at 1 item, 3.9 s at 2.8). Decisions come from the scenario's ground truth, flipped with `routerErrorRate` |
| Main Session (Router), model (`llm-router.ts`) | The real system prompt (`composePrompt`), tools (`mainTools`), candidate cards (`candidateCard`), worker report relays (`resultRelay`) and resource reader (`readResource`) over a real model. Each call's wall time passes on the virtual clock, and cards that arrive meanwhile are steered into the same turn. Simplified: a fixed history cap instead of DSH compaction, no DSH system prompt or skills, settings/prompt/inferred-assessment tools answer unavailable. follow_up notices (`followupNotice`) only with `followupNotices` (`model-script`), so earlier experiments stay comparable |
| Workers | `maxWorkers` slots, `launchSec` to start, inputs read after `workerStepSec`, work time from the scenario; one launch per assignment however often the Engine asks (before 2026-11-03 a second ask relaunched a running assignment, restarting its work, which inflated slot waits by about a fifth) |
| Sources | A message waits a uniform share of `pollSec` before intake (0 = push) |
| Repositories | `MemoryRepositories` |

With the oracle, a run measures scheduling and routing mechanics; with a model, it also measures the Router's judgement.
Neither measures workers' code quality. Every run is scored the same way from the records (`score` in `sim.ts`): requests
accepted, tickets created for no request, cross-thread follow-ups attached to the right ticket, wrong one, accepted as new
work, or lost. A message counts as reaching a ticket while it is in the ticket's fan-out or the ticket's worker acknowledged
it: an ended ticket drops even messages its worker read from its fan-out. A cross-thread follow-up that reached no ticket
because a person stopped its task's ticket no later than the Router decided it is `moot`, not lost (a stop and a follow-up in one
batch). The hard-case table adds:

- `all (per seed)`: hard cases right, with the lowest and highest seed, for the spread between runs;
- `harm`: mistakes weighted by cost (`HARM` in `sim.ts`): a wrong stop 5, a wrong attach 3, a false ticket 2, a lost
  follow-up or missed request 2, any other wrong hard case 1;
- `stops right/wrong`: every stop the Router decided, wrong ones ending a ticket nobody asked to stop.

## Scenario

`scenario.ts` generates the article's ablation shape: ~20 work requests, their follow-ups (on the task's thread, or as a
new message in the general chat), CI results, unaddressed chatter, and addressed small talk. Group-chat threads follow the
Feishu Source: each top-level message is its own Thread and replies join it. Texts come from `corpus.ts`, a Chinese team
chat: requests, replies with more input, follow-ups posted elsewhere that name the task only by its subject, chatter (some
of it technical), and messages that address the agent without asking for work.

## Hard cases

`corpus.ts` gives every task four hard cases (`TaskProbe`) and keeps five kinds tied to no task (`GlobalProbe`). Each is labelled
with the outcomes a correct Router may reach (`PROBE_EXPECT` in `scenario.ts`), following `prompts/dispatch.md`:

| Case | Example | Right |
|---|---|---|
| stop | “订单导出乱码那个不用修了” | stop that ticket |
| status | “导出乱码那个修好了吗？” | answer (ignore) or attach |
| duplicate | another person asks for the same work in other words | anything but a second ticket |
| similarNew | “/api/orders 的分页也加一下同样的参数校验” | a new ticket, not attached |
| vague | “刚才那个也顺便处理一下吧” with several tickets open | ask (ignore), not guess |
| question / hold / decline | a question, “先别动手，等我确认”, “你不用管” | no ticket |
| polite | “有空的话能不能把日志里的手机号脱敏一下？” | a new ticket |
| threadStop / threadDecline | “这个不用做了，需求取消了” / “这个我自己来修吧，你不用管了” on the task's own thread, from who asked for it | stop / stop, or leave it to the ticket's worker (attach) |
| declineAfter | “算了，这个我自己来改吧，你不用管了”, 45 s after the same person asked how a task is going | stop that ticket, or ask (ignore) |

Tasks 12 and 13 are siblings of tasks 0 and 1 (same page or feature, another problem); `HARD_ORDER` starts them together, so a
cross-thread follow-up must be read for which ticket it means (`cross … wrong`).
