import type { LayoutNode, PaneNode } from '@/layout/types'
import { useAgentTurnStore } from '@/stores/agentTurnStore'
import { useApprovalsStore } from '@/stores/approvalsStore'
import { useAttentionStore } from '@/stores/attentionStore'
import { type CommandBlock, useBlocksStore } from '@/stores/blocksStore'
import { useCloseConfirmStore } from '@/stores/closeConfirmStore'
import { useEditorStatus } from '@/stores/editorStatusStore'
import { useLayoutStore } from '@/stores/layoutStore'
import { useQuestionsStore } from '@/stores/questionsStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { type WorkspaceKind, useWorkspacesStore } from '@/stores/workspacesStore'
import type { ApprovalRequest } from '@shared/approvals'
import type { QuestionRequest } from '@shared/questions'
import type { AttentionState, PaneActivity } from '@shared/types'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  collectQuitGroups,
  quitGroups,
  quitLosses,
  requestClosePane,
  requestCloseWorkspace,
} from './closeConfirm'

type Row =
  | 'idle shell'
  | 'nested idle shell'
  | 'foreground process'
  | 'process without shell integration'
  | 'agent working'
  | 'agent waiting'
  | 'agent idle'
  | 'agent the renderer lost'
  | 'hibernated pane'
  | 'unsaved editor'
type KeepShells = 'off' | 'on, quit' | 'on, restart'
type Lost = 'nothing' | 'processes' | 'agents' | 'files'

const FILE = '/w/notes.md'
const RESUME = { agent: 'claude' as const, id: 'session-1' }

function terminal(id: string, resume = true): PaneNode {
  return {
    type: 'pane',
    id,
    title: 'Terminal',
    kind: 'terminal',
    ...(resume ? { resume: RESUME } : {}),
  }
}

function seedWorkspace(root: LayoutNode, kind: WorkspaceKind = 'terminal'): void {
  useWorkspacesStore.setState({
    workspaces: [{ id: 'w1', name: 'alpha', kind, workDir: '/w', state: 'idle' }],
    activeWorkspaceId: 'w1',
  })
  const activePaneId = root.type === 'tabs' ? root.activeId : root.id
  useLayoutStore.setState({
    byWorkspace: { w1: { root, activePaneId, zoomedPaneId: null } },
  })
}

function run(paneId: string, command: string, blockId = 'b1'): void {
  useBlocksStore.setState((s) => ({
    running: { ...s.running, [paneId]: blockId },
    byPane: {
      ...s.byPane,
      [paneId]: [...(s.byPane[paneId] ?? []), { id: blockId, paneId, command } as CommandBlock],
    },
  }))
}

function reportTurn(paneId: string, state: AttentionState): void {
  useAgentTurnStore.getState().report(paneId, state)
  useAttentionStore.getState().dispatch(paneId, { type: 'set', state, at: Date.now() })
}

function prompt(paneId: string, remote = false): void {
  useBlocksStore.getState().promptStart(paneId, { line: 9 }, '/w', remote)
}

function seedRow(row: Row): Record<string, PaneActivity> {
  if (row === 'unsaved editor') {
    seedWorkspace({ type: 'pane', id: 'p1', title: 'notes.md', kind: 'editor', filePath: FILE })
    useEditorStatus.getState().setDirty(FILE, true)
    return {}
  }
  if (row === 'hibernated pane') {
    seedWorkspace({ ...terminal('p1'), hibernated: true })
    run('p1', 'claude')
    return { p1: { program: 'claude', agentRunning: true } }
  }
  seedWorkspace(terminal('p1', row.startsWith('agent')))
  if (row === 'idle shell') {
    prompt('p1')
    return {}
  }
  if (row === 'process without shell integration') {
    return { p1: { program: 'sleep', agentRunning: false } }
  }
  if (row === 'agent the renderer lost') return { p1: { program: 'claude', agentRunning: true } }
  if (row === 'nested idle shell') {
    run('p1', 'zsh')
    prompt('p1')
    return { p1: { program: 'zsh', agentRunning: false } }
  }
  if (row === 'foreground process') {
    run('p1', 'npm run dev')
    return {}
  }
  run('p1', 'claude')
  if (row === 'agent working') reportTurn('p1', 'working')
  if (row === 'agent waiting') reportTurn('p1', 'waiting')
  if (row === 'agent idle') reportTurn('p1', 'done')
  return {}
}

function kept(keepShells: KeepShells, row: Row): Set<string> {
  return keepShells === 'on, restart' && row !== 'unsaved editor' ? new Set(['p1']) : new Set()
}

function lost(
  keep: ReadonlySet<string> = new Set(),
  activity: Record<string, PaneActivity> = {},
): Lost[] {
  const losses = quitLosses(quitGroups(keep, activity))
  const out: Lost[] = []
  if (losses.processes > 0) out.push('processes')
  if (losses.agents > 0) out.push('agents')
  if (losses.files > 0) out.push('files')
  return out.length > 0 ? out : ['nothing']
}

const TABLE: [Row, KeepShells, boolean, Lost][] = []
const EXPECTED: Record<Row, (keepShells: KeepShells, autoResume: boolean) => Lost> = {
  'idle shell': () => 'nothing',
  'nested idle shell': () => 'nothing',
  'foreground process': (k) => (k === 'on, restart' ? 'nothing' : 'processes'),
  'process without shell integration': (k) => (k === 'on, restart' ? 'nothing' : 'processes'),
  'agent working': (k) => (k === 'on, restart' ? 'nothing' : 'agents'),
  'agent waiting': (k) => (k === 'on, restart' ? 'nothing' : 'agents'),
  'agent idle': (k, autoResume) => (k === 'on, restart' || autoResume ? 'nothing' : 'agents'),
  'agent the renderer lost': (k) => (k === 'on, restart' ? 'nothing' : 'agents'),
  'hibernated pane': () => 'nothing',
  'unsaved editor': () => 'files',
}
for (const row of Object.keys(EXPECTED) as Row[]) {
  for (const keepShells of ['off', 'on, quit', 'on, restart'] as KeepShells[]) {
    for (const autoResume of [false, true]) {
      TABLE.push([row, keepShells, autoResume, EXPECTED[row](keepShells, autoResume)])
    }
  }
}

describe('what a quit loses', () => {
  const init = {
    workspaces: useWorkspacesStore.getState(),
    layout: useLayoutStore.getState(),
    blocks: useBlocksStore.getState(),
    settings: useSettingsStore.getState(),
    attention: useAttentionStore.getState(),
    turns: useAgentTurnStore.getState(),
    approvals: useApprovalsStore.getState(),
    questions: useQuestionsStore.getState(),
  }

  beforeAll(() => {
    useEditorStatus.getState().setDirty(FILE, false)
  })

  afterEach(() => {
    useWorkspacesStore.setState(init.workspaces, true)
    useLayoutStore.setState(init.layout, true)
    useBlocksStore.setState(init.blocks, true)
    useSettingsStore.setState(init.settings, true)
    useAttentionStore.setState(init.attention, true)
    useAgentTurnStore.setState(init.turns, true)
    useApprovalsStore.setState(init.approvals, true)
    useQuestionsStore.setState(init.questions, true)
    useCloseConfirmStore.setState({ pending: null })
    useEditorStatus.getState().setDirty(FILE, false)
  })

  it.each(TABLE)('%s | keep-shells %s | auto-resume %s', (row, keep, auto, expected) => {
    useSettingsStore.getState().setAutoResume(auto)
    const activity = seedRow(row)
    expect(lost(kept(keep, row), activity)).toEqual([expected])
  })

  describe('an idle agent with auto-resume on', () => {
    function idleAgent(pane: PaneNode = terminal('p1'), kind: WorkspaceKind = 'terminal'): void {
      useSettingsStore.getState().setAutoResume(true)
      seedWorkspace(pane, kind)
      run('p1', 'claude')
      reportTurn('p1', 'done')
    }

    it('quits without asking', () => {
      idleAgent()
      expect(quitGroups()).toEqual([])
    })

    it('still asks when session restore is off, since nothing brings the pane back', () => {
      idleAgent()
      useSettingsStore.getState().setBehavior({ restoreWorkspace: false })
      expect(lost()).toEqual(['agents'])
    })

    it('still asks in a scratch workspace, which is not restored', () => {
      idleAgent(terminal('p1'), 'scratch')
      expect(lost()).toEqual(['agents'])
    })

    it('still asks when the agent never reported a session to resume', () => {
      idleAgent(terminal('p1', false))
      expect(lost()).toEqual(['agents'])
    })

    it('still asks when the agent never reported an ended turn', () => {
      useSettingsStore.getState().setAutoResume(true)
      seedWorkspace(terminal('p1'))
      run('p1', 'claude')
      expect(lost()).toEqual(['agents'])
    })

    it('still asks when the ended turn belongs to an earlier command in the pane', () => {
      idleAgent()
      run('p1', 'claude', 'b2')
      expect(lost()).toEqual(['agents'])
    })

    it('still asks once the agent starts a new turn', () => {
      idleAgent()
      reportTurn('p1', 'working')
      expect(lost()).toEqual(['agents'])
    })

    it('still asks while the pane waits on an Ostia approval or question', () => {
      idleAgent()
      useApprovalsStore.setState({ pending: [{ id: 'a1', paneId: 'p1' } as ApprovalRequest] })
      expect(lost()).toEqual(['agents'])
      useApprovalsStore.setState({ pending: [] })
      useQuestionsStore.setState({ pending: [{ id: 'q1', paneId: 'p1' } as QuestionRequest] })
      expect(lost()).toEqual(['agents'])
    })

    it('still asks when the pane shows it is waiting for you', () => {
      idleAgent()
      useAttentionStore.getState().dispatch('p1', { type: 'set', state: 'waiting', at: Date.now() })
      expect(lost()).toEqual(['agents'])
    })

    it('still asks before closing its pane, which nothing restores', async () => {
      idleAgent()
      void requestClosePane('w1', 'p1')
      await vi.waitFor(() => {
        expect(useCloseConfirmStore.getState().pending?.groups[0]?.agents).toEqual(['claude'])
      })
    })
  })

  it('counts what each workspace loses for the quit dialog', () => {
    const losses = quitLosses([
      { workspaceId: 'w1', workspace: 'a', commands: ['npm run dev', 'make'], files: [FILE] },
      { workspaceId: 'w2', workspace: 'b', commands: [], agents: ['claude'], files: [] },
      { workspaceId: 'w3', workspace: 'c', commands: [], files: [], scratchFiles: 3 },
    ])
    expect(losses).toEqual({ processes: 2, agents: 1, files: 1, scratchFiles: 3 })
  })

  it('asks about nothing when quit confirmation is off', () => {
    useSettingsStore.getState().setWorkspaces({ confirmQuit: false })
    seedRow('foreground process')
    expect(quitGroups()).toEqual([])
  })

  describe('what shell integration cannot see', () => {
    function plainShell(paneId: string, program: string | null, agentRunning = false): void {
      const answers: Record<string, PaneActivity> = { [paneId]: { program, agentRunning } }
      vi.mocked(window.ostia.pty.activity).mockImplementation(async (id) => answers[id] ?? null)
    }

    beforeEach(() => {
      vi.mocked(window.ostia.pty.activity).mockReset()
      vi.mocked(window.ostia.pty.activity).mockResolvedValue(null)
    })

    it('asks about a program running in a shell that reports no blocks', async () => {
      seedWorkspace(terminal('p1', false))
      plainShell('p1', 'sleep')
      expect((await collectQuitGroups(new Set())).map((g) => g.commands)).toEqual([['sleep']])
    })

    it('counts an agent running in such a shell as an agent', async () => {
      seedWorkspace(terminal('p1', false))
      plainShell('p1', 'claude')
      expect((await collectQuitGroups(new Set())).map((g) => g.agents)).toEqual([['claude']])
    })

    it('quits at once when that shell is at its own prompt', async () => {
      seedWorkspace(terminal('p1', false))
      plainShell('p1', null)
      expect(await collectQuitGroups(new Set())).toEqual([])
    })

    it('ignores the program in front of a pane whose shell reports blocks', async () => {
      seedWorkspace(terminal('p1', false))
      prompt('p1')
      plainShell('p1', 'bash')
      expect(await collectQuitGroups(new Set())).toEqual([])
    })

    it('asks about an agent main still sees running after the renderer lost its blocks', async () => {
      seedWorkspace(terminal('p1'))
      plainShell('p1', null, true)
      expect((await collectQuitGroups(new Set())).map((g) => g.agents)).toEqual([['claude']])
    })

    it('asks before closing a pane whose agent runs in a background tab', async () => {
      seedWorkspace({
        type: 'tabs',
        id: 't1',
        activeId: 'p2',
        children: [terminal('p1'), terminal('p2', false)],
      })
      plainShell('p1', null, true)
      void requestCloseWorkspace('w1')
      await vi.waitFor(() => {
        expect(useCloseConfirmStore.getState().pending?.groups[0]?.agents).toEqual(['claude'])
      })
    })

    it('does not ask about a hibernated pane even when main remembers its agent', async () => {
      seedWorkspace({ ...terminal('p1'), hibernated: true })
      plainShell('p1', null, true)
      expect(await collectQuitGroups(new Set())).toEqual([])
      expect(window.ostia.pty.activity).not.toHaveBeenCalled()
    })

    it('asks before closing a pane or a workspace whose plain shell runs a program', async () => {
      seedWorkspace(terminal('p1', false))
      plainShell('p1', 'make')
      void requestClosePane('w1', 'p1')
      await vi.waitFor(() => {
        expect(useCloseConfirmStore.getState().pending?.groups[0]?.commands).toEqual(['make'])
      })
      useCloseConfirmStore.getState().answer(false)
      void requestCloseWorkspace('w1')
      await vi.waitFor(() => {
        expect(useCloseConfirmStore.getState().pending?.kind).toBe('workspace')
      })
    })
  })

  describe('a nested shell at its prompt', () => {
    it('does not count as running, since the program in front is a shell waiting for input', () => {
      seedWorkspace(terminal('p1', false))
      run('p1', 'nix-shell')
      prompt('p1')
      expect(quitGroups()).toEqual([])
    })

    it('still counts once it runs a command, which ends the stale block', () => {
      seedWorkspace(terminal('p1', false))
      run('p1', 'bash')
      prompt('p1')
      useBlocksStore.getState().commandStart('p1', { line: 10 }, 'npm test')
      expect(quitGroups().map((g) => g.commands)).toEqual([['npm test']])
    })

    it('still counts when the prompt comes from a remote shell over ssh', () => {
      seedWorkspace(terminal('p1', false))
      run('p1', 'ssh build-box')
      prompt('p1', true)
      expect(quitGroups().map((g) => g.commands)).toEqual([['ssh build-box']])
    })
  })

  describe('the manager workspace', () => {
    function seedManager(): void {
      seedWorkspace({ type: 'pane', id: 'm1', title: 'Manager', kind: 'manager' }, 'manager')
    }

    it('does not ask once its agent has ended its turn, since it resumes on the next start', () => {
      seedManager()
      reportTurn('m1', 'done')
      expect(quitGroups()).toEqual([])
    })

    it('asks while its agent works or waits, or before it has reported a turn', () => {
      seedManager()
      expect(lost()).toEqual(['agents'])
      reportTurn('m1', 'working')
      expect(lost()).toEqual(['agents'])
      reportTurn('m1', 'waiting')
      expect(lost()).toEqual(['agents'])
    })
  })
})
