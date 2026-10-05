import type { PickCapture } from '@shared/pick'
import type { RegionCapture } from '@shared/regionCapture'
import type { SelectionCapture } from '@shared/selection'
import type { Terminal } from '@xterm/xterm'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAttentionStore } from '../stores/attentionStore'
import { useBlocksStore } from '../stores/blocksStore'
import {
  canInsertReference,
  insertPathReference,
  receiveReference,
  sendPickToPane,
  sendReference,
  sendRegionToPane,
  sendSelectionToPane,
} from './sendPick'
import { registerTerminal } from './terminalHandles'

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
  vi.restoreAllMocks()
})

function idlePrompt(): void {
  useBlocksStore.setState({ drafts: { [TARGET]: {} as never }, running: {} })
}

function running(): void {
  useBlocksStore.setState({ drafts: {}, running: { [TARGET]: 'b1' } })
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
    expect(term.paste).toHaveBeenCalledWith(`@${REPORT} `)
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
    useBlocksStore.setState({
      drafts: {},
      running: { [TARGET]: 'b1' },
      byPane: { [TARGET]: [{ id: 'b1', paneId: TARGET, command: 'claude --model opus' } as never] },
    })
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
    expect(term.paste).toHaveBeenCalledWith(`@${REPORT} @${SHOT} `)
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
    expect(term.paste.mock.calls).toEqual([[`@${REPORT} `], [`@${REPORT} `]])
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
    expect(term.paste).toHaveBeenCalledWith(`@${REGION_REPORT} @${REGION_SHOT} `)
    expect(window.ostia.pty.write).not.toHaveBeenCalled()
  })

  it('pastes only the report with the setting off', async () => {
    idlePrompt()
    await sendRegion(false)
    expect(term.paste).toHaveBeenCalledWith(`@${REGION_REPORT} `)
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
      text: `@${REPORT} `,
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
