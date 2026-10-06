import type { ApprovalRequest } from '@shared/approvals'
import type { QuestionRequest } from '@shared/questions'
import type { AttentionState } from '@shared/types'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { PaneNode } from '../layout/types'
import { useAgentTurnStore } from '../stores/agentTurnStore'
import { useApprovalsStore } from '../stores/approvalsStore'
import { useAttentionStore } from '../stores/attentionStore'
import { type CommandBlock, useBlocksStore } from '../stores/blocksStore'
import { useCloseConfirmStore } from '../stores/closeConfirmStore'
import { useEditorStatus } from '../stores/editorStatusStore'
import { useLayoutStore } from '../stores/layoutStore'
import { useQuestionsStore } from '../stores/questionsStore'
import { useSettingsStore } from '../stores/settingsStore'
import { type WorkspaceKind, useWorkspacesStore } from '../stores/workspacesStore'
import { quitGroups, quitLosses, requestClosePane } from './closeConfirm'

type Row =
  | 'idle shell'
  | 'foreground process'
  | 'agent working'
  | 'agent waiting'
  | 'agent idle'
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

function seedWorkspace(pane: PaneNode, kind: WorkspaceKind = 'terminal'): void {
  useWorkspacesStore.setState({
    workspaces: [{ id: 'w1', name: 'alpha', kind, workDir: '/w', state: 'idle' }],
    activeWorkspaceId: 'w1',
  })
  useLayoutStore.setState({
    byWorkspace: { w1: { root: pane, activePaneId: pane.id, zoomedPaneId: null } },
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

function seedRow(row: Row): void {
  if (row === 'unsaved editor') {
    seedWorkspace({ type: 'pane', id: 'p1', title: 'notes.md', kind: 'editor', filePath: FILE })
    useEditorStatus.getState().setDirty(FILE, true)
    return
  }
  seedWorkspace(terminal('p1', row.startsWith('agent')))
  if (row === 'idle shell') return
  if (row === 'foreground process') {
    run('p1', 'npm run dev')
    return
  }
  run('p1', 'claude')
  if (row === 'agent working') reportTurn('p1', 'working')
  if (row === 'agent waiting') reportTurn('p1', 'waiting')
  if (row === 'agent idle') reportTurn('p1', 'done')
}

function kept(keepShells: KeepShells, row: Row): Set<string> {
  return keepShells === 'on, restart' && row !== 'unsaved editor' ? new Set(['p1']) : new Set()
}

function lost(keep: ReadonlySet<string> = new Set()): Lost[] {
  const losses = quitLosses(quitGroups(keep))
  const out: Lost[] = []
  if (losses.processes > 0) out.push('processes')
  if (losses.agents > 0) out.push('agents')
  if (losses.files > 0) out.push('files')
  return out.length > 0 ? out : ['nothing']
}

const TABLE: [Row, KeepShells, boolean, Lost][] = []
const EXPECTED: Record<Row, (keepShells: KeepShells, autoResume: boolean) => Lost> = {
  'idle shell': () => 'nothing',
  'foreground process': (k) => (k === 'on, restart' ? 'nothing' : 'processes'),
  'agent working': (k) => (k === 'on, restart' ? 'nothing' : 'agents'),
  'agent waiting': (k) => (k === 'on, restart' ? 'nothing' : 'agents'),
  'agent idle': (k, autoResume) => (k === 'on, restart' || autoResume ? 'nothing' : 'agents'),
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
    seedRow(row)
    expect(lost(kept(keep, row))).toEqual([expected])
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
      await Promise.resolve()
      expect(useCloseConfirmStore.getState().pending?.groups[0]?.agents).toEqual(['claude'])
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
})
