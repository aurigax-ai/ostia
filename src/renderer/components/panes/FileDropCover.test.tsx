import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { useSandboxStore } from '@/stores/app/sandboxStore'
import { FileDropCover } from './FileDropCover'

describe('FileDropCover', () => {
  let sandboxInit: ReturnType<typeof useSandboxStore.getState>

  beforeAll(() => {
    sandboxInit = useSandboxStore.getState()
  })

  afterEach(() => {
    cleanup()
    useSandboxStore.setState(sandboxInit, true)
  })

  function covers(kind: Parameters<typeof FileDropCover>[0]['kind']): boolean {
    const { container, unmount } = render(<FileDropCover kind={kind} workspaceId="ws1" />)
    const covered = container.querySelector('.pane-file-drop') !== null
    unmount()
    return covered
  }

  it('lets a browser page take an OS file drop and covers editors and views', () => {
    expect(covers('browser')).toBe(false)
    expect(covers('terminal')).toBe(false)
    for (const kind of ['editor', 'view', 'diff', 'chat'] as const) {
      expect(covers(kind), kind).toBe(true)
    }
  })

  it('keeps the cover over a browser pane of a sandboxed workspace', () => {
    useSandboxStore.setState({ enabled: { ws1: true } })
    expect(covers('browser')).toBe(true)
  })
})
