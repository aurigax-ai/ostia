import type { PickCapture } from '@shared/browser/pick'
import type { RegionCapture } from '@shared/browser/regionCapture'
import type { SelectionCapture } from '@shared/browser/selection'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OstiaTerminal as Terminal } from '@/lib/terminal/ostiaTerminal'
import { registerTerminal } from '@/lib/terminal/terminalHandles'
import { useAttentionStore } from '@/stores/agents/attentionStore'
import { useBlocksStore } from '@/stores/terminal/blocksStore'
import {
  canInsertReference,
  insertPathReference,
  receiveReference,
  sendPickToPane,
  sendReference,
  sendRegionToPane,
  sendSelectionToPane,
} from './sendPick'

const TARGET = 'pane-agent'
const REPORT = '/tmp/ostia-reports-1000/capture-3.md'
const SHOT = '/tmp/ostia-reports-1000/pick-1.png'

const capture: PickCapture = {
  id: 'pick-1',
  url: 'http://localhost/',
  title: 'App',
  selector: '#save',
  label: 'button#save',
  html: '<button id="save">Save</button>',
  htmlTruncated: false,
  box: { x: 0, y: 0, width: 10, height: 10 },
  styles: {},
  role: 'button',
  name: 'Save',
  consoleErrors: [],
  failedRequests: [],
  screenshotPath: null,
  capturedAt: '2026-09-28T00:00:00.000Z',
  viewport: { width: 1280, height: 800 },
  hasText: true,
  table: null,
}

let blocksInit: ReturnType<typeof useBlocksStore.getState>
let attentionInit: ReturnType<typeof useAttentionStore.getState>
let term: { paste: ReturnType<typeof vi.fn>; focus: ReturnType<typeof vi.fn> }
let unregister: () => void
let writeText = vi.fn()

beforeAll(() => {
  blocksInit = useBlocksStore.getState()
  attentionInit = useAttentionStore.getState()
})

beforeEach(() => {
  term = { paste: vi.fn(), focus: vi.fn() }
  writeText = vi.fn().mockResolvedValue(undefined)
  unregister = registerTerminal(TARGET, term as unknown as Terminal)
  vi.spyOn(document, 'hasFocus').mockReturnValue(false)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  vi.mocked(window.ostia.browser.pickSend).mockResolvedValue({
    ok: true,
    path: REPORT,
    imagePath: null,
  })
})

afterEach(() => {
  unregister()
  useBlocksStore.setState(blocksInit, true)
  useAttentionStore.setState(attentionInit, true)
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function idlePrompt(): void {
  useBlocksStore.setState({ drafts: { [TARGET]: {} as never }, running: {} })
}

function running(): void {
  useBlocksStore.setState({ drafts: {}, running: { [TARGET]: 'b1' } })
}

function claudeRunning(): void {
  useBlocksStore.setState({
    drafts: {},
    running: { [TARGET]: 'b1' },
    byPane: { [TARGET]: [{ id: 'b1', paneId: TARGET, command: 'claude --model opus' } as never] },
    agentBlocks: { [TARGET]: { blockId: 'b1', agent: 'claude' } },
  })
}

const send = (note = 'Save is misaligned', attachImage = true) =>
  sendPickToPane({
    capture,
    sourcePaneId: 'pane-browser',
    targetPaneId: TARGET,
    note,
    attachImage,
  })

describe('sendPickToPane', () => {
  it('asks main for the report with the capture id, source, target and note', async () => {
    idlePrompt()
    await send()
    expect(window.ostia.browser.pickSend).toHaveBeenCalledWith({
      captureId: 'pick-1',
      sourcePaneId: 'pane-browser',
      targetPaneId: TARGET,
      note: 'Save is misaligned',
    })
  })

  it('pastes the @path reference at an idle shell prompt without pressing Enter', async () => {
    idlePrompt()
    const res = await send()
    expect(res).toEqual({ ok: true, path: REPORT, inserted: true })
    expect(term.paste).toHaveBeenCalledWith(`Save is misaligned @${REPORT} `)
    expect(window.ostia.pty.write).not.toHaveBeenCalled()
    expect(writeText).not.toHaveBeenCalled()
  })

  it('pastes into a running agent that reported it is waiting for input', async () => {
    running()
    useAttentionStore.getState().dispatch(TARGET, { type: 'set', state: 'waiting', at: 1 })
    expect(canInsertReference(TARGET)).toBe(true)
    const res = await send()
    expect(res.ok && res.inserted).toBe(true)
    expect(term.paste).toHaveBeenCalledOnce()
  })

  it('pastes into a running claude or codex whatever state it last reported', async () => {
    claudeRunning()
    expect(canInsertReference(TARGET)).toBe(true)
    const res = await send()
    expect(res.ok && res.inserted).toBe(true)
  })

  it('copies the reference instead when the pane is busy', async () => {
    running()
    const res = await send()
    expect(res).toEqual({ ok: true, path: REPORT, inserted: false })
    expect(term.paste).not.toHaveBeenCalled()
    expect(writeText).toHaveBeenCalledWith(`@${REPORT}`)
  })

  it('marks the target working with the note, without making it unread', async () => {
    idlePrompt()
    await send('  Save   is misaligned ')
    const a = useAttentionStore.getState().byPane[TARGET]
    expect(a.state).toBe('working')
    expect(a.unread).toBe(false)
    expect(a.message).toBe('Save is misaligned')
  })

  it('inserts the screenshot as a second reference after the report when the setting is on', async () => {
    idlePrompt()
    vi.mocked(window.ostia.browser.pickSend).mockResolvedValue({
      ok: true,
      path: REPORT,
      imagePath: SHOT,
    })
    await send()
    expect(term.paste).toHaveBeenCalledWith(`Save is misaligned @${REPORT} @${SHOT} `)
  })

  it('inserts only the report when the setting is off or there is no screenshot', async () => {
    idlePrompt()
    await send()
    vi.mocked(window.ostia.browser.pickSend).mockResolvedValue({
      ok: true,
      path: REPORT,
      imagePath: SHOT,
    })
    await send('x', false)
    expect(term.paste.mock.calls).toEqual([[`Save is misaligned @${REPORT} `], [`x @${REPORT} `]])
  })

  it('copies both references when the pane is busy', async () => {
    running()
    vi.mocked(window.ostia.browser.pickSend).mockResolvedValue({
      ok: true,
      path: REPORT,
      imagePath: SHOT,
    })
    await send()
    expect(writeText).toHaveBeenCalledWith(`@${REPORT} @${SHOT}`)
  })

  it('touches nothing when main refuses the report', async () => {
    idlePrompt()
    vi.mocked(window.ostia.browser.pickSend).mockResolvedValue({
      ok: false,
      error: 'capture-expired',
    })
    const res = await send()
    expect(res).toEqual({ ok: false, error: 'capture-expired' })
    expect(term.paste).not.toHaveBeenCalled()
    expect(useAttentionStore.getState().byPane[TARGET]).toBeUndefined()
  })
})

describe('sendRegionToPane', () => {
  const region: RegionCapture = {
    id: 'region-1',
    url: 'http://localhost/',
    title: 'App',
    rect: { x: 10, y: 20, width: 120, height: 80 },
    imageWidth: 120,
    imageHeight: 80,
    capturedAt: '2026-10-01T00:00:00.000Z',
  }
  const REGION_REPORT = '/tmp/ostia-reports-1000/capture-4-localhost.md'
  const REGION_SHOT = '/tmp/ostia-reports-1000/capture-4-localhost.png'
  const sendRegion = (attachImage: boolean) =>
    sendRegionToPane({
      capture: region,
      sourcePaneId: 'pane-browser',
      targetPaneId: TARGET,
      note: 'the header overlaps',
      attachImage,
    })

  beforeEach(() => {
    vi.mocked(window.ostia.browser.regionSend).mockResolvedValue({
      ok: true,
      path: REGION_REPORT,
      imagePath: REGION_SHOT,
    })
  })

  it('asks main for the report of the region capture and pastes report and image', async () => {
    idlePrompt()
    const res = await sendRegion(true)
    expect(window.ostia.browser.regionSend).toHaveBeenCalledWith({
      captureId: 'region-1',
      sourcePaneId: 'pane-browser',
      targetPaneId: TARGET,
      note: 'the header overlaps',
    })
    expect(res).toEqual({ ok: true, path: REGION_REPORT, inserted: true })
    expect(term.paste).toHaveBeenCalledWith(
      `the header overlaps @${REGION_REPORT} @${REGION_SHOT} `,
    )
    expect(window.ostia.pty.write).not.toHaveBeenCalled()
  })

  it('pastes only the report with the setting off', async () => {
    idlePrompt()
    await sendRegion(false)
    expect(term.paste).toHaveBeenCalledWith(`the header overlaps @${REGION_REPORT} `)
  })
})

describe('sendSelectionToPane', () => {
  const SELECTION_REPORT = '/tmp/ostia-reports-1000/selection-2.md'
  const selection: SelectionCapture = {
    kind: 'text',
    file: '/w/src/app.ts',
    view: 'source',
    range: { startLine: 4, startColumn: 1, endLine: 6, endColumn: 3 },
    text: 'const x = 1',
  }

  const sendSelection = (note = '', image?: Uint8Array) =>
    sendSelectionToPane({
      capture: selection,
      image,
      sourcePaneId: 'pane-editor',
      targetPaneId: TARGET,
      note,
    })

  beforeEach(() => {
    vi.mocked(window.ostia.selection.send).mockResolvedValue({
      ok: true,
      path: SELECTION_REPORT,
      imagePath: null,
    })
  })

  it('sends the capture, image, source, target and note to main', async () => {
    idlePrompt()
    const png = new Uint8Array([1, 2, 3])
    await sendSelection('explain', png)
    expect(window.ostia.selection.send).toHaveBeenCalledWith({
      capture: selection,
      image: png,
      sourcePaneId: 'pane-editor',
      targetPaneId: TARGET,
      note: 'explain',
    })
  })

  it('pastes the report reference at an idle prompt under the pick rules', async () => {
    idlePrompt()
    const res = await sendSelection()
    expect(res).toEqual({ ok: true, path: SELECTION_REPORT, imagePath: null, inserted: true })
    expect(term.paste).toHaveBeenCalledWith(`@${SELECTION_REPORT} `)
    expect(window.ostia.pty.write).not.toHaveBeenCalled()
  })

  it('copies the reference when the target is busy', async () => {
    running()
    const res = await sendSelection()
    expect(res.ok && res.inserted).toBe(false)
    expect(term.paste).not.toHaveBeenCalled()
    expect(writeText).toHaveBeenCalledWith(`@${SELECTION_REPORT}`)
  })

  it('labels the working target with the file and range when there is no note', async () => {
    idlePrompt()
    await sendSelection()
    expect(useAttentionStore.getState().byPane[TARGET].message).toBe('app.ts:4:1-6:3')
  })

  it('touches nothing when main refuses the report', async () => {
    idlePrompt()
    vi.mocked(window.ostia.selection.send).mockResolvedValue({ ok: false, error: 'invalid' })
    expect(await sendSelection()).toEqual({ ok: false, error: 'invalid' })
    expect(term.paste).not.toHaveBeenCalled()
    expect(useAttentionStore.getState().byPane[TARGET]).toBeUndefined()
  })
})

describe('a target in the origin workspace of another window', () => {
  const REMOTE = 'pane-far-agent'

  it('asks main to insert the reference and never pastes or signals in this window', async () => {
    vi.mocked(window.ostia.windows.insertReference).mockResolvedValue(true)

    const res = await sendPickToPane({
      capture,
      sourcePaneId: 'pane-browser',
      targetPaneId: REMOTE,
      via: 'w-moved',
      note: '  Save   is misaligned ',
      attachImage: true,
    })

    expect(res).toEqual({ ok: true, path: REPORT, inserted: true })
    expect(window.ostia.windows.insertReference).toHaveBeenCalledWith({
      workspaceId: 'w-moved',
      paneId: REMOTE,
      text: `Save is misaligned @${REPORT} `,
      note: 'Save is misaligned',
    })
    expect(term.paste).not.toHaveBeenCalled()
    expect(writeText).not.toHaveBeenCalled()
    expect(useAttentionStore.getState().byPane[REMOTE]).toBeUndefined()
  })

  it('copies the reference when the owning window could not insert it', async () => {
    vi.mocked(window.ostia.windows.insertReference).mockResolvedValue(false)

    const res = await sendPickToPane({
      capture,
      sourcePaneId: 'pane-browser',
      targetPaneId: REMOTE,
      via: 'w-moved',
      note: '',
      attachImage: true,
    })

    expect(res).toEqual({ ok: true, path: REPORT, inserted: false })
    expect(writeText).toHaveBeenCalledWith(`@${REPORT}`)
  })

  it('sends a file path and chat text through main without a note', async () => {
    vi.mocked(window.ostia.windows.insertReference).mockResolvedValue(true)

    expect(await insertPathReference({ paneId: REMOTE, via: 'w-moved' }, '/w/src/app.ts')).toBe(
      true,
    )
    expect(await sendReference({ paneId: REMOTE, via: 'w-moved' }, 'pnpm test')).toBe(true)

    expect(vi.mocked(window.ostia.windows.insertReference).mock.calls).toEqual([
      [{ workspaceId: 'w-moved', paneId: REMOTE, text: '@/w/src/app.ts ' }],
      [{ workspaceId: 'w-moved', paneId: REMOTE, text: 'pnpm test' }],
    ])
  })

  it('keeps a local target in this window', async () => {
    idlePrompt()

    expect(await insertPathReference({ paneId: TARGET }, '/w/src/app.ts')).toBe(true)

    expect(term.paste).toHaveBeenCalledWith('@/w/src/app.ts ')
    expect(window.ostia.windows.insertReference).not.toHaveBeenCalled()
  })
})

describe('receiveReference', () => {
  const insert = { requestId: 'reference-1', paneId: TARGET, text: '@/tmp/r.md ', note: 'look' }

  it('pastes a forwarded reference into a pane that can take one, without Enter', () => {
    running()
    useAttentionStore.getState().dispatch(TARGET, { type: 'set', state: 'waiting', at: 1 })

    expect(receiveReference(insert)).toBe(true)

    expect(term.paste).toHaveBeenCalledWith('@/tmp/r.md ')
    expect(window.ostia.pty.write).not.toHaveBeenCalled()
    expect(useAttentionStore.getState().byPane[TARGET]).toMatchObject({
      state: 'working',
      message: 'look',
    })
  })

  it('refuses a busy pane and a pane this window has no terminal for', () => {
    running()

    expect(receiveReference(insert)).toBe(false)
    expect(receiveReference({ ...insert, paneId: 'pane-elsewhere', note: undefined })).toBe(false)

    expect(term.paste).not.toHaveBeenCalled()
  })
})

describe('a reference is never followed by Enter', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  const settle = () => vi.advanceTimersByTimeAsync(600)

  const region: RegionCapture = {
    id: 'region-1',
    url: 'http://localhost/',
    title: 'App',
    rect: { x: 0, y: 0, width: 1, height: 1 },
    imageWidth: 1,
    imageHeight: 1,
    capturedAt: '2026-10-01T00:00:00.000Z',
  }

  const selections: [string, SelectionCapture][] = [
    [
      'text',
      {
        kind: 'text',
        file: '/w/a.ts',
        view: 'source',
        range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 },
        text: 'x',
      },
    ],
    ['preview-error', { kind: 'preview-error', file: '/a/page.html', count: 1, text: 'boom' }],
  ]

  const targets: [string, () => void][] = [
    ['an idle shell prompt', idlePrompt],
    ['a running claude', claudeRunning],
    [
      'a waiting agent',
      () => {
        running()
        useAttentionStore.getState().dispatch(TARGET, { type: 'set', state: 'waiting', at: 1 })
      },
    ],
  ]

  describe.each(targets)('at %s', (_name, prepare) => {
    beforeEach(prepare)

    it('pastes a picked element and its screenshot without Enter', async () => {
      vi.mocked(window.ostia.browser.pickSend).mockResolvedValue({
        ok: true,
        path: REPORT,
        imagePath: SHOT,
      })
      const res = await send()
      await settle()
      expect(res.ok && res.inserted).toBe(true)
      expect(term.paste.mock.calls).toEqual([[`Save is misaligned @${REPORT} @${SHOT} `]])
      expect(window.ostia.pty.write).not.toHaveBeenCalled()
    })

    it('pastes a captured region without Enter', async () => {
      vi.mocked(window.ostia.browser.regionSend).mockResolvedValue({
        ok: true,
        path: REPORT,
        imagePath: SHOT,
      })
      await sendRegionToPane({
        capture: region,
        sourcePaneId: 'pane-browser',
        targetPaneId: TARGET,
        note: '',
        attachImage: true,
      })
      await settle()
      expect(term.paste).toHaveBeenCalledOnce()
      expect(window.ostia.pty.write).not.toHaveBeenCalled()
    })

    it.each(selections)('pastes a %s selection without Enter', async (_kind, capture) => {
      vi.mocked(window.ostia.selection.send).mockResolvedValue({
        ok: true,
        path: REPORT,
        imagePath: null,
      })
      const res = await sendSelectionToPane({
        capture,
        sourcePaneId: 'pane-editor',
        targetPaneId: TARGET,
        note: '',
      })
      await settle()
      expect(res.ok && res.inserted).toBe(true)
      expect(term.paste).toHaveBeenCalledWith(`@${REPORT} `)
      expect(window.ostia.pty.write).not.toHaveBeenCalled()
    })

    it('pastes a file path and chat text without Enter', async () => {
      await insertPathReference({ paneId: TARGET }, '/w/src/app.ts')
      await sendReference({ paneId: TARGET }, 'look at this', 'x')
      await settle()
      expect(term.paste).toHaveBeenCalledTimes(2)
      expect(window.ostia.pty.write).not.toHaveBeenCalled()
    })

    it('pastes a reference forwarded from another window without Enter', async () => {
      expect(receiveReference({ requestId: 'r', paneId: TARGET, text: '@/tmp/r.md ' })).toBe(true)
      await settle()
      expect(term.paste).toHaveBeenCalledWith('@/tmp/r.md ')
      expect(window.ostia.pty.write).not.toHaveBeenCalled()
    })
  })

  it('asks the owning window for a plain reference of every kind, with no flag to submit it', async () => {
    vi.mocked(window.ostia.windows.insertReference).mockResolvedValue(true)
    vi.mocked(window.ostia.browser.regionSend).mockResolvedValue({
      ok: true,
      path: REPORT,
      imagePath: null,
    })
    vi.mocked(window.ostia.selection.send).mockResolvedValue({
      ok: true,
      path: REPORT,
      imagePath: null,
    })
    const via = { targetPaneId: 'pane-far-agent', via: 'w-moved', note: '' }
    await sendPickToPane({ capture, sourcePaneId: 'pane-browser', attachImage: true, ...via })
    await sendRegionToPane({
      capture: region,
      sourcePaneId: 'pane-browser',
      attachImage: true,
      ...via,
    })
    await sendSelectionToPane({ capture: selections[0][1], sourcePaneId: 'pane-editor', ...via })
    await insertPathReference({ paneId: 'pane-far-agent', via: 'w-moved' }, '/w/a.ts')
    const calls = vi.mocked(window.ostia.windows.insertReference).mock.calls
    expect(calls).toHaveLength(4)
    for (const [request] of calls) {
      expect(Object.keys(request).sort()).toEqual(
        expect.arrayContaining(['paneId', 'text', 'workspaceId']),
      )
      expect(request).not.toHaveProperty('pointedByHuman')
    }
    await settle()
    expect(window.ostia.pty.write).not.toHaveBeenCalled()
  })
})
