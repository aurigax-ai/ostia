import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { commandWording, commands } from '../commands/registry'
import { zhHant } from '../i18n/dict'
import type { UserAction } from '../settings/actions'
import { useActionConfirmStore } from '../stores/actionConfirmStore'
import { useSettingsStore } from '../stores/settingsStore'
import { mergeCatalog } from './languagePacks'
import { runUserAction, startUserActions } from './userActions'

const plain = vi.fn()
const elevated = vi.fn()

const PLAIN: UserAction = { id: 'plain', title: 'Plain', command: 'test.plain', in: [] }
const ELEVATED: UserAction = {
  id: 'risky',
  title: 'Risky',
  command: 'test.elevated',
  args: { text: 'hi' },
  in: [],
}

describe('user actions', () => {
  const initial = useSettingsStore.getState()

  beforeAll(() => {
    commands.register({ id: 'test.plain', title: 'Plain', run: (args) => plain(args) })
    commands.register({
      id: 'test.elevated',
      title: 'Elevated',
      capabilities: ['shell'],
      run: (args) => elevated(args),
    })
  })

  afterEach(() => {
    plain.mockClear()
    elevated.mockClear()
    useSettingsStore.setState(initial, true)
    useActionConfirmStore.setState({ pending: null })
  })

  it('runs an action whose command needs only default permissions without asking', async () => {
    await runUserAction(PLAIN, null)
    expect(plain).toHaveBeenCalledOnce()
    expect(useActionConfirmStore.getState().pending).toBeNull()
  })

  it('asks before the first run of an elevated action and does nothing when cancelled', async () => {
    const run = runUserAction(ELEVATED, null)
    await vi.waitFor(() => expect(useActionConfirmStore.getState().pending).not.toBeNull())
    expect(useActionConfirmStore.getState().pending?.args).toEqual({ text: 'hi' })
    useActionConfirmStore.getState().answer('cancel')
    await run
    expect(elevated).not.toHaveBeenCalled()
  })

  it('remembers "run and trust" so the same command and args no longer ask', async () => {
    const first = runUserAction(ELEVATED, null)
    await vi.waitFor(() => expect(useActionConfirmStore.getState().pending).not.toBeNull())
    useActionConfirmStore.getState().answer('trust')
    await first
    expect(elevated).toHaveBeenCalledTimes(1)

    await runUserAction(ELEVATED, null)
    expect(elevated).toHaveBeenCalledTimes(2)
    expect(useActionConfirmStore.getState().pending).toBeNull()

    const changed = runUserAction({ ...ELEVATED, args: { text: 'other' } }, null)
    await vi.waitFor(() => expect(useActionConfirmStore.getState().pending).not.toBeNull())
    useActionConfirmStore.getState().answer('cancel')
    await changed
    expect(elevated).toHaveBeenCalledTimes(2)
  })

  it('registers each action as a palette command and follows settings changes', async () => {
    const stop = startUserActions()
    useSettingsStore
      .getState()
      .setByPath('actions', [{ id: 'plain', title: 'Plain', command: 'test.plain' }])
    expect(commands.has('action.plain')).toBe(true)
    await commands.exec('action.plain')
    expect(plain).toHaveBeenCalledOnce()

    useSettingsStore.getState().setByPath('actions', [])
    expect(commands.has('action.plain')).toBe(false)
    stop()
  })
  it('files actions under an English category for agents and the human’s language in the palette', () => {
    const stop = startUserActions()
    useSettingsStore
      .getState()
      .setByPath('actions', [{ id: 'plain', title: 'Plain', command: 'test.plain' }])
    const registered = commands.list().find((c) => c.id === 'action.plain')
    const described = commands.describe().find((c) => c.id === 'action.plain')
    stop()
    useSettingsStore.getState().setByPath('actions', [])

    expect(described).toMatchObject({ title: 'Plain', category: 'Actions' })
    expect(registered && commandWording(registered, mergeCatalog(zhHant))).toEqual({
      title: 'Plain',
      category: '動作',
    })
  })
})
