import type { AppSnapshot } from '@shared/workspaces/workspaceApi'
import { afterEach, describe, expect, it } from 'vitest'
import { useSidePanelStore } from '@/stores/app/sidePanelStore'
import { useUIStore } from '@/stores/app/uiStore'
import { restoreSidePanels } from './restoreSidePanels'

const snapshot = (panels: Partial<AppSnapshot> = {}): AppSnapshot => ({
  v: 1,
  savedAt: 't',
  activeWorkspaceId: null,
  workspaces: [],
  groups: [],
  ...panels,
})

describe('restoreSidePanels', () => {
  const ui = useUIStore.getState()
  const side = useSidePanelStore.getState()
  afterEach(() => {
    useUIStore.setState(ui, true)
    useSidePanelStore.setState(side, true)
  })

  it('opens the panel each side had open', () => {
    restoreSidePanels(snapshot({ leftPanel: 'files', rightPanel: 'graphs' }))
    expect(useUIStore.getState().filesOpen).toBe(true)
    expect(useSidePanelStore.getState().right).toBe('graphs')
  })

  it('closes both sides when the snapshot had none, or there is no snapshot', () => {
    useUIStore.setState({ filesOpen: true })
    useSidePanelStore.setState({ right: 'graphs' })
    restoreSidePanels(snapshot())
    expect(useUIStore.getState().filesOpen).toBe(false)
    expect(useSidePanelStore.getState().right).toBeNull()
    useUIStore.setState({ filesOpen: true })
    useSidePanelStore.setState({ right: 'graphs' })
    restoreSidePanels(null)
    expect(useUIStore.getState().filesOpen).toBe(false)
    expect(useSidePanelStore.getState().right).toBeNull()
  })
})
