import { afterEach, describe, expect, it, vi } from 'vitest'
import { startPlaybookPush } from './playbookPush'
import { useSettingsStore } from './settingsStore'

describe('startPlaybookPush', () => {
  let stop: () => void = () => {}
  const initial = useSettingsStore.getState()

  afterEach(() => {
    stop()
    useSettingsStore.setState(initial, true)
    vi.mocked(window.ostia.settings.setPlaybooks).mockClear()
  })

  it('tells main only when the playbooks change, with the playbooks themselves', () => {
    stop = startPlaybookPush()
    useSettingsStore.setState({ locale: 'zh-Hant' })
    expect(window.ostia.settings.setPlaybooks).not.toHaveBeenCalled()
    useSettingsStore.getState().setPlaybookEnabled('onboard', true)
    expect(window.ostia.settings.setPlaybooks).toHaveBeenCalledTimes(1)
    expect(window.ostia.settings.setPlaybooks).toHaveBeenCalledWith(
      useSettingsStore.getState().playbooks,
    )
    expect(useSettingsStore.getState().playbooks.enabled).toEqual({ onboard: true })
  })

  it('stops when asked', () => {
    startPlaybookPush()()
    useSettingsStore.getState().setPlaybookEnabled('onboard', true)
    expect(window.ostia.settings.setPlaybooks).not.toHaveBeenCalled()
  })
})
