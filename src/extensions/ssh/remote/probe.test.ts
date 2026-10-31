import { describe, expect, it } from 'vitest'
import { parseProbe, probeProblem } from './probe'

const full = 'node=20.11.0 tmux=3.4 git=2.43.0 claude=yes codex=-'

describe('probe', () => {
  it('REM-U1 reads the host tools and names the first one that is missing or too old', () => {
    const probe = parseProbe(full)
    expect(probe).toEqual({
      node: '20.11.0',
      tmux: '3.4',
      git: '2.43.0',
      claude: true,
      codex: false,
    })
    expect(probeProblem(probe, 'claude')).toBeNull()
    expect(probeProblem(probe, 'codex')).toEqual({ error: 'agent-missing', detail: 'codex' })
    expect(probeProblem({ ...probe, node: '18.19.0' }, 'claude')).toEqual({ error: 'node-missing' })
    expect(probeProblem({ ...probe, tmux: '3.1' }, 'claude')).toEqual({ error: 'tmux-missing' })
    expect(probeProblem({ ...probe, tmux: null }, 'claude')).toEqual({ error: 'tmux-missing' })
    expect(probeProblem({ ...probe, git: null }, 'claude')).toEqual({ error: 'git-missing' })
  })

  it('REM-U2 accepts a tmux version with a letter suffix', () => {
    expect(
      probeProblem(parseProbe('node=22.0.0 tmux=3.3a git=2 claude=yes codex=-'), 'claude'),
    ).toBeNull()
  })
})
