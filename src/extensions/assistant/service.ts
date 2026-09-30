import {
  APICallError,
  NoObjectGeneratedError,
  Output,
  RetryError,
  extractJsonMiddleware,
  generateText,
  streamText,
  wrapLanguageModel,
} from 'ai'
import type { z } from 'zod'
import type {
  AssistPoint,
  AssistReport,
  AssistRequests,
  AssistResults,
  AssistSetupProblem,
  ChatAssistRequest,
  CommandAssistRequest,
  CompletionAssistRequest,
  InputAssistRequest,
  InputAssistResult,
  TerminalAssistRequest,
} from '../../shared/assist'
import type { ExtensionSettingValues } from '../../shared/extensions'
import { type AssistContext, AssistFailure } from '../sdk'
import {
  type AssistantConfig,
  assistStatus,
  endpointOf,
  featureStates,
  modelFor,
  readConfig,
  setupProblem,
  statusLabel,
} from './config'
import { HttpError, describeEndpoint } from './endpoint'
import { type Limiter, createLimiter } from './limiter'
import type { PanelState } from './models'
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
import { type Provider, createProvider } from './providers'

export const TIMEOUTS: Record<AssistPoint, number> = {
  completion: 15_000,
  terminal: 15_000,
  input: 55_000,
  command: 55_000,
  chat: 5 * 60_000,
}
const PROBE_TIMEOUT_MS = 3000
const OBJECT_ATTEMPTS = 2
const ERROR_MESSAGE_MAX = 240

export type ProviderFactory = typeof createProvider

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

export class AssistantService {
  private config: AssistantConfig = readConfig({})
  private apiKey: string | null = null
  private provider: Provider | null = null
  private limiters = new Map<AssistPoint, Limiter>()
  private unreachable = false
  private lastError: string | undefined

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly factory: ProviderFactory = createProvider,
    private readonly now: () => number = Date.now,
    private readonly onReport: () => void = () => {},
  ) {}

  configure(values: ExtensionSettingValues, apiKey: string | null): void {
    this.config = readConfig(values)
    this.apiKey = apiKey?.trim() ? apiKey.trim() : null
    this.limiters.clear()
    this.unreachable = false
    this.lastError = undefined
    const endpoint = endpointOf(this.config, this.env)
    this.provider =
      this.config.provider === 'none' || !endpoint
        ? null
        : this.factory(this.config.provider, endpoint, this.apiKey)
  }

  async probe(): Promise<void> {
    const provider = this.provider
    if (!provider || setupProblem(this.config, this.env, this.apiKey !== null)) return
    try {
      await provider.models(undefined, PROBE_TIMEOUT_MS)
      this.unreachable = false
    } catch (err) {
      this.unreachable = true
      this.lastError = this.redact(messageOf(err))
    }
  }

  private problem(): AssistSetupProblem | null {
    return (
      setupProblem(this.config, this.env, this.apiKey !== null) ??
      (this.unreachable ? 'unreachable' : null)
    )
  }

  report(): AssistReport {
    const problem = this.problem()
    const report: AssistReport = {
      status: assistStatus(this.config, problem),
      features: featureStates(this.config, problem).map((f) => ({
        ...f,
        on: this.config.features[f.id],
      })),
      setup: problem,
    }
    const label = statusLabel(this.config)
    if (label) report.label = label
    if (this.lastError) report.lastError = this.lastError
    return report
  }

  private redact(message: string): string {
    const clean = this.apiKey ? message.split(this.apiKey).join('***') : message
    return clean.replace(/\s+/g, ' ').trim().slice(0, ERROR_MESSAGE_MAX)
  }

  private noteOutcome(error: string | undefined): void {
    const recovered = this.unreachable && error === undefined
    if (recovered) this.unreachable = false
    if (error === this.lastError && !recovered) return
    this.lastError = error
    this.onReport()
  }

  private failure(err: unknown, signal: AbortSignal): AssistFailure {
    if (err instanceof AssistFailure) return err
    if (signal.aborted) return new AssistFailure('cancelled')
    const message = this.redact(messageOf(err))
    this.noteOutcome(message)
    if (statusOf(err) === 429) return new AssistFailure('rate-limited', message)
    return new AssistFailure('failed', message)
  }

  private ready(point: AssistPoint): Provider {
    const provider = this.provider
    if (!provider || this.report().status[point]?.ready !== true) {
      throw new AssistFailure('unavailable', 'This assistant feature is off or not set up.')
    }
    let limiter = this.limiters.get(point)
    if (!limiter) {
      limiter = createLimiter(this.config.requestsPerMinute, this.now)
      this.limiters.set(point, limiter)
    }
    if (!limiter.take()) throw new AssistFailure('rate-limited', 'Too many requests; slow down.')
    return provider
  }

  private settings(provider: Provider, point: AssistPoint, prompt: Prompt, ctx: AssistContext) {
    return {
      model: provider.model(modelFor(this.config, point)),
      system: prompt.system,
      messages: prompt.messages,
      temperature: prompt.temperature,
      maxOutputTokens: prompt.maxOutputTokens,
      maxRetries: point === 'chat' ? 1 : 0,
      abortSignal: AbortSignal.any([ctx.signal, AbortSignal.timeout(TIMEOUTS[point])]),
    }
  }

  private async text(
    provider: Provider,
    point: AssistPoint,
    prompt: Prompt,
    ctx: AssistContext,
  ): Promise<string> {
    const res = await generateText(this.settings(provider, point, prompt, ctx))
    return res.text
  }

  private async object<S extends z.ZodType>(
    provider: Provider,
    point: AssistPoint,
    prompt: Prompt,
    schema: S,
    ctx: AssistContext,
  ): Promise<z.infer<S> | null> {
    for (let attempt = 0; attempt < OBJECT_ATTEMPTS; attempt++) {
      try {
        const res = await generateText({
          ...this.settings(provider, point, prompt, ctx),
          model: wrapLanguageModel({
            model: provider.model(modelFor(this.config, point)),
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
    try {
      const provider = this.ready(point)
      const handlers: {
        [K in AssistPoint]: (req: AssistRequests[K]) => Promise<AssistResults[K]>
      } = {
        input: (req) => this.input(provider, req, ctx),
        command: (req) => this.command(provider, req, ctx),
        completion: (req) => this.completion(provider, req, ctx),
        terminal: (req) => this.terminal(provider, req, ctx),
        chat: (req) => this.chat(provider, req, ctx),
      }
      const result = (await handlers[point](input)) as AssistResults[P]
      this.noteOutcome(undefined)
      return result
    } catch (err) {
      throw this.failure(err, ctx.signal)
    }
  }

  private async input(
    provider: Provider,
    req: InputAssistRequest,
    ctx: AssistContext,
  ): Promise<InputAssistResult> {
    const wantTypos = req.tasks.includes('typos') && this.config.features.typos
    const wantReview = req.tasks.includes('review') && this.config.features.promptReview
    if (!wantTypos && !wantReview) {
      throw new AssistFailure('unavailable', 'Typo fixes and prompt review are off.')
    }
    const [typos, review] = await Promise.all([
      wantTypos ? this.text(provider, 'input', typoPrompt(req.text), ctx) : null,
      wantReview
        ? this.object(provider, 'input', reviewPrompt(req.text, req.agent), reviewSchema, ctx)
        : null,
    ])
    const result: InputAssistResult = {}
    const corrected = typos === null ? null : parseCorrection(typos, req.text)
    if (corrected) result.corrected = corrected
    const parsed = review === null ? null : reviewFrom(review)
    if (parsed) result.review = parsed
    return result
  }

  private async command(provider: Provider, req: CommandAssistRequest, ctx: AssistContext) {
    const parsed = await this.object(provider, 'command', commandPrompt(req), commandSchema, ctx)
    return { suggestions: parsed ? commandsFrom(parsed) : [] }
  }

  private async completion(provider: Provider, req: CompletionAssistRequest, ctx: AssistContext) {
    const raw = await this.text(provider, 'completion', completionPrompt(req), ctx)
    return { text: cleanCompletion(raw, req.prefix, req.suffix) }
  }

  private async terminal(provider: Provider, req: TerminalAssistRequest, ctx: AssistContext) {
    const raw = await this.text(provider, 'terminal', terminalPrompt(req), ctx)
    return { text: cleanTerminal(raw, req.line) }
  }

  private async chat(provider: Provider, req: ChatAssistRequest, ctx: AssistContext) {
    let failure: unknown = null
    const result = streamText({
      ...this.settings(provider, 'chat', chatPrompt(req), ctx),
      onError: ({ error }) => {
        failure = error
      },
    })
    let live = true
    const stream = result.toUIMessageStream({
      onError: (error) => this.redact(messageOf(error)),
    })
    for await (const chunk of stream) {
      if (!live) continue
      live = await ctx.chunk(JSON.stringify(chunk)).catch(() => false)
    }
    if (failure) throw failure
    return { text: await result.text }
  }

  async panelState(): Promise<PanelState> {
    const endpoint = endpointOf(this.config, this.env)
    const report = this.report()
    const state: PanelState = {
      provider: this.config.provider,
      endpoint: endpoint ? describeEndpoint(endpoint) : '',
      fastModel: modelFor(this.config, 'input'),
      chatModel: modelFor(this.config, 'chat'),
      problem: report.setup ?? null,
      lifecycle: this.provider?.lifecycle === true,
      features: report.features ?? [],
      models: [],
    }
    if (report.lastError) state.lastError = report.lastError
    if (!this.provider || state.problem === 'no-key') return state
    try {
      state.models = await this.provider.models()
    } catch (err) {
      state.modelsError = this.redact(messageOf(err))
    }
    return state
  }

  async setLoaded(id: string, loaded: boolean): Promise<void> {
    const provider = this.provider
    const action = loaded ? provider?.load : provider?.unload
    if (!provider || !action) throw new Error('this provider has no model lifecycle')
    await action(id)
  }
}
