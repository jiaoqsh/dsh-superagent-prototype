/**
 * A model Router for the replay bench: the real orchestrator system prompt (`composePrompt`), the real main-Session tools
 * (`mainTools`, so `orchestrator_route`'s schema, checks and Engine calls are the product's own), the real candidate cards
 * (`candidateCard`) and the real resource reader (`readResource`), over an OpenAI-compatible chat completions API.
 *
 * Differences from the product, each a simplification of the DSH host: one conversation with a fixed history cap instead of
 * DSH compaction; no DSH system prompt or skills; tools that change settings or prompts, or assess inferred candidates,
 * answer that they are unavailable; worker reports arrive as `worker_report` relays, and follow-up notices are not sent.
 */
import { z } from 'zod'
import type { Decision, Thread, Trigger } from '../../src/core/index.ts'
import { TextCache } from '../../src/app/cache.ts'
import { candidateCard } from '../../src/app/links.ts'
import { resultRelay } from '../../src/app/notices.ts'
import { composePrompt, defaultPrompts, policySection } from '../../src/app/prompts.ts'
import { readResource } from '../../src/app/resources.ts'
import { mainTools } from '../../src/app/tools/main.ts'
import type { Tool } from '../../src/app/tools/tool.ts'
import type { Job, Router, RouterWorld } from './sim.ts'

export interface ModelConfig {
  baseUrl: string
  apiKey: string
  model: string
  /** Messages kept after the system prompt; older exchanges are dropped whole. */
  historyMessages?: number
  /** Model calls allowed in one turn before it is cut off. */
  maxStepsPerTurn?: number
  /**
   * Off: the Router as it was before `released`: cards do not mark a message a ticket let go unread when it ended, and
   * dispatch has no rule for it. Default on, as the product is.
   */
  released?: boolean
  /** Called with each model step, for logging. */
  onStep?: (step: { atSec: number; latencySec: number; jobs: number; toolCalls: string[]; text?: string }) => void
}

type Message =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[]; reasoning_content?: string }
  | { role: 'tool'; tool_call_id: string; content: string }
interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
interface Completion {
  choices: { message: { content: string | null; tool_calls?: ToolCall[]; reasoning_content?: string }; finish_reason: string }[]
  usage?: { prompt_tokens: number; completion_tokens: number; prompt_cache_hit_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } }
}

const unavailable = (name: string): never => new Proxy({}, {
  get: (_target, property) => property === 'then' ? undefined : () => { throw new Error(`${name}.${String(property)} is not available in the replay bench`) },
}) as never

/** Loads `.env` entries into `process.env` without overriding variables already set. */
export async function loadEnv(path = new URL('../../.env', import.meta.url)): Promise<void> {
  const { readFile } = await import('node:fs/promises')
  const text = await readFile(path, 'utf8').catch(() => '')
  for (const line of text.split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line)
    if (match && process.env[match[1]!] === undefined) process.env[match[1]!] = match[2]!.replace(/^(['"])(.*)\1$/, '$2')
  }
}

export function modelRouter(config: ModelConfig): Router {
  const history = config.historyMessages ?? 120
  const maxSteps = config.maxStepsPerTurn ?? 16
  let messages: Message[] | undefined
  let tools: Tool[] | undefined
  let toolSpecs: unknown[] | undefined

  function setup(world: RouterWorld) {
    const { repo, settings } = world
    const pages = new TextCache(4_000_000)
    const triggerList = () => [...world.triggers].reverse()
    const thread = (key: string) => (trigger: Trigger) => trigger.threads.some(ref => `${ref.source}:${ref.id}` === key)
    const store = {
      settings: () => settings,
      triggers: repo.triggers, threads: repo.threads, tickets: repo.tickets, decisions: repo.decisions,
      atomic: <T>(run: () => T) => repo.atomic(run),
      replyStatus: () => 'sent' as const,
      get: () => undefined,
      read: {
        recentTriggers: (offset = 0, limit = 50) => triggerList().slice(offset, offset + limit),
        threadPage: (key: string, offset: number, limit: number) => triggerList().filter(thread(key)).slice(offset, offset + limit),
        neighbours: (key: string, at: string, id: string) => {
          const on = world.triggers.filter(thread(key))
          const index = on.findIndex(trigger => trigger.id === id)
          return { ...index > 0 ? { before: on[index - 1] } : {}, ...index >= 0 && index < on.length - 1 ? { after: on[index + 1] } : {} }
        },
        firstTrigger: (key: string) => world.triggers.find(thread(key)),
        recentDecisions: (offset = 0, limit = 50) => [...world.decisionIds].reverse().slice(offset, offset + limit)
          .flatMap(id => repo.decisions.get(id) ?? []) as Decision[],
        subscribedThreads: () => repo.threads.list().filter((item: Thread) => item.subscriptions.length > 0),
        search: (query: string) => triggerList().filter(trigger => trigger.text.includes(query) || trigger.id === query).slice(0, 20),
      },
    }
    const sources = { repliesTo: () => undefined, find: () => ({ threads: [], terms: [] }) }
    const logger = { warn: () => {}, info: () => {}, debug: () => {}, error: () => {} }
    const resources = {
      store, pages, prompts: unavailable('prompts'), commands: unavailable('commands'), masterId: 'orchestrator',
      context: { logger }, promptVersion: unavailable('promptVersion'), mayRead: () => false, feishuPageSize: () => 20,
      sourceLink: async (trigger: Trigger) => trigger.url ? { source_url: trigger.url } : {},
    }
    const host = {
      context: { logger }, engine: world.engine, store, prompts: unavailable('prompts'),
      sessions: { status: unavailable('sessions'), notify: unavailable('sessions'), delivery: unavailable('sessions'), modelRetry: () => ({}) },
      settings: unavailable('settings'), assessor: unavailable('assessor'), resources,
      requestPass: () => world.pump(), sendReplies: async () => {}, quietly: <T>(run: () => T) => run(),
    }
    tools = mainTools(host as never, {} as never)
    toolSpecs = tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description,
      parameters: z.toJSONSchema(tool.schema, { io: 'input', unrepresentable: 'any' }) } }))
    const linkHost = { store, links: new TextCache(1_000_000), commands: unavailable('commands'), sources, lifetime: new AbortController().signal }
    const composed = composePrompt(defaultPrompts(), 'orchestrator', undefined, policySection(settings))
    // Without `released`, the dispatch rule for it goes too (the composed prompt joins dispatch.md's lines with spaces).
    const system = config.released === false ? composed.replace(/ ?released: a ticket ended before[^]*?as any other message\./, '') : composed
    if (config.released === false && system === composed) throw new Error('the released rule was not found in the prompt')
    messages = [{ role: 'system', content: system }]
    return linkHost
  }
  let linkHost: ReturnType<typeof setup> | undefined

  async function render(job: Job, world: RouterWorld): Promise<string | undefined> {
    if (job.kind === 'relay') {
      const ticket = world.repo.tickets.get(job.ticketId)
      return ticket ? resultRelay(ticket, 'ready', job.summary).text : undefined
    }
    // A card shows the Eval as it stands when it reaches the Session, as `MasterAssessor` builds it at delivery.
    const live = world.engine.candidate(job.candidate.triggers[0]!.id)
    if (!live || live.evalId !== job.candidate.evalId) return undefined
    const { released, ...card } = await candidateCard(linkHost as never, live)
    return JSON.stringify({ kind: 'candidate', ...card, ...config.released === false || !released ? {} : { released } })
  }
  async function deliver(jobs: Job[], world: RouterWorld): Promise<number> {
    const texts = (await Promise.all(jobs.map(job => render(job, world)))).filter((text): text is string => !!text)
    world.delivered(jobs)
    for (const text of texts) messages!.push({ role: 'user', content: text })
    return texts.length
  }
  function trim() {
    if (messages!.length - 1 <= history) return
    // Drop the oldest exchanges whole: from a user message up to (not including) the next user message.
    let cut = messages!.length - history
    while (cut < messages!.length && messages![cut]!.role !== 'user') cut++
    messages = [messages![0]!, ...messages!.slice(cut)]
  }
  async function complete(world: RouterWorld): Promise<Completion> {
    for (let attempt = 0; ; attempt++) {
      let response: Response
      try {
        response = await fetch(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
          body: JSON.stringify({ model: config.model, messages, tools: toolSpecs, tool_choice: 'auto' }),
        })
      } catch (error) {
        // A dropped connection is retried like a 5xx; DSH retries model calls the same way.
        if (attempt < 4) { await new Promise(resolve => setTimeout(resolve, 2000 * 2 ** attempt)); continue }
        throw error
      }
      if (response.ok) return await response.json() as Completion
      const body = await response.text()
      if (attempt < 4 && (response.status === 429 || response.status >= 500)) {
        await new Promise(resolve => setTimeout(resolve, 2000 * 2 ** attempt))
        continue
      }
      throw new Error(`model API ${response.status} at ${world.now().toFixed(0)}s: ${body.slice(0, 300)}`)
    }
  }
  async function execute(call: ToolCall): Promise<string> {
    const tool = tools!.find(item => item.name === call.function.name)
    if (!tool) return JSON.stringify({ error: `Unknown tool ${call.function.name}` })
    try {
      const args = tool.schema.parse(JSON.parse(call.function.arguments || '{}'))
      return JSON.stringify(await tool.execute(args as never, new AbortController().signal) ?? { ok: true })
    } catch (error) {
      if (error instanceof z.ZodError) return JSON.stringify({ error: 'Invalid arguments', issues: error.issues.slice(0, 5) })
      return JSON.stringify({ error: error instanceof Error ? error.message : String(error) })
    }
  }

  return {
    name: `model:${config.model}`,
    async turn(jobs, world) {
      linkHost ??= setup(world)
      const stats = world.stats.model ??= { calls: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0, latencySec: [], toolCalls: {} }
      let fresh = await deliver(jobs, world)
      if (!fresh) return
      for (let step = 0; step < maxSteps; step++) {
        trim()
        const started = performance.now()
        const completion = await complete(world)
        const latency = (performance.now() - started) / 1000
        stats.calls++
        stats.latencySec.push(latency)
        stats.promptTokens += completion.usage?.prompt_tokens ?? 0
        stats.cachedTokens += completion.usage?.prompt_cache_hit_tokens ?? completion.usage?.prompt_tokens_details?.cached_tokens ?? 0
        stats.completionTokens += completion.usage?.completion_tokens ?? 0
        // The model's wall time passes on the virtual clock; what arrives meanwhile is steered into this turn.
        world.advance(latency)
        const message = completion.choices[0]!.message
        const calls = message.tool_calls ?? []
        messages!.push({ role: 'assistant', content: message.content ?? null, ...calls.length ? { tool_calls: calls } : {},
          ...message.reasoning_content ? { reasoning_content: message.reasoning_content } : {} })
        for (const call of calls) {
          stats.toolCalls[call.function.name] = (stats.toolCalls[call.function.name] ?? 0) + 1
          messages!.push({ role: 'tool', tool_call_id: call.id, content: await execute(call) })
        }
        config.onStep?.({ atSec: world.now(), latencySec: latency, jobs: fresh, toolCalls: calls.map(call => call.function.name),
          ...message.content ? { text: message.content.slice(0, 200) } : {} })
        fresh = await deliver(world.takeSteered(), world)
        if (!calls.length && !fresh) break
      }
    },
  }
}
