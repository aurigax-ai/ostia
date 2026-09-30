export const MANAGER_AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
export const MANAGER_MAX_ARGS = 64
export const MANAGER_MAX_ARG_LENGTH = 4096
export const MANAGER_MAX_SKILLS = 32
const MAX_SKILL_PATH = 4096

export const BUILTIN_MANAGER_AGENTS: Readonly<Record<string, readonly string[]>> = {
  claude: ['claude'],
  codex: ['codex'],
}

export interface ManagerLimits {
  maxWorkers: number
  spawnsPer10Min: number
  busPerMinute: number
}

export interface ManagerSettings {
  agents: Record<string, string[]>
  skills: string[]
  allowInput: boolean
  limits: ManagerLimits
}

export const MANAGER_LIMIT_BOUNDS: Readonly<Record<keyof ManagerLimits, [number, number]>> = {
  maxWorkers: [0, 64],
  spawnsPer10Min: [0, 200],
  busPerMinute: [0, 600],
}

export const DEFAULT_MANAGER_LIMITS: ManagerLimits = {
  maxWorkers: 8,
  spawnsPer10Min: 20,
  busPerMinute: 60,
}

export const DEFAULT_MANAGER_SETTINGS: ManagerSettings = {
  agents: {},
  skills: [],
  allowInput: false,
  limits: DEFAULT_MANAGER_LIMITS,
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

export function isManagerArgv(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= MANAGER_MAX_ARGS &&
    typeof value[0] === 'string' &&
    value[0].length > 0 &&
    value.every((a) => typeof a === 'string' && a.length <= MANAGER_MAX_ARG_LENGTH)
  )
}

export function isSkillPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.startsWith('/') &&
    value.length <= MAX_SKILL_PATH &&
    !value.split('/').includes('..')
  )
}

function clampLimit(key: keyof ManagerLimits, value: unknown): number {
  const [min, max] = MANAGER_LIMIT_BOUNDS[key]
  const n = Number(value)
  if (!Number.isFinite(n)) return DEFAULT_MANAGER_LIMITS[key]
  return Math.min(max, Math.max(min, Math.round(n)))
}

export function parseManagerSettings(raw: unknown): ManagerSettings {
  if (!isObject(raw)) return DEFAULT_MANAGER_SETTINGS
  const agents: Record<string, string[]> = {}
  if (isObject(raw.agents)) {
    for (const [name, argv] of Object.entries(raw.agents)) {
      if (MANAGER_AGENT_NAME.test(name) && isManagerArgv(argv)) agents[name] = [...argv]
    }
  }
  const skills = Array.isArray(raw.skills)
    ? [...new Set(raw.skills.filter(isSkillPath))].slice(0, MANAGER_MAX_SKILLS)
    : []
  const limitsRaw = isObject(raw.limits) ? raw.limits : {}
  return {
    agents,
    skills,
    allowInput: raw.allowInput === true,
    limits: {
      maxWorkers: clampLimit('maxWorkers', limitsRaw.maxWorkers),
      spawnsPer10Min: clampLimit('spawnsPer10Min', limitsRaw.spawnsPer10Min),
      busPerMinute: clampLimit('busPerMinute', limitsRaw.busPerMinute),
    },
  }
}

export function managerAgents(settings: ManagerSettings): Record<string, string[]> {
  const agents: Record<string, string[]> = {}
  for (const [name, argv] of Object.entries(BUILTIN_MANAGER_AGENTS)) agents[name] = [...argv]
  return { ...agents, ...settings.agents }
}
