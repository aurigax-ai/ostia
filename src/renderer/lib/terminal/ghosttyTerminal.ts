import {
  FitAddon,
  Ghostty,
  type ILink as GhosttyLink,
  type IBufferRange as GhosttyRange,
  Terminal as GhosttyTerm,
  type IDisposable,
  SearchAddon,
  type SemanticPromptEvent,
} from '@aurigax-ai/ghostty-web'
import wasmDataUrl from '@aurigax-ai/ghostty-web/ghostty-vt.wasm?inline'
import { isMac } from '@/platform'
import { type GpuSlot, gpuBudget } from './gpuBudget'
import type {
  OstiaTerminal,
  PauseTerminal,
  TerminalDisposable,
  TerminalLinkProvider,
  TerminalOptions,
  TerminalParser,
  TerminalSearch,
  WebLinkHandler,
} from './ostiaTerminal'

type OscHandler = (data: string) => boolean | Promise<boolean>

const PROMPT_MARKS: Record<SemanticPromptEvent['kind'], string> = {
  'prompt-start': 'A',
  'input-start': 'B',
  'output-start': 'C',
  'command-end': 'D',
}

const NONE: TerminalDisposable = { dispose: () => {} }

export function promptMarkData(event: SemanticPromptEvent): string {
  const mark = PROMPT_MARKS[event.kind]
  return event.kind === 'command-end' && event.exitCode !== undefined
    ? `${mark};${event.exitCode}`
    : mark
}

export function unknownOsc(content: string): { ident: number; data: string } | null {
  const sep = content.indexOf(';')
  const ident = Number(sep === -1 ? content : content.slice(0, sep))
  if (!Number.isInteger(ident) || ident < 0) return null
  return { ident, data: sep === -1 ? '' : content.slice(sep + 1) }
}

export function osc52Data(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return `c;${btoa(binary)}`
}

function decodeDataUrl(url: string): Uint8Array<ArrayBuffer> {
  const binary = atob(url.slice(url.indexOf(',') + 1))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

let engine: Ghostty | null = null

export async function loadGhosttyEngine(): Promise<void> {
  engine ??= await Ghostty.fromBytes(decodeDataUrl(wasmDataUrl))
}

class OscRoutes {
  private readonly routes = new Map<number, Set<OscHandler>>()

  add(ident: number, handler: OscHandler): TerminalDisposable {
    const set = this.routes.get(ident) ?? new Set<OscHandler>()
    set.add(handler)
    this.routes.set(ident, set)
    return { dispose: () => set.delete(handler) }
  }

  fire(ident: number, data: string): void {
    for (const handler of this.routes.get(ident) ?? []) void handler(data)
  }
}

export function oneBasedLinks(provider: TerminalLinkProvider, live: () => boolean) {
  return {
    provideLinks(y: number, callback: (links: GhosttyLink[] | undefined) => void): void {
      if (!live()) {
        callback(undefined)
        return
      }
      provider.provideLinks(y + 1, (links) =>
        callback(
          links?.map((link) => ({
            text: link.text,
            range: {
              start: { x: link.range.start.x - 1, y: link.range.start.y - 1 },
              end: { x: link.range.end.x - 1, y: link.range.end.y - 1 },
            },
            activate: (event: MouseEvent) => link.activate(event, link.text),
            hover: (hovered: boolean) => {
              const event = new MouseEvent(hovered ? 'mouseover' : 'mouseout')
              if (hovered) link.hover?.(event, link.text)
              else link.leave?.(event, link.text)
            },
          })),
        ),
      )
    },
  }
}

export interface GhosttyTerminal {
  term: OstiaTerminal
  fit: { fit(): void; proposeDimensions(): { cols: number; rows: number } | undefined }
  search: TerminalSearch
  silenceQueryReplies(): TerminalDisposable
  setPaused: PauseTerminal
}

function oneBasedRange(range: GhosttyRange) {
  return {
    start: { x: range.start.x + 1, y: range.start.y + 1 },
    end: { x: range.end.x + 1, y: range.end.y + 1 },
  }
}

function fontWeightOf(weight: TerminalOptions['fontWeight']): 'normal' | 'bold' | number {
  if (weight === undefined || weight === 'normal' || weight === 'bold') return weight ?? 'normal'
  return Number(weight)
}

interface GhosttyRendererInternals {
  rendererReleased?: boolean
}

function ghosttyGpuSlot(t: GhosttyTerm): GpuSlot {
  return gpuBudget.join({
    acquire: () => {
      t.setPaused(true)
      t.options.renderer = 'webgl'
      ;(t as unknown as GhosttyRendererInternals).rendererReleased = true
      t.setPaused(false)
      return t.rendererType === 'webgl'
    },
    revoke: () => {
      t.options.renderer = 'canvas'
      t.setPaused(true, { releaseRenderer: true })
    },
  })
}

const PASTE_AND_COPY_CODES = new Set(['KeyC', 'KeyV'])

function typesNothing(event: KeyboardEvent): boolean {
  return (
    isMac &&
    event.type === 'keydown' &&
    event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    event.key.length === 1 &&
    !PASTE_AND_COPY_CODES.has(event.code)
  )
}

function forceSelectionOnOptionDrag(canvas: HTMLCanvasElement): void {
  let forced = false
  const filter = (event: MouseEvent): void => {
    if (event.type === 'mousedown') {
      forced = isMac && event.button === 0 && event.altKey
    } else if (event.type === 'mousemove' && event.buttons === 0) {
      forced = false
    }
    if (forced) event.stopPropagation()
    if (event.type === 'mouseup') forced = false
  }
  for (const type of ['mousedown', 'mousemove', 'mouseup'] as const) {
    canvas.addEventListener(type, filter)
  }
}

function routeOsc(t: GhosttyTerm, osc: OscRoutes): IDisposable[] {
  const subscriptions: IDisposable[] = [
    t.onSemanticPrompt((event) => osc.fire(133, promptMarkData(event))),
    t.onPwdChange((pwd) => osc.fire(7, pwd)),
    t.onDesktopNotification((n) => {
      if (n.title) osc.fire(777, `notify;${n.title};${n.body}`)
      else osc.fire(9, n.body)
    }),
    t.onUnknownOsc((content) => {
      const parsed = unknownOsc(content)
      if (parsed) osc.fire(parsed.ident, parsed.data)
    }),
  ]
  t.clipboardWriteHandler = (text) => {
    osc.fire(52, osc52Data(text))
    return false
  }
  return subscriptions
}

function optionsProxy(t: GhosttyTerm): TerminalOptions {
  const settable = new Set<keyof TerminalOptions>([
    'fontFamily',
    'fontSize',
    'fontWeight',
    'lineHeight',
    'cursorStyle',
    'cursorBlink',
    'theme',
    'scrollback',
    'nativeScrollbar',
    'scrollSensitivity',
    'smoothScrollDuration',
    'minimumContrastRatio',
    'macOptionIsMeta',
  ])
  return new Proxy({} as TerminalOptions, {
    get: (_target, key: string) => (t.options as unknown as Record<string, unknown>)[key],
    set: (_target, key: string, value: unknown) => {
      if (settable.has(key as keyof TerminalOptions)) {
        ;(t.options as unknown as Record<string, unknown>)[
          key === 'nativeScrollbar' ? 'scrollbar' : key
        ] = key === 'fontWeight' ? fontWeightOf(value as TerminalOptions['fontWeight']) : value
      }
      return true
    },
  })
}

interface WasmRows {
  getScrollbackLength(): number
  isScrollbackRowWrapped(offset: number): boolean
  isRowWrapped(row: number): boolean
}

type GhosttyRows = GhosttyTerm['buffer']['active']

function lazyLine(
  rows: GhosttyRows,
  wasm: WasmRows,
  cols: number,
  y: number,
): ReturnType<GhosttyRows['getLine']> {
  if (y < 0 || y >= rows.length) return undefined
  let cells: ReturnType<GhosttyRows['getLine']>
  const real = () => {
    cells ??= rows.getLine(y)
    return cells
  }
  const scrollback = rows.type === 'normal' ? wasm.getScrollbackLength() : 0
  const isWrapped =
    y < scrollback ? wasm.isScrollbackRowWrapped(y) : wasm.isRowWrapped(y - scrollback)
  return {
    length: cols,
    isWrapped,
    getCell: (x) => real()?.getCell(x),
    translateToString: (trimRight, start, end) =>
      real()?.translateToString(trimRight, start, end) ?? '',
  } as ReturnType<GhosttyRows['getLine']>
}

export function lazyBuffers(t: GhosttyTerm): OstiaTerminal['buffer'] {
  const wasm = () => (t as unknown as { wasmTerm: WasmRows }).wasmTerm
  const lazy = (rows: GhosttyRows): GhosttyRows =>
    new Proxy(rows, {
      get: (target, key) => {
        if (key === 'getLine') return (y: number) => lazyLine(target, wasm(), t.cols, y)
        const value = Reflect.get(target, key, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  return new Proxy(t.buffer, {
    get: (target, key) => {
      const value = Reflect.get(target, key, target)
      if (key === 'active' || key === 'normal' || key === 'alternate') return lazy(value)
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as unknown as OstiaTerminal['buffer']
}

export function createGhosttyTerminal(
  options: TerminalOptions,
  gpu: boolean,
  links: WebLinkHandler,
): GhosttyTerminal {
  if (!engine) throw new Error('Ghostty engine is not loaded')
  const t = new GhosttyTerm({
    ghostty: engine,
    renderer: 'canvas',
    fontWeight: fontWeightOf(options.fontWeight),
    lineHeight: options.lineHeight,
    scrollSensitivity: options.scrollSensitivity,
    smoothScrollDuration: options.smoothScrollDuration ?? 0,
    minimumContrastRatio: options.minimumContrastRatio,
    macOptionIsMeta: options.macOptionIsMeta,
    linkHandler: {
      activate: (event, uri, range) => links.activate(event, uri, oneBasedRange(range)),
      hover: (event, uri, range) => links.hover(event, uri, oneBasedRange(range)),
      leave: (event, uri, range) => links.leave(event, uri, oneBasedRange(range)),
    },
    fontFamily: options.fontFamily,
    fontSize: options.fontSize,
    cursorStyle: options.cursorStyle,
    cursorBlink: options.cursorBlink,
    theme: options.theme,
    scrollback: options.scrollback,
    scrollbar: options.nativeScrollbar,
  })
  const slot = gpu ? ghosttyGpuSlot(t) : null
  const fit = new FitAddon()
  t.loadAddon(fit)
  const search = new SearchAddon()
  t.loadAddon(search)

  const osc = new OscRoutes()
  const subscriptions = routeOsc(t, osc)

  const parser: TerminalParser = {
    registerOscHandler: (ident, handler) => osc.add(ident, handler),
    registerCsiHandler: () => NONE,
    registerDcsHandler: () => NONE,
  }

  const termOptions = optionsProxy(t)

  const term: OstiaTerminal = {
    get cols() {
      return t.cols
    },
    get rows() {
      return t.rows
    },
    get element() {
      return t.element
    },
    buffer: lazyBuffers(t),
    parser,
    get modes() {
      return { mouseTrackingMode: t.modes.mouseTrackingMode }
    },
    options: termOptions,
    onData: t.onData,
    onBell: t.onBell,
    onTitleChange: t.onTitleChange,
    onSelectionChange: t.onSelectionChange,
    onScroll: t.onScroll,
    onResize: t.onResize,
    onRender: t.onRender,
    onWriteParsed: t.onWriteParsed,
    open: (parent) => {
      t.open(parent)
      if (slot) parent.addEventListener('webglcontextlost', () => queueMicrotask(slot.lost), true)
      const canvas = parent.querySelector('canvas')
      canvas?.classList.add('ghostty-screen')
      if (canvas && options.macOptionClickForcesSelection) forceSelectionOnOptionDrag(canvas)
    },
    write: (data, callback) => t.write(data, callback),
    writeln: (data, callback) => t.writeln(data, callback),
    paste: (data) => t.paste(data),
    input: (data, wasUserInput) => t.input(data, wasUserInput),
    resize: (cols, rows) => t.resize(cols, rows),
    focus: () => t.focus(),
    getSelection: () => t.getSelection(),
    getSelectionPosition: () => t.getSelectionPosition(),
    hasSelection: () => t.hasSelection(),
    clearSelection: () => t.clearSelection(),
    select: (column, row, length) => t.select(column, row, length),
    selectAll: () => t.selectAll(),
    scrollLines: (amount) => t.scrollLines(amount),
    scrollPages: (amount) => t.scrollPages(amount),
    scrollToTop: () => t.scrollToTop(),
    scrollToLine: (line) => t.scrollToLine(line),
    scrollToBottom: () => t.scrollToBottom(),
    registerMarker: (offset) => t.registerMarker(offset),
    registerLinkProvider: (provider) => {
      let live = true
      t.registerLinkProvider(oneBasedLinks(provider, () => live))
      return {
        dispose: () => {
          live = false
        },
      }
    },
    attachCustomKeyEventHandler: (handler) =>
      t.attachCustomKeyEventHandler((event) => !handler(event) || typesNothing(event)),
    attachCustomWheelEventHandler: (handler) =>
      t.attachCustomWheelEventHandler((event) => !handler(event)),
    dispose: () => {
      for (const sub of subscriptions) sub.dispose()
      t.clipboardWriteHandler = null
      slot?.dispose()
      t.dispose()
    },
  }

  return {
    term,
    fit: {
      proposeDimensions: () => fit.proposeDimensions(),
      fit: () => {
        const dims = fit.proposeDimensions()
        if (dims && (dims.cols !== t.cols || dims.rows !== t.rows)) t.resize(dims.cols, dims.rows)
      },
    },
    search: {
      findNext: (text, findOptions) => search.findNext(text, findOptions),
      findPrevious: (text, findOptions) => search.findPrevious(text, findOptions),
      clearDecorations: () => search.clearDecorations(),
      onDidChangeResults: search.onDidChangeResults,
    },
    setPaused: (paused) => {
      if (paused) {
        t.setPaused(true)
        slot?.hide()
        return
      }
      slot?.show()
      t.setPaused(false)
    },
    silenceQueryReplies: () => {
      t.answerQueries = false
      return {
        dispose: () => {
          t.answerQueries = true
        },
      }
    },
  }
}
