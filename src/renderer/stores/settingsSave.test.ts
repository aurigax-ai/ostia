import { afterEach, describe, expect, it } from 'vitest'
import { useSettingsStore } from './settingsStore'

const initial = useSettingsStore.getState()
const SAVE_DELAY_MS = 300

describe('a settings save scheduled near the end of a test', () => {
  afterEach(() => {
    useSettingsStore.setState(initial, true)
  })

  it('waits for its debounce before writing', () => {
    useSettingsStore.getState().setEditor({ formatOnSave: true })
    expect(useSettingsStore.getState().editor.formatOnSave).toBe(true)
    expect(window.ostia.fs.write).not.toHaveBeenCalled()
  })

  it('is not written into the next test', async () => {
    await new Promise((resolve) => setTimeout(resolve, SAVE_DELAY_MS + 100))
    expect(window.ostia.fs.write).not.toHaveBeenCalled()
  })
})
