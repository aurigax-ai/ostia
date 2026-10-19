import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type {
  AgentModelRef,
  AgentProviderEntry,
  AgentToolCall,
  AgentToolReply,
  AgentToolSpec,
} from '@aurigax-ai/ostia-extension-sdk/contract/agent'
import { InMemoryCredentialStore, Type } from '@earendil-works/pi-ai'
import {
  type AgentSession,
  ModelRuntime,
  type ResourceLoader,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
  createAgentSession,
  createExtensionRuntime,
  defineTool,
  loadSkills,
} from '@earendil-works/pi-coding-agent'
import { agentSystemPrompt } from './systemPrompt'

type ToolCaller = (call: AgentToolCall, signal: AbortSignal) => Promise<AgentToolReply>

export interface PiSessionOptions {
  sessionId: string
  cwd: string
  dataDir: string
  tools: AgentToolSpec[]
  providers: AgentProviderEntry[]
  skillFolders: string[]
  model?: AgentModelRef
  callTool: ToolCaller
}

export interface PiSession {
  session: AgentSession
  model: AgentModelRef | null
}

const NO_KEY = 'none'
const FREE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

function sessionsDir(dataDir: string): string {
  return join(dataDir, 'sessions')
}

function agentDirOf(dataDir: string): string {
  return join(dataDir, 'pi')
}

async function modelRuntime(providers: AgentProviderEntry[]): Promise<ModelRuntime> {
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  })
  for (const provider of providers) {
    runtime.registerProvider(provider.id, {
      name: provider.name,
      baseUrl: provider.baseUrl,
      api: 'openai-completions',
      apiKey: NO_KEY,
      models: provider.models.map((id) => ({
        id,
        name: id,
        input: ['text'],
        cost: FREE,
        reasoning: false,
        contextWindow: 128_000,
        maxTokens: 16_384,
      })),
    })
  }
  return runtime
}

function resourceLoader(opts: PiSessionOptions): ResourceLoader {
  const skills = loadSkills({
    cwd: opts.cwd,
    agentDir: agentDirOf(opts.dataDir),
    skillPaths: opts.skillFolders,
    includeDefaults: false,
  })
  const system = agentSystemPrompt(opts.cwd)
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => skills,
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => system,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => undefined,
    reload: async () => undefined,
  }
}

function toolDefinition(spec: AgentToolSpec, opts: PiSessionOptions): ToolDefinition {
  return defineTool({
    name: spec.name,
    label: spec.name,
    description: spec.description,
    promptSnippet: spec.description.split('\n')[0],
    parameters: Type.Unsafe(spec.inputSchema),
    async execute(toolCallId, params, signal) {
      const reply = await opts.callTool(
        {
          sessionId: opts.sessionId,
          toolCallId,
          name: spec.name,
          input: params as Record<string, unknown>,
        },
        signal ?? new AbortController().signal,
      )
      const text = reply.ok ? reply.output : reply.error
      return { content: [{ type: 'text', text }], details: {}, isError: !reply.ok }
    },
  }) as ToolDefinition
}

function chosenModel(runtime: ModelRuntime, opts: PiSessionOptions) {
  const wanted = opts.model
  if (wanted) {
    const model = runtime.getModel(wanted.provider, wanted.model)
    if (model) return model
  }
  for (const provider of opts.providers) {
    const model = runtime.getModel(provider.id, provider.models[0] ?? '')
    if (model) return model
  }
  return undefined
}

export async function openPiSession(opts: PiSessionOptions): Promise<PiSession> {
  const sessions = sessionsDir(opts.dataDir)
  mkdirSync(sessions, { recursive: true })
  mkdirSync(agentDirOf(opts.dataDir), { recursive: true })
  const runtime = await modelRuntime(opts.providers)
  const existing = SessionManager.findById(opts.cwd, opts.sessionId, sessions)
  const sessionManager = existing
    ? SessionManager.open(existing, sessions, opts.cwd)
    : SessionManager.create(opts.cwd, sessions, { id: opts.sessionId })
  const model = chosenModel(runtime, opts)
  const { session } = await createAgentSession({
    cwd: opts.cwd,
    agentDir: agentDirOf(opts.dataDir),
    modelRuntime: runtime,
    resourceLoader: resourceLoader(opts),
    settingsManager: SettingsManager.inMemory({
      cacheWarming: 'off',
      enableInstallTelemetry: false,
    }),
    sessionManager,
    customTools: opts.tools.map((spec) => toolDefinition(spec, opts)),
    tools: opts.tools.map((spec) => spec.name),
    ...(model ? { model } : {}),
  })
  return { session, model: model ? { provider: model.provider, model: model.id } : null }
}
