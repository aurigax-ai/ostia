import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { zhHant } from '../i18n/dict'
import { languagesFrom } from '../lib/languagePacks'
import { useExtensionsStore } from '../stores/extensionsStore'
import { usePluginsStore } from '../stores/pluginsStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'
import { SettingsPanel } from './SettingsPanel'

if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => []
}

function renderSettings(): void {
  useUIStore.setState({ settingsActive: true, settingsTabOpen: true })
  render(<SettingsPanel />)
}

function nav(): HTMLElement {
  return screen.getByRole('navigation')
}

function searchBox(): HTMLElement {
  return screen.getByRole('textbox', { name: 'Search settings' })
}

function result(id: string): HTMLElement {
  const section = document.querySelector<HTMLElement>(`[data-settings-result="${id}"]`)
  if (!section) throw new Error(`no result section ${id}`)
  return section
}

function rowOf(control: HTMLElement): HTMLElement {
  const row = control.closest<HTMLElement>('[data-settings-row]')
  if (!row) throw new Error('no row')
  return row
}

describe('SettingsPanel search', () => {
  let settingsInit: ReturnType<typeof useSettingsStore.getState>
  let uiInit: ReturnType<typeof useUIStore.getState>
  let pluginsInit: ReturnType<typeof usePluginsStore.getState>
  let extensionsInit: ReturnType<typeof useExtensionsStore.getState>

  beforeAll(() => {
    Object.assign(window, { queryLocalFonts: async () => [] })
    settingsInit = useSettingsStore.getState()
    uiInit = useUIStore.getState()
    pluginsInit = usePluginsStore.getState()
    extensionsInit = useExtensionsStore.getState()
  })

  afterEach(() => {
    cleanup()
    useSettingsStore.setState(settingsInit, true)
    useUIStore.setState(uiInit, true)
    usePluginsStore.setState(pluginsInit, true)
    useExtensionsStore.setState(extensionsInit, true)
    vi.restoreAllMocks()
  })

  it('shows a matching row from a section that is not open, with the query marked', async () => {
    renderSettings()
    const user = userEvent.setup()
    expect(screen.getByRole('heading', { level: 2, name: 'Appearance' })).toBeInTheDocument()

    await user.type(searchBox(), 'BLINK')

    const terminal = result('terminal')
    expect(terminal).toBeVisible()
    expect(within(terminal).getByRole('heading', { level: 2, name: 'Terminal' })).toBeVisible()
    const blink = within(terminal).getByRole('switch', { name: 'Cursor blink' })
    expect(rowOf(blink)).toBeVisible()
    const marks = within(rowOf(blink)).getAllByText('blink', { selector: 'mark' })
    expect(marks.length).toBeGreaterThan(0)
    expect(marks[0]).toHaveClass('settings-search-mark')

    expect(
      rowOf(within(terminal).getByRole('switch', { name: 'Copy on select', hidden: true })),
    ).not.toBeVisible()
    expect(result('appearance')).not.toBeVisible()
    expect(searchBox()).toHaveFocus()
  })

  it('lists only sections with matches in the nav, with their match count', async () => {
    renderSettings()
    const user = userEvent.setup()
    await user.type(searchBox(), 'cursor blink')

    const terminal = within(nav()).getByRole('button', { name: 'Terminal' })
    expect(terminal).toHaveTextContent(/Terminal\s*1$/)
    expect(within(nav()).queryByRole('button', { name: 'Appearance' })).toBeNull()
    expect(within(nav()).queryByRole('button', { name: 'Notifications' })).toBeNull()
  })

  it('finds a row by one of its option labels', async () => {
    renderSettings()
    const user = userEvent.setup()
    await user.type(searchBox(), 'reduced')

    const motion = within(result('appearance')).getByRole('combobox', { name: 'Motion' })
    expect(rowOf(motion)).toBeVisible()
    expect(within(nav()).getByRole('button', { name: 'Appearance' })).toBeInTheDocument()
  })

  it('shows a whole section when its title matches', async () => {
    renderSettings()
    const user = userEvent.setup()
    await user.type(searchBox(), 'sidebar')

    const sidebar = result('sidebar')
    expect(sidebar).toBeVisible()
    for (const row of within(sidebar).getAllByRole('switch')) expect(rowOf(row)).toBeVisible()
  })

  it('says nothing matches, and restores the open page when the query is cleared', async () => {
    renderSettings()
    const user = userEvent.setup()
    await user.type(searchBox(), 'zzqx')

    expect(screen.getByText('No settings match')).toBeInTheDocument()
    expect(within(nav()).queryAllByRole('listitem')).toHaveLength(0)

    await user.clear(searchBox())
    expect(screen.queryByText('No settings match')).toBeNull()
    expect(document.querySelector('[data-settings-result]')).toBeNull()
    expect(document.querySelector('mark')).toBeNull()
    expect(screen.getByRole('heading', { level: 2, name: 'Appearance' })).toBeInTheDocument()
  })

  it('moves to the first match on Enter and clears the query on Escape without closing', async () => {
    renderSettings()
    const user = userEvent.setup()
    await user.type(searchBox(), 'copy on select{Enter}')
    expect(screen.getByRole('switch', { name: 'Copy on select' })).toHaveFocus()

    searchBox().focus()
    await user.keyboard('{Escape}')
    expect(searchBox()).toHaveValue('')
    expect(useUIStore.getState().settingsActive).toBe(true)
  })

  it('matches the strings of the current UI language', async () => {
    usePluginsStore.setState({
      languages: languagesFrom([
        { extId: 'langpack-zh-hant', id: 'zh-Hant', label: '繁體中文', catalog: zhHant },
      ]),
    })
    useSettingsStore.setState({ locale: 'zh-Hant' })
    renderSettings()
    const user = userEvent.setup()
    await user.type(screen.getByRole('textbox', { name: zhHant.settings.search }), '游標閃爍')

    const blink = within(result('terminal')).getByRole('switch', {
      name: zhHant.settings.cursorBlink,
    })
    expect(rowOf(blink)).toBeVisible()
    expect(within(rowOf(blink)).getByText('游標閃爍', { selector: 'mark' })).toBeInTheDocument()
  })
})
