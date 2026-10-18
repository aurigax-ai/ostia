import { useUIStore } from '@/stores/app/uiStore'
import type { AppSnapshot } from '@shared/workspaces/workspaceApi'
import { afterEach, describe, expect, it } from 'vitest'
import { restoreLeftPanel } from './restoreLeftPanel'

const snapshot = (leftPanel?: 'files'): AppSnapshot => ({
  v: 1,
  savedAt: 't',
  activeWorkspaceId: null,
  workspaces: [],
  groups: [],
  ...(leftPanel ? { leftPanel } : {}),
})

describe('restoreLeftPanel', () => {
  const init = useUIStore.getState()
  afterEach(() => useUIStore.setState(init, true))

  it('opens Files when the snapshot had it open', () => {
    restoreLeftPanel(snapshot('files'))
    expect(useUIStore.getState().filesOpen).toBe(true)
  })

  it('keeps Files closed when the snapshot did not, or there is none', () => {
    useUIStore.setState({ filesOpen: true })
    restoreLeftPanel(snapshot())
    expect(useUIStore.getState().filesOpen).toBe(false)
    useUIStore.setState({ filesOpen: true })
    restoreLeftPanel(null)
    expect(useUIStore.getState().filesOpen).toBe(false)
  })
})
