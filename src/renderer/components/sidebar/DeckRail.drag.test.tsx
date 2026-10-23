import '@testing-library/jest-dom/vitest'
import { act, cleanup, createEvent, fireEvent } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceGroup } from '@/lib/sidebar/workspaceGroups'
import { useRailDragStore } from '@/stores/workspaces/railDragStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import type { Workspace } from '@/stores/workspaces/workspaceTypes'
import { renderSettled } from '../../../../test/render'
import { DeckRail } from './DeckRail'
import { GROUP_DND, WORKSPACE_DND } from './railDrag'

const ws = (id: string, name: string, extra: Partial<Workspace> = {}): Workspace => ({
  id,
  name,
  kind: 'terminal',
  workDir: `/${name}`,
  state: 'idle',
  ...extra,
})

const SEED: Workspace[] = [
  ws('p1', 'pin', { pinned: true }),
  ws('s1', 'solo'),
  ws('s2', 'api', { groupId: 'g90' }),
  ws('s3', 'web', { groupId: 'g90' }),
  ws('s4', 'tail'),
  ws('s5', 'opsone', { groupId: 'g80' }),
]
const GROUPS: WorkspaceGroup[] = [
  { id: 'g90', name: 'backend' },
  { id: 'g80', name: 'ops', collapsed: true },
]
const NAMES = new Map(SEED.map((w) => [w.name, w.id]))
const GROUP_NAMES = new Map(GROUPS.map((g) => [g.name, g.id]))
const FRACTIONS = [0.05, 0.25, 0.5, 0.75, 0.95]

type Source = { kind: 'workspace'; id: string } | { kind: 'group'; id: string }
type Mark = { on: 'row' | 'group' | 'end'; id: string; place: string }
type Entry = { id: string; groupId: string | undefined; pinned: boolean }

const seed = (): void =>
  act(() => {
    useWorkspacesStore.setState({ workspaces: SEED, groups: GROUPS, activeWorkspaceId: 'p1' })
  })

const snapshot = (): Entry[] =>
  useWorkspacesStore
    .getState()
    .workspaces.map((w) => ({ id: w.id, groupId: w.groupId, pinned: w.pinned === true }))

const SEEDED: Entry[] = SEED.map((w) => ({ id: w.id, groupId: w.groupId, pinned: !!w.pinned }))

const railRows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.rail-row')]
const railHeads = (): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>('.rail-group-head'),
]
const rowId = (el: Element): string =>
  NAMES.get(el.querySelector('.tab-title')?.textContent ?? '') ?? '?'
const headId = (el: Element): string =>
  GROUP_NAMES.get(el.querySelector('.rail-group-name')?.textContent ?? '') ?? '?'

function sourceEl(source: Source): HTMLElement {
  const list = source.kind === 'workspace' ? railRows() : railHeads()
  const el = list.find((e) => (source.kind === 'workspace' ? rowId(e) : headId(e)) === source.id)
  if (!el) throw new Error(`no element for ${source.id}`)
  return el
}

function readMarks(): Mark[] {
  return [...document.querySelectorAll('[data-drop]')].map((el) => {
    const place = el.getAttribute('data-drop') ?? ''
    if (el.classList.contains('rail-row')) return { on: 'row', id: rowId(el), place }
    if (el.classList.contains('rail-drop-end')) return { on: 'end', id: '', place }
    const head = el.classList.contains('rail-group-head')
      ? el
      : el.querySelector('.rail-group-head')
    return { on: 'group', id: head ? headId(head) : '?', place }
  })
}

function transfer(source: Source) {
  return {
    types: [source.kind === 'workspace' ? WORKSPACE_DND : GROUP_DND],
    setData: vi.fn(),
    effectAllowed: '',
    dropEffect: '',
  }
}

function fireAt(
  el: Element,
  make: typeof createEvent.dragOver,
  dataTransfer: ReturnType<typeof transfer>,
  fraction: number,
): void {
  const event = make(el, { dataTransfer })
  Object.defineProperty(event, 'clientY', { value: fraction * 100 })
  fireEvent(el, event)
}

function membersOf(order: Entry[], groupId: string): string[] {
  return order.filter((e) => e.groupId === groupId).map((e) => e.id)
}

function landedWhereShown(source: Source, mark: Mark | null, order: Entry[]): boolean {
  const unchanged = JSON.stringify(order) === JSON.stringify(SEEDED)
  if (mark === null) return unchanged
  if (unchanged) return false
  const at = (id: string): number => order.findIndex((e) => e.id === id)
  const moved = source.kind === 'workspace' ? [source.id] : membersOf(order, source.id)
  const first = at(moved[0])
  const last = at(moved[moved.length - 1])
  const own = order[first]
  const groupOf = (id: string): string | undefined => order[at(id)]?.groupId
  if (mark.on === 'end')
    return last === order.length - 1 && (source.kind === 'group' || !own.groupId)
  if (mark.on === 'row') {
    const sameGroup = source.kind === 'group' || own.groupId === groupOf(mark.id)
    if (mark.place === 'before') return order[last + 1]?.id === mark.id && sameGroup
    if (mark.place === 'after') return order[first - 1]?.id === mark.id && sameGroup
    return false
  }
  const target = membersOf(order, mark.id)
  if (mark.place === 'inside') return source.kind === 'workspace' && own.groupId === mark.id
  const outside = source.kind === 'group' || !own.groupId
  if (mark.place === 'before') return outside && order[last + 1]?.id === target[0]
  if (mark.place === 'after') return outside && order[first - 1]?.id === target[target.length - 1]
  return false
}

function sweep(source: Source): void {
  const shown = new Map<string, string>()
  const targets = (): Element[] => [...railRows(), ...railHeads()]
  for (let i = 0; i < targets().length; i++) {
    for (const fraction of FRACTIONS) {
      seed()
      const el = targets()[i]
      const where = `${source.id} over ${el.textContent?.slice(0, 12)} at ${fraction}`
      const dataTransfer = transfer(source)
      const from = sourceEl(source)
      fireEvent.dragStart(from, { dataTransfer })
      fireAt(el, createEvent.dragOver, dataTransfer, fraction)
      const marks = readMarks()
      expect(marks.length, where).toBeLessThanOrEqual(1)
      const mark = marks[0] ?? null
      fireAt(el, createEvent.drop, dataTransfer, fraction)
      fireEvent.dragEnd(from, { dataTransfer })
      const order = snapshot()
      expect(landedWhereShown(source, mark, order), `${where}: ${JSON.stringify(mark)}`).toBe(true)
      const result = JSON.stringify(order)
      const markKey = JSON.stringify(mark)
      expect(shown.get(result) ?? markKey, `${where}: one mark per landing`).toBe(markKey)
      shown.set(result, markKey)
    }
  }
}

describe('DeckRail drag and drop', () => {
  let workspacesInit: ReturnType<typeof useWorkspacesStore.getState>
  let railDragInit: ReturnType<typeof useRailDragStore.getState>

  beforeAll(() => {
    workspacesInit = useWorkspacesStore.getState()
    railDragInit = useRailDragStore.getState()
  })

  beforeEach(() => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      bottom: 100,
      height: 100,
      left: 0,
      right: 200,
      width: 200,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })
  })

  afterEach(() => {
    cleanup()
    useWorkspacesStore.setState(workspacesInit, true)
    useRailDragStore.setState(railDragInit, true)
    vi.restoreAllMocks()
  })

  it.each(SEED.filter((w) => w.groupId !== 'g80').map((w) => w.id))(
    'shows at most one mark while workspace %s crosses every row and header, and drops where it showed',
    async (id) => {
      seed()
      await renderSettled(<DeckRail />)
      sweep({ kind: 'workspace', id })
    },
  )

  it.each(GROUPS.map((g) => g.id))(
    'shows at most one mark while group %s crosses every row and header, and drops where it showed',
    async (id) => {
      seed()
      await renderSettled(<DeckRail />)
      sweep({ kind: 'group', id })
    },
  )

  it('keeps the shown mark over the gap between rows and drops there', async () => {
    seed()
    await renderSettled(<DeckRail />)
    const source: Source = { kind: 'workspace', id: 's1' }
    const dataTransfer = transfer(source)
    const from = sourceEl(source)
    const list = document.querySelector('.workspaces') as HTMLElement
    fireEvent.dragStart(from, { dataTransfer })
    fireAt(sourceEl({ kind: 'workspace', id: 's4' }), createEvent.dragOver, dataTransfer, 0.95)
    const mark = readMarks()[0] ?? null
    fireAt(list, createEvent.dragOver, dataTransfer, 0.5)
    expect(readMarks()[0] ?? null).toEqual(mark)
    fireAt(list, createEvent.drop, dataTransfer, 0.5)
    fireEvent.dragEnd(from, { dataTransfer })
    expect(mark).not.toBeNull()
    expect(landedWhereShown(source, mark, snapshot())).toBe(true)
  })

  it('clears the mark when the drag leaves the rail, so nothing shows where nothing drops', async () => {
    seed()
    await renderSettled(<DeckRail />)
    const source: Source = { kind: 'workspace', id: 's1' }
    const dataTransfer = transfer(source)
    const list = document.querySelector('.workspaces') as HTMLElement
    fireEvent.dragStart(sourceEl(source), { dataTransfer })
    fireAt(sourceEl({ kind: 'workspace', id: 's4' }), createEvent.dragOver, dataTransfer, 0.95)
    expect(readMarks()).toHaveLength(1)
    fireEvent.dragLeave(list, { dataTransfer, relatedTarget: document.body })
    expect(readMarks()).toHaveLength(0)
  })
})
