import { registerEditorPosition } from '@/lib/files/editorPositions'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { OPEN_EXTERNAL_COMMAND, registerExternalEditorCommand } from './externalEditor'
import { commands } from './registry'

describe('editor.openExternal command', () => {
  let settingsInit: ReturnType<typeof useSettingsStore.getState>
  const cleanups: (() => void)[] = []

  beforeAll(() => {
    registerExternalEditorCommand()
    settingsInit = useSettingsStore.getState()
  })

  afterEach(() => {
    for (const c of cleanups.splice(0)) c()
    useSettingsStore.setState(settingsInit, true)
  })

  const ctx = (activePaneId: string | null) => ({ activeWorkspaceId: 's1', activePaneId })

  it('is a palette command in the Editor category', () => {
    expect(commands.describe().find((c) => c.id === OPEN_EXTERNAL_COMMAND)).toMatchObject({
      title: 'Open in External Editor',
      category: 'Editor',
      hidden: false,
    })
  })

  it('passes the setting template and the active pane file:line:column to main', async () => {
    useSettingsStore.setState({
      behavior: { ...useSettingsStore.getState().behavior, externalEditor: 'zed {file}:{line}' },
    })
    cleanups.push(registerEditorPosition('p1', () => ({ file: '/w/x.ts', line: 3, column: 9 })))
    vi.mocked(window.ostia.externalEditor.open).mockResolvedValue({
      ok: true,
      argv: ['zed', '/w/x.ts:3'],
    })

    const res = await commands.execWith(ctx('p1'), OPEN_EXTERNAL_COMMAND)

    expect(window.ostia.externalEditor.open).toHaveBeenCalledWith({
      template: 'zed {file}:{line}',
      file: '/w/x.ts',
      line: 3,
      column: 9,
    })
    expect(res).toEqual({ ok: true, result: { argv: ['zed', '/w/x.ts:3'] } })
  })

  it('fails without calling main when the active pane has no file', async () => {
    const res = await commands.execWith(ctx('terminal-pane'), OPEN_EXTERNAL_COMMAND)
    expect(res.ok).toBe(false)
    expect(window.ostia.externalEditor.open).not.toHaveBeenCalled()
  })

  it('surfaces the main-process error as a failed command', async () => {
    cleanups.push(registerEditorPosition('p1', () => ({ file: '/w/x.ts', line: 1, column: 1 })))
    vi.mocked(window.ostia.externalEditor.open).mockResolvedValue({
      ok: false,
      error: 'spawn-failed',
      message: 'ENOENT',
    })
    const res = await commands.execWith(ctx('p1'), OPEN_EXTERNAL_COMMAND)
    expect(res).toMatchObject({ ok: false, error: { message: 'spawn-failed: ENOENT' } })
  })
})
