import '@testing-library/jest-dom/vitest'
import type {
  ScriptTokenInfo,
  ScriptTokenSaveResult,
  ScriptTokensState,
} from '@shared/permissions/scriptTokens'
import { PRODUCT_DISPLAY_NAME } from '@shared/productDisplay'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ScriptTokensSection } from './ScriptTokensSection'

if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => []
}

const DAY = 86_400_000
const NOW = Date.now()
const at = (ms: number) => new Date(NOW + ms).toISOString()
const COORDINATOR = [
  'read-board',
  'read-other-pane',
  'send-other-pane',
  'type-other-pane',
  'process',
  'notify',
] as const
const VALUE = `ostia_${'a1'.repeat(32)}`

function token(over: Partial<ScriptTokenInfo>): ScriptTokenInfo {
  return {
    id: 't0',
    name: 'token',
    caps: ['read-board'],
    scope: { kind: 'all' },
    createdAt: at(-DAY),
    updatedAt: at(-DAY),
    expiresAt: at(90 * DAY),
    lastUsedAt: null,
    source: 'settings',
    ...over,
  }
}

const CEO = token({
  id: 't1',
  name: 'ostia-ceo',
  caps: [...COORDINATOR],
  scope: { kind: 'limited', groups: ['g1'], workspaces: [], ownWorkspaces: true },
  createdAt: '2026-10-10T02:00:00.000Z',
  updatedAt: '2026-10-10T02:00:00.000Z',
  lastUsedAt: at(-3 * 60_000),
})
const PATROL = token({
  id: 't2',
  name: 'patrol',
  caps: ['read-board', 'read-other-pane'],
  createdAt: at(-2 * DAY),
  expiresAt: at(5 * DAY - 60_000),
  lastUsedAt: at(-3_600_000),
  source: 'cli',
})
const RAYCAST = token({
  id: 't3',
  name: 'raycast',
  caps: ['read-board', 'notify'],
  scope: { kind: 'limited', groups: [], workspaces: ['w2'], ownWorkspaces: false },
  createdAt: at(-3 * DAY),
  expiresAt: null,
})

const STATE: ScriptTokensState = {
  tokens: [CEO, PATROL, RAYCAST],
  retired: [
    { name: 'ci-local', retiredAt: at(-DAY) },
    { name: 'patrol-old', retiredAt: at(-DAY) },
  ],
  workspaces: [
    { id: 'w1', name: 'ostia', groupId: 'g1' },
    { id: 'w2', name: 'tools' },
    { id: 'w3', name: 'topomapx', groupId: 'g1' },
  ],
  groups: [{ id: 'g1', name: 'AurigaX', color: 'purple' }],
}

const api = () => window.ostia.scriptTokens

function rowOf(name: string): HTMLElement {
  const row = screen.getByRole('button', { name }).closest('li')
  if (!row) throw new Error(`no row for ${name}`)
  return row
}

async function openGenerate(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(await screen.findByRole('button', { name: 'Generate new token' }))
  return screen.findByRole('dialog', { name: 'Generate new token' })
}

async function pickExpiry(user: ReturnType<typeof userEvent.setup>, label: string) {
  await user.click(screen.getByRole('combobox', { name: 'Expiration' }))
  await user.click(await screen.findByRole('option', { name: label }))
}

describe('ScriptTokensSection', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.mocked(api().list).mockResolvedValue(structuredClone(STATE))
    vi.mocked(api().create).mockReset()
    vi.mocked(api().update).mockReset()
    vi.mocked(api().revoke).mockClear()
  })

  afterEach(() => {
    vi.mocked(api().list).mockResolvedValue({ tokens: [], retired: [], workspaces: [], groups: [] })
  })

  it('lists tokens with scope, permissions, expiry and last use', async () => {
    render(<ScriptTokensSection />)

    const ceo = (await screen.findByRole('button', { name: 'ostia-ceo' })).closest('li')
    if (!ceo) throw new Error('no row')
    expect(ceo).toHaveTextContent('AurigaX')
    expect(ceo).toHaveTextContent('6 permissions')
    expect(ceo).toHaveTextContent('Can run commands')
    expect(ceo).toHaveTextContent('3 minutes ago')

    const patrol = rowOf('patrol')
    expect(patrol).toHaveTextContent('Expires soon')
    expect(patrol).toHaveTextContent('All workspaces')
    expect(patrol).toHaveTextContent('Read workspaces, Read terminal output')
    expect(patrol).toHaveTextContent('Expires in 5 days')
    expect(patrol).not.toHaveTextContent('Can run commands')

    const raycast = rowOf('raycast')
    expect(raycast).toHaveTextContent('Workspace tools')
    expect(raycast).toHaveTextContent('Never expires')
    expect(raycast).toHaveTextContent('Never used')

    expect(screen.getByText(`Use outside ${PRODUCT_DISPLAY_NAME}`)).toBeInTheDocument()
    expect(screen.getByText('ostia pane list --json')).toBeInTheDocument()
  })

  it('shows the retired tokens once and remembers the dismissal', async () => {
    const user = userEvent.setup()
    const { unmount } = render(<ScriptTokensSection />)
    const banner = await screen.findByRole('status')
    expect(banner).toHaveTextContent(
      `2 old tokens stopped working after the ${PRODUCT_DISPLAY_NAME} upgrade`,
    )
    expect(banner).toHaveTextContent('ci-local, patrol-old can no longer connect')
    await user.click(within(banner).getByRole('button', { name: 'Got it' }))
    expect(screen.queryByRole('status')).toBeNull()

    unmount()
    render(<ScriptTokensSection />)
    await screen.findByRole('button', { name: 'ostia-ceo' })
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('reloads when main says the tokens changed', async () => {
    let changed: () => void = () => {}
    vi.mocked(api().onChanged).mockImplementationOnce((cb) => {
      changed = cb
      return () => {}
    })
    render(<ScriptTokensSection />)
    await screen.findByRole('button', { name: 'ostia-ceo' })
    vi.mocked(api().list).mockResolvedValue({ ...STATE, tokens: [PATROL] })
    changed()
    await waitFor(() => expect(screen.queryByRole('button', { name: 'ostia-ceo' })).toBeNull())
  })

  it('asks again before generating a token that never expires, then shows the value once', async () => {
    const user = userEvent.setup()
    const made = token({ id: 't9', name: 'ceo', caps: [...COORDINATOR], expiresAt: null })
    vi.mocked(api().create).mockResolvedValue({ ok: true, token: made, value: VALUE })
    render(<ScriptTokensSection />)
    const dialog = await openGenerate(user)

    await user.type(within(dialog).getByLabelText('Name'), 'ceo')
    await user.click(within(dialog).getByRole('radio', { name: /All workspaces/ }))
    await user.click(within(dialog).getByRole('button', { name: 'Coordinator' }))
    expect(within(dialog).getByRole('checkbox', { name: /Background processes/ })).toBeChecked()
    expect(within(dialog).getByRole('checkbox', { name: /Close panes/ })).not.toBeChecked()
    expect(within(dialog).getByText('Can run commands in 3 workspaces')).toBeInTheDocument()

    await pickExpiry(user, 'Never expires')
    expect(within(dialog).getByText(/A token that never expires stays valid/)).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Generate token' }))

    const confirm = await screen.findByRole('alertdialog', {
      name: 'Generate a token that never expires?',
    })
    expect(confirm).toHaveTextContent('"ceo" can run commands in 3 workspaces.')
    expect(api().create).not.toHaveBeenCalled()
    await user.click(within(confirm).getByRole('button', { name: 'Keep "never expires"' }))

    await waitFor(() => expect(api().create).toHaveBeenCalledTimes(1))
    const sent = vi.mocked(api().create).mock.calls[0][0]
    expect(sent).toMatchObject({
      name: 'ceo',
      scope: { kind: 'all' },
      expires: 'never',
      confirmNeverExpires: true,
    })
    expect([...sent.caps].sort()).toEqual([...COORDINATOR].sort())

    const shown = await screen.findByRole('dialog', { name: 'Generated "ceo"' })
    expect(within(shown).getByRole('textbox', { name: 'Token value' })).toHaveValue(VALUE)
    await user.click(within(shown).getByRole('button', { name: 'Copy' }))
    await expect(navigator.clipboard.readText()).resolves.toBe(VALUE)
    expect(await within(shown).findByRole('button', { name: 'Copied' })).toBeInTheDocument()
    await user.click(within(shown).getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(screen.queryByDisplayValue(VALUE)).toBeNull())
    expect(document.body.textContent).not.toContain(VALUE)
  })

  it('switches to 90 days from the never-expires confirmation', async () => {
    const user = userEvent.setup()
    vi.mocked(api().create).mockResolvedValue({
      ok: true,
      token: token({ id: 't9', name: 'cron' }),
      value: VALUE,
    })
    render(<ScriptTokensSection />)
    const dialog = await openGenerate(user)
    await user.type(within(dialog).getByLabelText('Name'), 'cron')
    await user.click(within(dialog).getByRole('radio', { name: /All workspaces/ }))
    await pickExpiry(user, 'Never expires')
    await user.click(within(dialog).getByRole('button', { name: 'Generate token' }))
    const confirm = await screen.findByRole('alertdialog')
    await user.click(within(confirm).getByRole('button', { name: 'Use 90 days' }))

    await waitFor(() => expect(api().create).toHaveBeenCalledTimes(1))
    const sent = vi.mocked(api().create).mock.calls[0][0]
    expect(sent.expires).toBe('90d')
    expect(sent).not.toHaveProperty('confirmNeverExpires')
  })

  it('needs a group or workspace before generating a limited token', async () => {
    const user = userEvent.setup()
    vi.mocked(api().create).mockResolvedValue({
      ok: true,
      token: token({ id: 't9', name: 'board' }),
      value: VALUE,
    })
    render(<ScriptTokensSection />)
    const dialog = await openGenerate(user)
    await user.type(within(dialog).getByLabelText('Name'), 'board')
    const generate = within(dialog).getByRole('button', { name: 'Generate token' })
    expect(generate).toBeDisabled()
    expect(within(dialog).getByText('Add at least one group or workspace.')).toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: 'Add' }))
    await user.click(await screen.findByRole('menuitem', { name: /AurigaX/ }))
    expect(within(dialog).getByText('AurigaX group · 2')).toBeInTheDocument()
    expect(within(dialog).getByText('Can read 2 workspaces')).toBeInTheDocument()
    await user.click(
      within(dialog).getByRole('checkbox', { name: /workspaces this token creates/ }),
    )
    await user.click(generate)
    await waitFor(() =>
      expect(api().create).toHaveBeenCalledWith({
        name: 'board',
        caps: ['read-board', 'read-other-pane'],
        scope: { kind: 'limited', groups: ['g1'], workspaces: [], ownWorkspaces: true },
        expires: '90d',
      }),
    )
  })

  it.each<[string, ScriptTokenSaveResult, string]>([
    [
      'cancelled',
      { ok: false, error: 'presence-cancelled: dismissed', presence: 'cancelled' },
      'The confirmation was cancelled. Nothing changed.',
    ],
    [
      'refused',
      {
        ok: false,
        error: 'presence-failed: Touch ID did not confirm',
        presence: 'refused',
      },
      `${PRODUCT_DISPLAY_NAME} couldn't confirm it's you, so nothing changed. Touch ID did not confirm`,
    ],
    [
      'missing a polkit agent',
      { ok: false, error: 'presence-unavailable: no agent', presence: 'polkit-agent' },
      'No polkit authentication agent is running',
    ],
  ])('shows no value when the presence check is %s', async (_what, result, message) => {
    const user = userEvent.setup()
    vi.mocked(api().create).mockResolvedValue(result)
    render(<ScriptTokensSection />)
    const dialog = await openGenerate(user)
    await user.type(within(dialog).getByLabelText('Name'), 'ceo')
    await user.click(within(dialog).getByRole('radio', { name: /All workspaces/ }))
    await user.click(within(dialog).getByRole('button', { name: 'Generate token' }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(message)
    expect(screen.queryByRole('textbox', { name: 'Token value' })).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Generate new token' })).toBeInTheDocument()
  })

  it('warns that saving changes the token when permissions change, and shows the new value', async () => {
    const user = userEvent.setup()
    vi.mocked(api().update).mockResolvedValue({ ok: true, token: CEO, value: VALUE })
    render(<ScriptTokensSection />)
    await user.click(await screen.findByRole('button', { name: 'Edit ostia-ceo' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit "ostia-ceo"' })
    expect(within(dialog).getByLabelText('Name')).toHaveValue('ostia-ceo')
    expect(within(dialog).getByRole('button', { name: 'Coordinator' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(within(dialog).getByText('AurigaX group · 2')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled()

    await user.click(within(dialog).getByRole('checkbox', { name: /Close panes/ }))
    expect(within(dialog).getByRole('button', { name: 'Custom' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(
      within(dialog).getByText(/The old token stops working as soon as you save/),
    ).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Save and regenerate' }))

    await waitFor(() => expect(api().update).toHaveBeenCalledTimes(1))
    const sent = vi.mocked(api().update).mock.calls[0][0]
    expect(sent).toEqual({ id: 't1', ifUpdatedAt: CEO.updatedAt, caps: expect.any(Array) })
    expect(sent.caps).toContain('kill-pane')
    const shown = await screen.findByRole('dialog', { name: 'Updated "ostia-ceo"' })
    expect(within(shown).getByRole('textbox', { name: 'Token value' })).toHaveValue(VALUE)
  })

  it('renames without regenerating', async () => {
    const user = userEvent.setup()
    vi.mocked(api().update).mockResolvedValue({ ok: true, token: { ...CEO, name: 'ceo-2' } })
    render(<ScriptTokensSection />)
    await user.click(await screen.findByRole('button', { name: 'Edit ostia-ceo' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit "ostia-ceo"' })
    const name = within(dialog).getByLabelText('Name')
    await user.clear(name)
    await user.type(name, 'ceo-2')
    expect(within(dialog).getByText('Renaming keeps the token value.')).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: 'Save and regenerate' })).toBeNull()
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(api().update).toHaveBeenCalledWith({
        id: 't1',
        ifUpdatedAt: CEO.updatedAt,
        name: 'ceo-2',
      }),
    )
    expect(await screen.findByText('Renamed. The token value did not change.')).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Token value' })).toBeNull()
  })

  it('regenerates when only the expiration changes', async () => {
    const user = userEvent.setup()
    vi.mocked(api().update).mockResolvedValue({ ok: true, token: CEO, value: VALUE })
    render(<ScriptTokensSection />)
    await user.click(await screen.findByRole('button', { name: 'Edit ostia-ceo' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit "ostia-ceo"' })
    await pickExpiry(user, '30 days')
    await user.click(within(dialog).getByRole('button', { name: 'Save and regenerate' }))
    await waitFor(() =>
      expect(api().update).toHaveBeenCalledWith({
        id: 't1',
        ifUpdatedAt: CEO.updatedAt,
        expires: '30d',
      }),
    )
  })

  it('revokes only after the confirmation', async () => {
    const user = userEvent.setup()
    render(<ScriptTokensSection />)
    await user.click(await screen.findByRole('button', { name: 'More for patrol' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Revoke' }))
    const confirm = await screen.findByRole('alertdialog', { name: 'Revoke "patrol"?' })
    expect(api().revoke).not.toHaveBeenCalled()
    await user.click(within(confirm).getByRole('button', { name: 'Revoke' }))
    await waitFor(() => expect(api().revoke).toHaveBeenCalledWith('t2'))
    expect(await screen.findByText('Revoked "patrol".')).toBeInTheDocument()
  })

  it('goes back to the list from the details', async () => {
    const user = userEvent.setup()
    render(<ScriptTokensSection />)
    await user.click(await screen.findByRole('button', { name: 'patrol' }))
    expect(screen.getByText(/^Generated .* from the CLI$/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Script tokens' }))
    expect(await screen.findByRole('button', { name: 'Generate new token' })).toBeInTheDocument()
  })

  it('shows the details of a token and revokes it from there', async () => {
    const user = userEvent.setup()
    render(<ScriptTokensSection />)
    await user.click(await screen.findByRole('button', { name: 'ostia-ceo' }))

    expect(screen.getByRole('heading', { name: 'ostia-ceo' })).toBeInTheDocument()
    expect(screen.getByText(/^Generated 2026-10-10 in Settings$/)).toBeInTheDocument()
    expect(screen.getByText('AurigaX group')).toBeInTheDocument()
    expect(screen.getByText('Workspaces it creates')).toBeInTheDocument()
    expect(screen.getByText('Background processes')).toBeInTheDocument()
    expect(screen.getByText('90 days left')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Revoke' }))
    const confirm = await screen.findByRole('alertdialog', { name: 'Revoke "ostia-ceo"?' })
    await user.click(within(confirm).getByRole('button', { name: 'Revoke' }))
    await waitFor(() => expect(api().revoke).toHaveBeenCalledWith('t1'))
    expect(await screen.findByRole('button', { name: 'Generate new token' })).toBeInTheDocument()
  })
})
