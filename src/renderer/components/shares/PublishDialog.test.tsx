import '@testing-library/jest-dom/vitest'
import type { PortableResult } from '@shared/artifacts/portable'
import type { ShareAvailability, ShareView } from '@shared/artifacts/shares'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CaptureLayer } from '@/components/capture/CaptureLayer'
import { useSandboxStore } from '@/stores/app/sandboxStore'
import { useSharesStore } from '@/stores/files/sharesStore'
import { renderSettled } from '../../../../test/render'
import { PortableActions } from '../editor/PortableActions'

const DIR = '/data/artifacts/s1'
const FILE = `${DIR}/plan.md`

const READY: ShareAvailability = {
  state: 'ready',
  allowNever: false,
  allowPublic: false,
  maxBytes: 16_000_000,
}

const SHARE: ShareView = {
  id: 'abc',
  url: 'https://abc.shares.test/',
  mode: 'link',
  size: 120,
  views: 0,
  expiresAt: Date.UTC(2027, 0, 5),
  uploaded: true,
  expired: false,
  name: 'plan.md',
  source: FILE,
  linkable: true,
}

function Harness(): JSX.Element {
  return (
    <>
      <PortableActions workspaceId="s1" filePath={FILE} paneId="p1" />
      <CaptureLayer workspaceId="s1" paneId="p1" />
    </>
  )
}

function portable() {
  return vi.mocked(window.ostia.artifacts.portable)
}

function serverSays(availability: ShareAvailability, shares: ShareView[] = []): void {
  vi.mocked(window.ostia.shares.status).mockResolvedValue(availability)
  vi.mocked(window.ostia.shares.list).mockResolvedValue({ ok: true, shares })
}

async function openMenu(): Promise<void> {
  await userEvent.click(screen.getByRole('button', { name: 'More ways to take this file' }))
}

async function openDialog(): Promise<HTMLElement> {
  await openMenu()
  await userEvent.click(await screen.findByRole('menuitem', { name: /Publish…/ }))
  return screen.findByRole('dialog')
}

describe('publishing from the artifact menu', () => {
  beforeEach(() => {
    useSharesStore.setState({ availability: null, shares: [], error: null, loaded: false })
    useSandboxStore.setState({ enabled: {} })
    vi.mocked(window.ostia.artifacts.list).mockResolvedValue({
      dir: DIR,
      pad: `${DIR}/PAD.md`,
      padModified: null,
      entries: [],
    })
    vi.mocked(window.ostia.fs.read).mockResolvedValue({ ok: true, text: '# Plan\n', version: 'v1' })
    portable().mockResolvedValue({ ok: true })
    serverSays(READY)
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('SHR-C60 disables Publish with the reason instead of hiding it', async () => {
    const cases: Array<[ShareAvailability, string]> = [
      [{ state: 'signed-out' }, 'Not signed in to a server'],
      [{ state: 'off' }, 'Server has publishing off'],
      [{ state: 'unreachable' }, 'Server unreachable'],
    ]
    for (const [availability, reason] of cases) {
      serverSays(availability)
      useSharesStore.setState({ availability: null })
      const view = await renderSettled(<Harness />)
      await openMenu()
      const item = await screen.findByRole('menuitem', { name: new RegExp(`Publish….*${reason}`) })
      expect(item).toHaveAttribute('aria-disabled', 'true')
      await userEvent.keyboard('{Escape}')
      view.unmount()
    }
  })

  it('SHR-C61 offers public and never only when the server allows them', async () => {
    await renderSettled(<Harness />)
    let dialog = await openDialog()
    expect(within(dialog).getByRole('radio', { name: /Anyone with the link/ })).toBeChecked()
    expect(within(dialog).queryByRole('radio', { name: /Public/ })).toBeNull()
    expect(within(dialog).getByRole('combobox', { name: 'Expires after' })).toHaveTextContent(
      '30 days',
    )
    await userEvent.click(within(dialog).getByRole('combobox', { name: 'Expires after' }))
    expect(screen.queryByRole('option', { name: 'Never' })).toBeNull()
    cleanup()
    useSharesStore.setState({ availability: null })
    serverSays({ ...READY, allowNever: true, allowPublic: true })
    await renderSettled(<Harness />)
    dialog = await openDialog()
    await userEvent.click(within(dialog).getByRole('radio', { name: /Public/ }))
    expect(within(dialog).getByText(/server can read a public share/)).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('combobox', { name: 'Expires after' }))
    expect(await screen.findByRole('option', { name: 'Never' })).toBeInTheDocument()
  })

  it('SHR-C62 states what a compromised server could do', async () => {
    await renderSettled(<Harness />)
    const dialog = await openDialog()
    expect(within(dialog).getByText(/could serve a page that leaks the key/)).toBeInTheDocument()
    expect(within(dialog).getByText(/you trust your own machine/)).toBeInTheDocument()
  })

  it('SHR-C63 publishes with the chosen options and copies the link through main', async () => {
    portable().mockResolvedValueOnce({ ok: true, share: SHARE })
    await renderSettled(<Harness />)
    const dialog = await openDialog()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Publish' }))
    await waitFor(() =>
      expect(portable()).toHaveBeenCalledWith(
        'publish',
        expect.objectContaining({
          path: FILE,
          publish: {
            mode: 'link',
            password: '',
            withLinkKey: false,
            expiresInSeconds: 2_592_000,
            acceptedDigest: '',
          },
        }),
      ),
    )
    expect(await screen.findByText('Published')).toBeInTheDocument()
    expect(screen.getByText(/It expires on/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Copy link' }))
    expect(window.ostia.shares.copyLink).toHaveBeenCalledWith('abc')
    expect(await screen.findByRole('button', { name: 'Link copied' })).toBeInTheDocument()
    expect(useSharesStore.getState().shares).toEqual([SHARE])
  })

  it('SHR-C64 needs a long enough password and sends it with the link key choice', async () => {
    portable().mockResolvedValueOnce({ ok: true, share: { ...SHARE, mode: 'password' } })
    await renderSettled(<Harness />)
    const dialog = await openDialog()
    await userEvent.click(within(dialog).getByRole('radio', { name: /Anyone with the password/ }))
    const publish = within(dialog).getByRole('button', { name: 'Publish' })
    expect(publish).toBeDisabled()
    await userEvent.type(within(dialog).getByLabelText('Password'), 'short')
    expect(publish).toBeDisabled()
    await userEvent.type(within(dialog).getByLabelText('Password'), 'er and longer')
    await userEvent.click(within(dialog).getByRole('checkbox'))
    expect(publish).toBeEnabled()
    await userEvent.click(publish)
    await waitFor(() =>
      expect(portable()).toHaveBeenCalledWith(
        'publish',
        expect.objectContaining({
          publish: expect.objectContaining({
            mode: 'password',
            password: 'shorter and longer',
            withLinkKey: true,
          }),
        }),
      ),
    )
    expect(await screen.findByText(/Share the password separately/)).toBeInTheDocument()
  })

  it('SHR-C65 shows masked findings and needs a second click to publish anyway', async () => {
    const findings: PortableResult = {
      ok: false,
      reason: 'findings',
      findings: [{ kind: 'stripe', line: 4, masked: 'sk_…' }],
      findingsDigest: 'seen-digest',
    }
    portable().mockResolvedValueOnce(findings).mockResolvedValueOnce({ ok: true, share: SHARE })
    await renderSettled(<Harness />)
    const dialog = await openDialog()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Publish' }))
    expect(await screen.findByText('This file may contain secrets')).toBeInTheDocument()
    expect(screen.getByTestId('share-findings')).toHaveTextContent('stripe, line 4: sk_…')
    expect(portable()).toHaveBeenCalledTimes(1)
    await userEvent.click(screen.getByRole('button', { name: 'Publish anyway' }))
    await waitFor(() => expect(portable()).toHaveBeenCalledTimes(2))
    expect(portable().mock.calls[1]?.[1]).toMatchObject({
      publish: { acceptedDigest: 'seen-digest' },
    })
    expect(await screen.findByText('Published')).toBeInTheDocument()
  })

  it('SHR-C66 says a failed scan uploaded nothing and keeps the form', async () => {
    portable().mockResolvedValueOnce({ ok: false, reason: 'scan-failed' })
    await renderSettled(<Harness />)
    const dialog = await openDialog()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Publish' }))
    expect(
      await within(dialog).findByText(
        'The check for secrets did not finish, so nothing was uploaded.',
      ),
    ).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Publish' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Publish anyway' })).toBeNull()
  })

  it('SHR-C67 offers to delete the shared copy of this artifact and only of it', async () => {
    serverSays(READY, [SHARE, { ...SHARE, id: 'other', source: `${DIR}/other.md` }])
    await renderSettled(<Harness />)
    await openMenu()
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Delete shared copy' }))
    expect(window.ostia.shares.remove).toHaveBeenCalledWith('abc')
    await waitFor(() =>
      expect(useSharesStore.getState().shares.map((s) => s.id)).toEqual(['other']),
    )
  })

  it('SHR-C68 shows why deleting the shared copy failed in the floating chip', async () => {
    serverSays(READY, [SHARE])
    vi.mocked(window.ostia.shares.remove).mockResolvedValueOnce({ ok: false, error: 'unreachable' })
    await renderSettled(<Harness />)
    await openMenu()
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Delete shared copy' }))
    const chip = await screen.findByTestId('capture-chip')
    expect(chip).toHaveTextContent('Could not reach the server')
    expect(chip).toHaveClass('text-warn-fg')
  })
})
