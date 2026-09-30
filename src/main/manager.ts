export const BUILTIN_MANAGER_AGENTS: Readonly<Record<string, readonly string[]>> = {
  claude: ['claude'],
  codex: ['codex'],
}

const AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const MAX_ARGS = 64
const MAX_ARG_LENGTH = 4096
const MAX_PATH_LENGTH = 32 * 1024

export function parseManagerAgents(settings: unknown): Record<string, string[]> {
  const agents: Record<string, string[]> = {}
  for (const [name, argv] of Object.entries(BUILTIN_MANAGER_AGENTS)) agents[name] = [...argv]
  const manager =
    typeof settings === 'object' && settings !== null
      ? (settings as { manager?: unknown }).manager
      : undefined
  const raw =
    typeof manager === 'object' && manager !== null
      ? (manager as { agents?: unknown }).agents
      : undefined
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return agents
  for (const [name, argv] of Object.entries(raw)) {
    if (!AGENT_NAME.test(name) || !isArgv(argv)) continue
    agents[name] = [...argv]
  }
  return agents
}

function isArgv(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= MAX_ARGS &&
    value.every((a) => typeof a === 'string' && a.length > 0 && a.length <= MAX_ARG_LENGTH)
  )
}

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
    onExit: () => void
  }) => boolean
}

export class ManagerError extends Error {}

export function parseOpenRequest(raw: unknown): ManagerOpenRequest {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  if (typeof r.agent !== 'string' || !AGENT_NAME.test(r.agent)) {
    throw new ManagerError('bad-request: agent')
  }
  const args = r.args ?? []
  if (!Array.isArray(args) || args.length > MAX_ARGS) throw new ManagerError('bad-request: args')
  for (const a of args) {
    if (typeof a !== 'string' || a.length > MAX_ARG_LENGTH) {
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

export class ManagerService {
  private current: ManagerInfo | null = null
  private opening: Promise<ManagerInfo> | null = null

  constructor(private readonly deps: ManagerDeps) {}

  get live(): ManagerInfo | null {
    return this.current
  }

  isManagerPane(paneId: string): boolean {
    return this.current?.paneId === paneId
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
    if (!paneId) throw new ManagerError('no-window: Pine could not open the manager workspace')
    const info: ManagerInfo = { paneId, agent: req.agent }
    const spawned = this.deps.spawn({
      paneId,
      argv,
      cwd: req.cwd,
      cols: req.cols,
      rows: req.rows,
      ...(req.path === undefined ? {} : { path: req.path }),
      onExit: () => {
        if (this.current === info) this.current = null
      },
    })
    if (!spawned) throw new ManagerError(`spawn-failed: could not start ${argv[0]}`)
    this.current = info
    return info
  }
}
