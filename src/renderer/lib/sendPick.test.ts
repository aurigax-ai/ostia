import type { PickCapture } from '@shared/pick'
import type { SelectionCapture } from '@shared/selection'
import type { Terminal } from '@xterm/xterm'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAttentionStore } from '../stores/attentionStore'
import { useBlocksStore } from '../stores/blocksStore'
import { canInsertReference, sendPickToPane, sendSelectionToPane } from './sendPick'
import { registerTerminal } from './terminalHandles'

const TARGET = 'pane-agent'
const REPORT = '/tmp/pine-reports-1000/ui-issue-3.md'

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
  vi.mocked(window.pine.browser.pickSend).mockResolvedValue({ ok: true, path: REPORT })
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

const send = (note = 'Save is misaligned') =>
  sendPickToPane({ capture, sourcePaneId: 'pane-browser', targetPaneId: TARGET, note })

describe('sendPickToPane', () => {
  it('asks main for the report with the capture id, source, target and note', async () => {
    idlePrompt()
    await send()
    expect(window.pine.browser.pickSend).toHaveBeenCalledWith({
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
    expect(window.pine.pty.write).not.toHaveBeenCalled()
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

  it('touches nothing when main refuses the report', async () => {
    idlePrompt()
    vi.mocked(window.pine.browser.pickSend).mockResolvedValue({
      ok: false,
      error: 'capture-expired',
    })
    const res = await send()
    expect(res).toEqual({ ok: false, error: 'capture-expired' })
    expect(term.paste).not.toHaveBeenCalled()
    expect(useAttentionStore.getState().byPane[TARGET]).toBeUndefined()
  })
})

describe('sendSelectionToPane', () => {
  const SELECTION_REPORT = '/tmp/pine-reports-1000/selection-2.md'
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
    vi.mocked(window.pine.selection.send).mockResolvedValue({
      ok: true,
      path: SELECTION_REPORT,
      imagePath: null,
    })
  })

  it('sends the capture, image, source, target and note to main', async () => {
    idlePrompt()
    const png = new Uint8Array([1, 2, 3])
    await sendSelection('explain', png)
    expect(window.pine.selection.send).toHaveBeenCalledWith({
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
    expect(window.pine.pty.write).not.toHaveBeenCalled()
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
    vi.mocked(window.pine.selection.send).mockResolvedValue({ ok: false, error: 'invalid' })
    expect(await sendSelection()).toEqual({ ok: false, error: 'invalid' })
    expect(term.paste).not.toHaveBeenCalled()
    expect(useAttentionStore.getState().byPane[TARGET]).toBeUndefined()
  })
})
