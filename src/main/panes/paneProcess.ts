export interface PaneProcess {
  readonly pid: number
  readonly cols: number
  readonly rows: number
  readonly process: string
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
  pause?(): void
  resume?(): void
  onData(listener: (data: string) => void): { dispose(): void }
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void }
}
