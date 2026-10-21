import { act, cleanup, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useCmuxImportStore } from '@/stores/workspaces/cmuxImportStore'
import { renderSettled } from '../../../../test/render'
import { CmuxImportDialog } from './CmuxImportDialog'

describe('CmuxImportDialog', () => {
  let importInit: ReturnType<typeof useCmuxImportStore.getState>
  let settingsInit: ReturnType<typeof useSettingsStore.getState>

  beforeAll(() => {
    importInit = useCmuxImportStore.getState()
    settingsInit = useSettingsStore.getState()
  })

  afterEach(() => {
    cleanup()
    useCmuxImportStore.setState(importInit, true)
    useSettingsStore.setState(settingsInit, true)
  })

  it('names the size limit of a session file in the locale setting', async () => {
    useSettingsStore.setState({ locale: 'de' })
    await renderSettled(<CmuxImportDialog />)
    act(() => useCmuxImportStore.getState().show({ error: 'too-large', path: '/home/u/s.json' }))
    expect(await screen.findByText('/home/u/s.json is larger than 33,6 MB.')).toBeInTheDocument()
  })
})
