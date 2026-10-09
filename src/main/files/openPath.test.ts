import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, shell: {} }))

const { isProgram } = await import('./openPath')

describe('isProgram', () => {
  it('treats launchers, scripts and executable files as programs', () => {
    expect(isProgram('/h/app.desktop', 0o644, true)).toBe(true)
    expect(isProgram('/h/run.sh', 0o644, true)).toBe(true)
    expect(isProgram('/h/tool', 0o755, true)).toBe(true)
    expect(isProgram('/h/Setup.EXE', 0o644, true)).toBe(true)
  })

  it('lets documents and folders through', () => {
    expect(isProgram('/h/notes.md', 0o644, true)).toBe(false)
    expect(isProgram('/h/report.pdf', 0o600, true)).toBe(false)
    expect(isProgram('/h/folder', 0o755, false)).toBe(false)
  })
})
