import { type AgentResume, parseAgentResume } from '../shared/agentResume'
import {
  MANAGER_AGENT_NAME,
  MANAGER_MAX_ARGS,
  MANAGER_MAX_ARG_LENGTH,
} from '../shared/managerSettings'
import { PRODUCT_NAME } from '../shared/product'

const MAX_PATH_LENGTH = 32 * 1024

export interface ManagerOpenRequest {
  agent: string
  args: string[]
  cwd: string
  cols: number
  rows: number
  path?: string
}

export interface ManagerInfo {
  paneId: string
  agent: string
}

export interface ManagerDeps {
  agents: () => Record<string, string[]>
  createPane: (req: { agent: string; cwd: string }) => Promise<string | null>
  spawn: (req: {
    paneId: string
    argv: string[]
    cwd: string
    cols: number
    rows: number
    path?: string
    resume: AgentResume | null
    onExit: () => void
  }) => boolean
  loadResume: () => unknown
  saveResume: (saved: SavedManagerResume | null) => void
}

export interface SavedManagerResume {
  agent: string
  resume: AgentResume
}

export function parseSavedResume(raw: unknown): SavedManagerResume | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { agent, resume } = raw as { agent?: unknown; resume?: unknown }
  const parsed = parseAgentResume(resume)
  if (typeof agent !== 'string' || !MANAGER_AGENT_NAME.test(agent) || !parsed) return null
  return { agent, resume: parsed }
}

export class ManagerError extends Error {}

export function parseOpenRequest(raw: unknown): ManagerOpenRequest {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  if (typeof r.agent !== 'string' || !MANAGER_AGENT_NAME.test(r.agent)) {
    throw new ManagerError('bad-request: agent')
  }
  const args = r.args ?? []
  if (!Array.isArray(args) || args.length > MANAGER_MAX_ARGS)
    throw new ManagerError('bad-request: args')
  for (const a of args) {
    if (typeof a !== 'string' || a.length > MANAGER_MAX_ARG_LENGTH) {
      throw new ManagerError('bad-request: args')
    }
  }
  if (typeof r.cwd !== 'string' || !r.cwd.startsWith('/')) {
    throw new ManagerError('bad-request: cwd')
  }
  if (r.path !== undefined && (typeof r.path !== 'string' || r.path.length > MAX_PATH_LENGTH)) {
    throw new ManagerError('bad-request: path')
  }
  return {
    agent: r.agent,
    args: args as string[],
    cwd: r.cwd,
    cols: clampDim(r.cols, 80),
    rows: clampDim(r.rows, 24),
    ...(typeof r.path === 'string' ? { path: r.path } : {}),
  }
}

function clampDim(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 && n <= 1000 ? n : fallback
}

export function managerWindowId(
  mainWindowId: string | undefined,
  readyWindowIds: ReadonlySet<string>,
): string | null {
  return mainWindowId !== undefined && readyWindowIds.has(mainWindowId) ? mainWindowId : null
}

export class ManagerService {
  private current: ManagerInfo | null = null
  private opening: Promise<ManagerInfo> | null = null
  private stopping = false

  constructor(private readonly deps: ManagerDeps) {}

  get live(): ManagerInfo | null {
    return this.current
  }

  isManagerPane(paneId: string): boolean {
    return this.current?.paneId === paneId
  }

  rememberResume(resume: AgentResume): void {
    if (this.current) this.deps.saveResume({ agent: this.current.agent, resume })
  }

  shutdown(): void {
    this.stopping = true
  }

  async open(req: ManagerOpenRequest): Promise<{ info: ManagerInfo; created: boolean }> {
    const agents = this.deps.agents()
    const preset = agents[req.agent]
    if (!preset) {
      throw new ManagerError(
        `unknown-agent: ${req.agent} (known: ${Object.keys(agents).join(', ')})`,
      )
    }
    if (this.opening) await this.opening.catch(() => {})
    if (this.current) {
      if (this.current.agent !== req.agent) {
        throw new ManagerError(`manager-busy: the manager is running ${this.current.agent}`)
      }
      return { info: this.current, created: false }
    }
    this.opening = this.start(req, [...preset, ...req.args])
    try {
      return { info: await this.opening, created: true }
    } finally {
      this.opening = null
    }
  }

  private async start(req: ManagerOpenRequest, argv: string[]): Promise<ManagerInfo> {
    const paneId = await this.deps.createPane({ agent: req.agent, cwd: req.cwd })
    if (!paneId)
      throw new ManagerError(`no-window: ${PRODUCT_NAME} could not open the manager workspace`)
    const info: ManagerInfo = { paneId, agent: req.agent }
    const saved = parseSavedResume(this.deps.loadResume())
    const resume = saved?.agent === req.agent && req.args.length === 0 ? saved.resume : null
    const spawned = this.deps.spawn({
      paneId,
      argv,
      cwd: req.cwd,
      cols: req.cols,
      rows: req.rows,
      ...(req.path === undefined ? {} : { path: req.path }),
      resume,
      onExit: () => {
        if (this.current !== info) return
        this.current = null
        if (!this.stopping) this.deps.saveResume(null)
      },
    })
    if (!spawned) throw new ManagerError(`spawn-failed: could not start ${argv[0]}`)
    this.current = info
    return info
  }
}
