import { NODE_MIN_MAJOR } from '../../../shared/remote/remoteNode'
import type { RemoteAgent, RemoteError } from '../../../shared/remote/remoteSetup'
import { remoteWord } from './bundle'

const TMUX_MIN = [3, 2]

export const PROBE_COMMAND = remoteWord(
  [
    'v() { command -v "$1" >/dev/null 2>&1; }',
    'n=-; v node && n=$(node -p "process.versions.node" 2>/dev/null)',
    't=-; v tmux && t=$(tmux -V 2>/dev/null | cut -d" " -f2)',
    'g=-; v git && g=$(git --version 2>/dev/null | cut -d" " -f3)',
    'c=-; v claude && c=yes',
    'x=-; v codex && x=yes',
    'echo "OSTIA-NODE node=$n tmux=$t git=$g claude=$c codex=$x"',
  ].join('; '),
)

export interface Probe {
  node: string | null
  tmux: string | null
  git: string | null
  claude: boolean
  codex: boolean
}

export function parseProbe(line: string): Probe {
  const values = new Map(line.split(' ').map((pair) => pair.split('=') as [string, string]))
  const text = (key: string): string | null => {
    const value = values.get(key)
    return value && value !== '-' ? value : null
  }
  return {
    node: text('node'),
    tmux: text('tmux'),
    git: text('git'),
    claude: text('claude') !== null,
    codex: text('codex') !== null,
  }
}

function atLeast(version: string, min: readonly number[]): boolean {
  const parts = version.match(/\d+/g)?.map(Number) ?? []
  for (let i = 0; i < min.length; i++) {
    const have = parts[i] ?? 0
    if (have !== min[i]) return have > min[i]
  }
  return true
}

export function probeProblem(
  probe: Probe,
  agent: RemoteAgent,
): { error: RemoteError; detail?: string } | null {
  if (!probe.node || !atLeast(probe.node, [NODE_MIN_MAJOR])) return { error: 'node-missing' }
  if (!probe.tmux || !atLeast(probe.tmux, TMUX_MIN)) return { error: 'tmux-missing' }
  if (!probe.git) return { error: 'git-missing' }
  if (!probe[agent]) return { error: 'agent-missing', detail: agent }
  return null
}
