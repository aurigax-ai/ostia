import {
  APICallError,
  type JSONSchema7,
  NoObjectGeneratedError,
  Output,
  RetryError,
  type ToolSet,
  dynamicTool,
  extractJsonMiddleware,
  generateText,
  jsonSchema,
  streamText,
  wrapLanguageModel,
} from 'ai'
import type { z } from 'zod'
import { type AssistContext, AssistFailure } from '..'
import type {
  AssistCatalogModel,
  AssistModel,
  AssistModelList,
  AssistPoint,
  AssistProviderEntry,
  AssistProviderState,
  AssistReport,
  AssistRequests,
  AssistResults,
  AssistSetupProblem,
  ChatAssistRequest,
  ChatToolMode,
  ChatToolSpec,
  CommandAssistRequest,
  CompletionAssistRequest,
  InputAssistRequest,
  InputAssistResult,
  TerminalAssistRequest,
} from '../../../shared/assist'
import type { ExtensionSettingValues } from '../../../shared/extensions'
import {
  type AssistantConfig,
  type EntryProblem,
  FEATURES,
  POINT_FEATURES,
  endpointOf,
  entryProblem,
  pointOn,
  readConfig,
} from './config'
import { HttpError } from './endpoint'
import { type Flight, createFlight } from './flight'
import { type Limiter, createLimiter } from './limiter'
import { withPromptedTools } from './promptedTools'
import {
  type Prompt,
  chatPrompt,
  cleanCompletion,
  cleanTerminal,
  commandPrompt,
  commandSchema,
  commandsFrom,
  completionPrompt,
  parseCorrection,
  reviewFrom,
  reviewPrompt,
  reviewSchema,
  terminalPrompt,
  typoPrompt,
} from './prompts'
import type { Provider, ProviderCatalog } from './provider'

export const TIMEOUTS: Record<AssistPoint, number> = {
  completion: 15_000,
  terminal: 15_000,
  input: 55_000,
  command: 55_000,
  chat: 5 * 60_000,
}
const PROBE_TIMEOUT_MS = 3000
const UNCANCELLED_TIMEOUT_MS = 55_000
const SMALL_PREFIX_MAX = 2000
const SMALL_SUFFIX_MAX = 600
const SINGLE_FLIGHT: ReadonlySet<AssistPoint> = new Set(['completion', 'terminal'])
const OBJECT_ATTEMPTS = 2
const ERROR_MESSAGE_MAX = 240

interface Run {
  provider: Provider
  model: string
  tools: ChatToolMode | null
}

export function chatToolSet(specs: ChatToolSpec[]): ToolSet {
  const tools: ToolSet = {}
  for (const spec of specs) {
    tools[spec.name] = dynamicTool({
      description: spec.description,
      inputSchema: jsonSchema(spec.inputSchema as JSONSchema7),
    })
  }
  return tools
}

function statusOf(err: unknown): number | undefined {
  if (err instanceof HttpError) return err.status
  if (APICallError.isInstance(err)) return err.statusCode
  if (RetryError.isInstance(err)) return statusOf(err.lastError)
  return undefined
}

function messageOf(err: unknown): string {
  if (RetryError.isInstance(err)) return messageOf(err.lastError)
  if (APICallError.isInstance(err)) {
    const body = err.responseBody?.trim()
    return err.statusCode ? `HTTP ${err.statusCode}: ${body || err.message}` : err.message
  }
  return err instanceof Error ? err.message : String(err)
}

export const BASE_LOCALE = 'en'

interface Slot {
  entry: AssistProviderEntry
  provider: Provider | null
  problem: EntryProblem | null
  unreachable: boolean
  lastError?: string
  listed: AssistModel[]
  tools: Map<string, ChatToolMode>
}

export interface AssistModelTarget {
  provider: string
  model: string
}

export interface AssistServiceOptions {
  listedModels?: boolean
  configurable?: boolean
}

export class AssistantService {
  private config: AssistantConfig
  private slots: Slot[] = []
  private limiters = new Map<AssistPoint, Limiter>()
  private flights = new Map<AssistPoint, Flight>()
  private locale = BASE_LOCALE

  constructor(
    private readonly catalog: ProviderCatalog,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly now: () => number = Date.now,
    private readonly onReport: () => void = () => {},
    private readonly options: AssistServiceOptions = {},
  ) {
    this.config = readConfig({}, [], catalog)
  }

  setLocale(locale: string): void {
    this.locale = locale
  }

  configure(values: ExtensionSettingValues, entries: readonly AssistProviderEntry[]): void {
    this.config = readConfig(values, entries, this.catalog)
    this.limiters.clear()
    this.flights.clear()
    const previous = this.slots
    this.slots = this.config.entries.map((raw) => {
      const entry = { ...raw, apiKey: raw.apiKey?.trim() ? raw.apiKey.trim() : null }
      const endpoint = endpointOf(entry, this.catalog, this.env)
      const problem = entryProblem(entry, this.catalog, this.env)
      const same = previous.find((slot) => JSON.stringify(slot.entry) === JSON.stringify(entry))
      return {
        entry,
        provider: endpoint ? this.catalog.create(entry.kind, endpoint, entry.apiKey) : null,
        problem,
        unreachable: same?.unreachable ?? false,
        listed: same?.listed ?? [],
        tools: same?.tools ?? new Map(),
      }
    })
  }

  private modelIds(slot: Slot): string[] {
    if (!this.options.listedModels) return slot.entry.models
    return slot.listed.filter((m) => m.installed !== false).map((m) => m.id)
  }

  private async probeSlot(slot: Slot): Promise<void> {
    const provider = slot.provider
    if (!provider || slot.problem) return
    try {
      slot.listed = await provider.models(undefined, PROBE_TIMEOUT_MS)
      slot.unreachable = false
    } catch (err) {
      slot.unreachable = true
      slot.lastError = this.redact(slot, messageOf(err))
    }
    const modes = await Promise.all(
      this.modelIds(slot).map(async (id) => {
        const mode = await provider.chatTools(id, AbortSignal.timeout(PROBE_TIMEOUT_MS))
        return [id, mode] as const
      }),
    )
    slot.tools = new Map(modes)
  }

  async probe(): Promise<void> {
    const slots = this.slots
    await Promise.all(slots.map((slot) => this.probeSlot(slot)))
  }

  private slotProblem(slot: Slot): AssistSetupProblem | null {
    if (slot.problem) return slot.problem
    if (slot.unreachable) return 'unreachable'
    return this.modelIds(slot).length === 0 ? 'no-model' : null
  }

  private usable(slot: Slot): boolean {
    return slot.provider !== null && this.slotProblem(slot) === null
  }

  private problem(): AssistSetupProblem | null {
    if (this.slots.length === 0) return 'no-provider'
    if (this.slots.some((slot) => this.usable(slot))) return null
    return this.slotProblem(this.slots[0])
  }

  private providerStates(): AssistProviderState[] {
    return this.slots.map((slot) => {
      const models: AssistCatalogModel[] = this.modelIds(slot).map((id) => {
        const tools = slot.tools.get(id)
        return tools ? { id, tools } : { id }
      })
      const state: AssistProviderState = {
        id: slot.entry.id,
        kind: slot.entry.kind,
        name: slot.entry.name || this.catalog.title(slot.entry.kind, this.locale),
        setup: this.slotProblem(slot),
        lifecycle: slot.provider?.lifecycle === true,
        models,
      }
      if (slot.lastError) state.lastError = slot.lastError
      return state
    })
  }

  report(): AssistReport {
    const problem = this.problem()
    const status: AssistReport['status'] = {}
    for (const point of Object.keys(POINT_FEATURES) as AssistPoint[]) {
      status[point] = { ready: problem === null && pointOn(this.config, point) }
    }
    const report: AssistReport = {
      status,
      features: FEATURES.map((id) => ({
        id,
        setting: id,
        on: this.config.features[id],
        ready: problem === null && this.config.features[id],
      })),
      setup: problem,
      models: this.slots.some((slot) => slot.provider !== null),
      providers: this.providerStates(),
    }
    if (this.options.configurable) {
      report.kinds = this.catalog.kinds.map((id) => ({
        id,
        title: this.catalog.title(id, this.locale),
        baseUrl: this.catalog.defaultBaseUrl(id, this.env),
        key: this.catalog.keyRequired.has(id) ? 'required' : 'optional',
      }))
    }
    const lastError = this.slots.find((slot) => slot.lastError)?.lastError
    if (lastError) report.lastError = lastError
    return report
  }

  private redact(slot: Slot, message: string): string {
    const key = slot.entry.apiKey
    const clean = key ? message.split(key).join('***') : message
    return clean.replace(/\s+/g, ' ').trim().slice(0, ERROR_MESSAGE_MAX)
  }

  private noteOutcome(slot: Slot, error: string | undefined): void {
    const recovered = slot.unreachable && error === undefined
    if (recovered) slot.unreachable = false
    if (error === slot.lastError && !recovered) return
    slot.lastError = error
    this.onReport()
  }

  private failure(slot: Slot | null, err: unknown, signal: AbortSignal): AssistFailure {
    if (err instanceof AssistFailure) return err
    if (signal.aborted) return new AssistFailure('cancelled')
    if (!slot) return new AssistFailure('failed', messageOf(err).slice(0, ERROR_MESSAGE_MAX))
    const message = this.redact(slot, messageOf(err))
    this.noteOutcome(slot, message)
    if (statusOf(err) === 429) return new AssistFailure('rate-limited', message)
    return new AssistFailure('failed', message)
  }

  private ready(point: AssistPoint, target: AssistModelTarget | undefined): Slot {
    const slot = this.slots.find((s) => s.entry.id === target?.provider)
    const offered = slot && target ? this.modelIds(slot).includes(target.model) : false
    if (!slot || !offered || !this.usable(slot) || this.report().status[point]?.ready !== true) {
      throw new AssistFailure('unavailable', 'This assistant feature is off or not set up.')
    }
    let limiter = this.limiters.get(point)
    if (!limiter) {
      limiter = createLimiter(this.config.requestsPerMinute, this.now)
      this.limiters.set(point, limiter)
    }
    if (!limiter.take()) throw new AssistFailure('rate-limited', 'Too many requests; slow down.')
    return slot
  }

  private settings(run: Run, point: AssistPoint, prompt: Prompt, signal: AbortSignal | null) {
    const timeout = AbortSignal.timeout(signal ? TIMEOUTS[point] : UNCANCELLED_TIMEOUT_MS)
    return {
      model: run.provider.model(run.model),
      system: prompt.system,
      messages: prompt.messages,
      temperature: prompt.temperature,
      maxOutputTokens: prompt.maxOutputTokens,
      maxRetries: point === 'chat' ? 1 : 0,
      abortSignal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    }
  }

  private flight(point: AssistPoint): Flight {
    let flight = this.flights.get(point)
    if (!flight) {
      flight = createFlight()
      this.flights.set(point, flight)
    }
    return flight
  }

  private async text(
    run: Run,
    point: AssistPoint,
    prompt: Prompt,
    ctx: AssistContext,
  ): Promise<string> {
    if (!SINGLE_FLIGHT.has(point)) {
      return (await generateText(this.settings(run, point, prompt, ctx.signal))).text
    }
    const signal = run.provider.serverCancels ? ctx.signal : null
    return this.flight(point).run(ctx.signal, async () => {
      const res = await generateText(this.settings(run, point, prompt, signal))
      return res.text
    })
  }

  private async object<S extends z.ZodType>(
    run: Run,
    point: AssistPoint,
    prompt: Prompt,
    schema: S,
    ctx: AssistContext,
  ): Promise<z.infer<S> | null> {
    for (let attempt = 0; attempt < OBJECT_ATTEMPTS; attempt++) {
      try {
        const res = await generateText({
          ...this.settings(run, point, prompt, ctx.signal),
          model: wrapLanguageModel({
            model: run.provider.model(run.model),
            middleware: extractJsonMiddleware(),
          }),
          output: Output.object({ schema }),
        })
        return res.output as z.infer<S>
      } catch (err) {
        if (!NoObjectGeneratedError.isInstance(err)) throw err
      }
    }
    return null
  }

  async handle<P extends AssistPoint>(
    point: P,
    input: AssistRequests[P],
    ctx: AssistContext,
  ): Promise<AssistResults[P]> {
    let slot: Slot | null = null
    try {
      slot = this.ready(point, ctx.model)
      const run: Run = {
        provider: slot.provider as Provider,
        model: (ctx.model as AssistModelTarget).model,
        tools: slot.tools.get((ctx.model as AssistModelTarget).model) ?? null,
      }
      const handlers: {
        [K in AssistPoint]: (req: AssistRequests[K]) => Promise<AssistResults[K]>
      } = {
        input: (req) => this.input(run, req, ctx),
        command: (req) => this.command(run, req, ctx),
        completion: (req) => this.completion(run, req, ctx),
        terminal: (req) => this.terminal(run, req, ctx),
        chat: (req) => this.chat(run, slot as Slot, req, ctx),
      }
      const result = (await handlers[point](input)) as AssistResults[P]
      this.noteOutcome(slot, undefined)
      return result
    } catch (err) {
      throw this.failure(slot, err, ctx.signal)
    }
  }

  private async input(
    run: Run,
    req: InputAssistRequest,
    ctx: AssistContext,
  ): Promise<InputAssistResult> {
    const wantTypos = req.tasks.includes('typos') && this.config.features.typos
    const wantReview = req.tasks.includes('review') && this.config.features.promptReview
    if (!wantTypos && !wantReview) {
      throw new AssistFailure('unavailable', 'Typo fixes and prompt review are off.')
    }
    const [typos, review] = await Promise.all([
      wantTypos ? this.text(run, 'input', typoPrompt(req.text), ctx) : null,
      wantReview
        ? this.object(run, 'input', reviewPrompt(req.text, req.agent), reviewSchema, ctx)
        : null,
    ])
    const result: InputAssistResult = {}
    const corrected = typos === null ? null : parseCorrection(typos, req.text)
    if (corrected) result.corrected = corrected
    const parsed = review === null ? null : reviewFrom(review)
    if (parsed) result.review = parsed
    return result
  }

  private async command(run: Run, req: CommandAssistRequest, ctx: AssistContext) {
    const parsed = await this.object(run, 'command', commandPrompt(req), commandSchema, ctx)
    return { suggestions: parsed ? commandsFrom(parsed) : [] }
  }

  private async completion(run: Run, req: CompletionAssistRequest, ctx: AssistContext) {
    const sent: CompletionAssistRequest = run.provider.smallPrompts
      ? {
          path: req.path,
          language: req.language,
          prefix: req.prefix.slice(-SMALL_PREFIX_MAX),
          suffix: req.suffix.slice(0, SMALL_SUFFIX_MAX),
        }
      : req
    const raw = await this.text(run, 'completion', completionPrompt(sent), ctx)
    return { text: cleanCompletion(raw, sent.prefix, sent.suffix) }
  }

  private async terminal(run: Run, req: TerminalAssistRequest, ctx: AssistContext) {
    const raw = await this.text(run, 'terminal', terminalPrompt(req), ctx)
    return { text: cleanTerminal(raw, req.line) }
  }

  private async chat(run: Run, slot: Slot, req: ChatAssistRequest, ctx: AssistContext) {
    let failure: unknown = null
    const settings = this.settings(run, 'chat', chatPrompt(req), ctx.signal)
    const tools = req.tools?.length ? req.tools : null
    const result = streamText({
      ...settings,
      ...(tools && run.tools === 'prompted' ? { model: withPromptedTools(settings.model) } : {}),
      ...(tools ? { tools: chatToolSet(tools) } : {}),
      onError: ({ error }) => {
        failure = error
      },
    })
    let live = true
    const stream = result.toUIMessageStream({
      onError: (error) => this.redact(slot, messageOf(error)),
    })
    for await (const chunk of stream) {
      if (!live || chunk.type === 'tool-input-delta') continue
      live = await ctx.chunk(JSON.stringify(chunk)).catch(() => false)
    }
    if (failure) throw failure
    return { text: await result.text }
  }

  private slotFor(providerId: string | undefined): Slot | undefined {
    return providerId ? this.slots.find((s) => s.entry.id === providerId) : this.slots[0]
  }

  async modelList(providerId?: string): Promise<AssistModelList> {
    const slot = this.slotFor(providerId)
    const list: AssistModelList = { lifecycle: slot?.provider?.lifecycle === true, models: [] }
    if (!slot?.provider || slot.problem === 'no-key') return list
    try {
      list.models = await slot.provider.models()
    } catch (err) {
      list.error = this.redact(slot, messageOf(err))
    }
    return list
  }

  async setLoaded(id: string, loaded: boolean, providerId?: string): Promise<void> {
    const provider = this.slotFor(providerId)?.provider
    const action = loaded ? provider?.load : provider?.unload
    if (!provider || !action) throw new Error('this provider has no model lifecycle')
    await action(id)
  }
}
