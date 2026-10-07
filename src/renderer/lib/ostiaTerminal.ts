import type { ISearchOptions } from '@xterm/addon-search'
import type { IBufferRange, ILinkProvider, IParser, Terminal as Xterm } from '@xterm/xterm'

export interface TerminalDisposable {
  dispose(): void
}

export type TerminalEvent<T> = (listener: (arg: T) => void) => TerminalDisposable

export interface TerminalMarker extends TerminalDisposable {
  readonly line: number
  readonly isDisposed: boolean
  readonly onDispose: TerminalEvent<void>
}

export interface TerminalBufferCell {
  getChars(): string
  getWidth(): number
}

export interface TerminalBufferLine {
  readonly length: number
  readonly isWrapped: boolean
  getCell(x: number): TerminalBufferCell | undefined
  translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string
}

export interface TerminalBuffer {
  readonly type: 'normal' | 'alternate'
  readonly cursorX: number
  readonly cursorY: number
  readonly viewportY: number
  readonly baseY: number
  readonly length: number
  getLine(y: number): TerminalBufferLine | undefined
}

export interface TerminalBufferNamespace {
  readonly active: TerminalBuffer
  readonly normal: TerminalBuffer
  readonly onBufferChange: TerminalEvent<TerminalBuffer>
}

export type TerminalParser = Pick<
  IParser,
  'registerOscHandler' | 'registerCsiHandler' | 'registerDcsHandler'
>

export interface TerminalOptions {
  fontFamily?: string
  fontSize?: number
  fontWeight?: Xterm['options']['fontWeight']
  lineHeight?: number
  cursorStyle?: 'block' | 'underline' | 'bar'
  cursorBlink?: boolean
  theme?: Xterm['options']['theme']
  scrollSensitivity?: number
  scrollback?: number
  minimumContrastRatio?: number
  macOptionIsMeta?: boolean
}

export interface TerminalSearch {
  findNext(term: string, options?: ISearchOptions): boolean
  findPrevious(term: string, options?: ISearchOptions): boolean
  clearDecorations(): void
  readonly onDidChangeResults: TerminalEvent<{ resultIndex: number; resultCount: number }>
}

export interface WebLinkHandler {
  activate(event: MouseEvent, uri: string, range: IBufferRange): void
  hover(event: MouseEvent, uri: string, range: IBufferRange): void
  leave(event: MouseEvent, uri: string, range: IBufferRange): void
}

export interface OstiaTerminal {
  readonly cols: number
  readonly rows: number
  readonly element: HTMLElement | undefined
  readonly buffer: TerminalBufferNamespace
  readonly parser: TerminalParser
  readonly modes: { readonly mouseTrackingMode: Xterm['modes']['mouseTrackingMode'] }
  readonly options: TerminalOptions
  readonly onData: TerminalEvent<string>
  readonly onBell: TerminalEvent<void>
  readonly onTitleChange: TerminalEvent<string>
  readonly onSelectionChange: TerminalEvent<void>
  readonly onScroll: TerminalEvent<number>
  readonly onResize: TerminalEvent<{ cols: number; rows: number }>
  readonly onRender: TerminalEvent<{ start: number; end: number }>
  open(parent: HTMLElement): void
  write(data: string | Uint8Array, callback?: () => void): void
  writeln(data: string | Uint8Array, callback?: () => void): void
  paste(data: string): void
  input(data: string, wasUserInput?: boolean): void
  resize(cols: number, rows: number): void
  focus(): void
  getSelection(): string
  hasSelection(): boolean
  clearSelection(): void
  selectAll(): void
  scrollLines(amount: number): void
  scrollPages(pageCount: number): void
  scrollToTop(): void
  scrollToLine(line: number): void
  scrollToBottom(): void
  registerMarker(cursorYOffset?: number): TerminalMarker | undefined
  registerLinkProvider(provider: ILinkProvider): TerminalDisposable
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void
  attachCustomWheelEventHandler(handler: (event: WheelEvent) => boolean): void
  dispose(): void
}

export type PauseTerminal = (paused: boolean, options?: { releaseRenderer?: boolean }) => void

export function terminalScreen(host: ParentNode): HTMLElement | null {
  return host.querySelector<HTMLElement>('.xterm-screen, .ghostty-screen')
}

export const TERMINAL_INPUT_SELECTOR = '.xterm-helper-textarea, .ghostty-host textarea'
