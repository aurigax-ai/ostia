import type {
  AssistPoint,
  AssistRequests,
  AssistResults,
  AssistStatus,
  ChatAssistRequest,
  CommandAssistRequest,
  CompletionAssistRequest,
  InputAssistRequest,
  InputAssistResult,
} from '../../shared/assist'
import type { ExtensionSettingValues } from '../../shared/extensions'
import { type AssistContext, AssistFailure } from '../sdk'
import {
  type AssistantConfig,
  assistStatus,
  endpointOf,
  modelFor,
  readConfig,
  setupProblem,
} from './config'
import { AbortedError, HttpError, describeEndpoint } from './http'
import { type Limiter, createLimiter } from './limiter'
import type { PanelState } from './models'
import {
  type Prompt,
  chatPrompt,
  cleanCompletion,
  commandPrompt,
  completionPrompt,
  parseCommands,
  parseCorrection,
  parseReview,
  reviewPrompt,
  typoPrompt,
} from './prompts'
import { type Provider, createProvider } from './providers'

const FAST_TIMEOUT_MS = 20_000
const CHAT_TIMEOUT_MS = 5 * 60_000
const ERROR_MESSAGE_MAX = 240

export type ProviderFactory = typeof createProvider

export class AssistantService {
  private config: AssistantConfig = readConfig({})
  private apiKey: string | null = null
  private provider: Provider | null = null
  private limiters = new Map<AssistPoint, Limiter>()

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly factory: ProviderFactory = createProvider,
    private readonly now: () => number = Date.now,
  ) {}

  configure(values: ExtensionSettingValues, apiKey: string | null): void {
    this.config = readConfig(values)
    this.apiKey = apiKey?.trim() ? apiKey.trim() : null
    this.limiters.clear()
    const endpoint = endpointOf(this.config, this.env)
    this.provider =
      this.config.provider === 'none' || !endpoint
        ? null
        : this.factory(this.config.provider, endpoint, this.apiKey)
  }

  status(): AssistStatus {
    return assistStatus(this.config, this.env, this.apiKey !== null)
  }

  private redact(message: string): string {
    const clean = this.apiKey ? message.split(this.apiKey).join('***') : message
    return clean.slice(0, ERROR_MESSAGE_MAX)
  }

  private failure(err: unknown, signal: AbortSignal): AssistFailure {
    if (err instanceof AssistFailure) return err
    if (signal.aborted || err instanceof AbortedError) return new AssistFailure('cancelled')
    if (err instanceof HttpError && err.status === 429) {
      return new AssistFailure('rate-limited', this.redact(err.message))
    }
    return new AssistFailure(
      'failed',
      this.redact(err instanceof Error ? err.message : String(err)),
    )
  }

  private ready(point: AssistPoint): Provider {
    const provider = this.provider
    if (!provider || this.status()[point]?.ready !== true) {
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

  private run(
    provider: Provider,
    point: AssistPoint,
    prompt: Prompt,
    ctx: AssistContext,
    onDelta?: (text: string) => void,
  ): Promise<string> {
    return provider.chat({
      model: modelFor(this.config, point),
      system: prompt.system,
      messages: prompt.messages,
      temperature: prompt.temperature,
      maxTokens: prompt.maxTokens,
      signal: ctx.signal,
      timeoutMs: point === 'chat' ? CHAT_TIMEOUT_MS : FAST_TIMEOUT_MS,
      onDelta,
    })
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
        chat: (req) => this.chat(provider, req, ctx),
      }
      return (await handlers[point](input)) as AssistResults[P]
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
      wantTypos ? this.run(provider, 'input', typoPrompt(req.text), ctx) : null,
      wantReview ? this.run(provider, 'input', reviewPrompt(req.text, req.agent), ctx) : null,
    ])
    const result: InputAssistResult = {}
    const corrected = typos === null ? null : parseCorrection(typos, req.text)
    if (corrected) result.corrected = corrected
    const parsed = review === null ? null : parseReview(review)
    if (parsed) result.review = parsed
    return result
  }

  private async command(provider: Provider, req: CommandAssistRequest, ctx: AssistContext) {
    const raw = await this.run(provider, 'command', commandPrompt(req), ctx)
    return { suggestions: parseCommands(raw) }
  }

  private async completion(provider: Provider, req: CompletionAssistRequest, ctx: AssistContext) {
    const raw = await this.run(provider, 'completion', completionPrompt(req), ctx)
    return { text: cleanCompletion(raw, req.prefix, req.suffix) }
  }

  private async chat(provider: Provider, req: ChatAssistRequest, ctx: AssistContext) {
    let live = true
    let pending: Promise<unknown> = Promise.resolve()
    const text = await this.run(provider, 'chat', chatPrompt(req), ctx, (delta) => {
      if (!live) return
      pending = pending
        .then(() => (live ? ctx.chunk(delta) : false))
        .then((stillLive) => {
          if (stillLive === false) live = false
        })
        .catch(() => {
          live = false
        })
    })
    await pending
    return { text }
  }

  async panelState(): Promise<PanelState> {
    const endpoint = endpointOf(this.config, this.env)
    const state: PanelState = {
      provider: this.config.provider,
      endpoint: endpoint ? describeEndpoint(endpoint) : '',
      fastModel: modelFor(this.config, 'input'),
      chatModel: modelFor(this.config, 'chat'),
      problem: setupProblem(this.config, this.env, this.apiKey !== null),
      lifecycle: this.provider?.lifecycle === true,
      models: [],
    }
    if (!this.provider || state.problem === 'no-key') return state
    try {
      state.models = await this.provider.models()
    } catch (err) {
      state.modelsError = this.redact(err instanceof Error ? err.message : String(err))
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
