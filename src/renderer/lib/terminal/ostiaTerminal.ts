import type { ISearchOptions, ITheme, MouseTrackingMode } from '@aurigax-ai/ghostty-web'

export interface TerminalPosition {
  x: number
  y: number
}

export interface TerminalRange {
  start: TerminalPosition
  end: TerminalPosition
}

export interface TerminalLink {
  range: TerminalRange
  text: string
  decorations?: { pointerCursor?: boolean; underline?: boolean }
  activate(event: MouseEvent, text: string): void
  hover?(event: MouseEvent, text: string): void
  leave?(event: MouseEvent, text: string): void
}

export interface TerminalLinkProvider {
  provideLinks(row: number, callback: (links: TerminalLink[] | undefined) => void): void
}

export interface TerminalSequenceId {
  prefix?: string
  intermediates?: string
  final: string
}

export type FontWeight =
  | 'normal'
  | 'bold'
  | '100'
  | '200'
  | '300'
  | '400'
  | '500'
  | '600'
  | '700'
  | '800'
  | '900'
  | number

export interface TerminalDisposable {
  dispose(): void
}

type TerminalEvent<T> = (listener: (arg: T) => void) => TerminalDisposable

export interface TerminalMarker extends TerminalDisposable {
  readonly line: number
  readonly isDisposed: boolean
  readonly onDispose: TerminalEvent<void>
}

interface TerminalBufferCell {
  getChars(): string
  getWidth(): number
}

export interface TerminalBufferLine {
  readonly length: number
  readonly isWrapped: boolean
  getCell(x: number): TerminalBufferCell | undefined
  translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string
}

interface TerminalBuffer {
  readonly type: 'normal' | 'alternate'
  readonly cursorX: number
  readonly cursorY: number
  readonly viewportY: number
  readonly baseY: number
  readonly length: number
  getLine(y: number): TerminalBufferLine | undefined
}

interface TerminalBufferNamespace {
  readonly active: TerminalBuffer
  readonly normal: TerminalBuffer
  readonly onBufferChange: TerminalEvent<TerminalBuffer>
}

type SequenceResult = boolean | Promise<boolean>

export interface TerminalParser {
  registerOscHandler(ident: number, callback: (data: string) => SequenceResult): TerminalDisposable
  registerCsiHandler(
    id: TerminalSequenceId,
    callback: (params: (number | number[])[]) => SequenceResult,
  ): TerminalDisposable
  registerDcsHandler(
    id: TerminalSequenceId,
    callback: (data: string, params: (number | number[])[]) => SequenceResult,
  ): TerminalDisposable
}

export interface TerminalOptions {
  fontFamily?: string
  fontSize?: number
  fontWeight?: FontWeight
  lineHeight?: number
  cursorStyle?: 'block' | 'underline' | 'bar'
  cursorBlink?: boolean
  theme?: ITheme
  scrollSensitivity?: number
  smoothScrollDuration?: number
  scrollback?: number
  nativeScrollbar?: boolean
  minimumContrastRatio?: number
  macOptionIsMeta?: boolean
  macOptionClickForcesSelection?: boolean
  rescaleOverlappingGlyphs?: boolean
}

export interface TerminalSearch {
  findNext(term: string, options?: ISearchOptions): boolean
  findPrevious(term: string, options?: ISearchOptions): boolean
  clearDecorations(): void
  readonly onDidChangeResults: TerminalEvent<{ resultIndex: number; resultCount: number }>
}

export interface WebLinkHandler {
  activate(event: MouseEvent, uri: string, range: TerminalRange): void
  hover(event: MouseEvent, uri: string, range: TerminalRange): void
  leave(event: MouseEvent, uri: string, range: TerminalRange): void
}

export interface OstiaTerminal {
  readonly cols: number
  readonly rows: number
  readonly element: HTMLElement | undefined
  readonly buffer: TerminalBufferNamespace
  readonly parser: TerminalParser
  readonly modes: { readonly mouseTrackingMode: MouseTrackingMode }
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
  getSelectionPosition(): TerminalRange | undefined
  hasSelection(): boolean
  clearSelection(): void
  select(column: number, row: number, length: number): void
  selectAll(): void
  scrollLines(amount: number): void
  scrollPages(pageCount: number): void
  scrollToTop(): void
  scrollToLine(line: number): void
  scrollToBottom(): void
  registerMarker(cursorYOffset?: number): TerminalMarker | undefined
  registerLinkProvider(provider: TerminalLinkProvider): TerminalDisposable
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void
  attachCustomWheelEventHandler(handler: (event: WheelEvent) => boolean): void
  dispose(): void
}

export type PauseTerminal = (paused: boolean) => void

export function terminalScreen(host: ParentNode): HTMLElement | null {
  return host.querySelector<HTMLElement>('.ghostty-screen')
}

export const TERMINAL_INPUT_SELECTOR = '.ghostty-host textarea'
