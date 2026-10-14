import { afterEach, describe, expect, it } from 'vitest'
import { useSettingsStore } from './settingsStore'

const initial = useSettingsStore.getState()

afterEach(() => useSettingsStore.setState(initial, true))

describe('the graphs ceilings', () => {
  it('GRF-C100 settings.set cannot reach extensionSettings.graphs, so a pane cannot raise a ceiling', () => {
    for (const key of [
      'extensionSettings.graphs.maxSteps',
      'extensionSettings.graphs.maxRunHours',
    ]) {
      expect(() => useSettingsStore.getState().setByPath(key, 500)).toThrow(
        'unknown settings key: extensionSettings',
      )
    }
    expect(JSON.stringify(useSettingsStore.getState())).not.toContain('maxSteps')
  })
})
