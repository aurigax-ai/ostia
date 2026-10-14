import '@testing-library/jest-dom/vitest'
import { useSandboxStore } from '@/stores/app/sandboxStore'
import type { PortableResult } from '@shared/artifacts/portable'
import { cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderSettled } from '../../../../test/render'
import { PortableActions } from './PortableActions'
import { portableDocument } from './portableDocuments'

const DIR = '/data/artifacts/s1'

function actions(path: string): JSX.Element {
  return <PortableActions workspaceId="s1" filePath={`${DIR}/${path}`} />
}

describe('PortableActions', () => {
  let sandboxInit: ReturnType<typeof useSandboxStore.getState>

  beforeAll(() => {
    sandboxInit = useSandboxStore.getState()
  })

  beforeEach(() => {
    vi.mocked(window.ostia.artifacts.portable).mockResolvedValue({ ok: true })
    vi.mocked(window.ostia.fs.read).mockResolvedValue({ ok: true, text: '# Plan\n', version: 'v1' })
  })

  afterEach(() => {
    cleanup()
    useSandboxStore.setState(sandboxInit, true)
  })

  it('PRT-C37 puts one Open in Browser split button on each type with a portable form, none on a PNG', async () => {
    for (const path of ['chart.tsx', 'page.html', 'plan.md', 'logo.svg', 'rows.csv', 'data.json']) {
      const view = await renderSettled(actions(path))
      const groups = screen.getAllByRole('group', { name: 'Portable file' })
      expect(groups, path).toHaveLength(1)
      expect(screen.getByRole('button', { name: 'Open in Browser' })).toBeInTheDocument()
      expect(
        screen.getByRole('button', { name: 'More ways to take this file' }),
      ).toBeInTheDocument()
      view.unmount()
    }
    const png = await renderSettled(actions('photo.png'))
    expect(png.container).toBeEmptyDOMElement()
  })

  it('PRT-C38 offers nothing for a runnable file of a sandboxed workspace, but saves its Markdown', async () => {
    useSandboxStore.setState({ enabled: { s1: true } })
    for (const path of ['chart.tsx', 'page.html']) {
      const view = await renderSettled(actions(path))
      expect(view.container, path).toBeEmptyDOMElement()
      view.unmount()
    }
    await renderSettled(actions('plan.md'))
    await userEvent.click(screen.getByRole('button', { name: 'Open in Browser' }))
    await waitFor(() =>
      expect(window.ostia.artifacts.portable).toHaveBeenCalledWith(
        'open',
        expect.objectContaining({ workspaceId: 's1', path: `${DIR}/plan.md` }),
      ),
    )
  })

  it('PRT-C36 says why a save failed and says nothing when the human cancelled', async () => {
    const answers: PortableResult[] = [
      { ok: false, reason: 'cancelled' },
      { ok: false, reason: 'failed', message: 'EACCES: permission denied' },
    ]
    vi.mocked(window.ostia.artifacts.portable).mockImplementation(
      async () => answers.shift() ?? { ok: true },
    )
    await renderSettled(actions('plan.md'))
    const save = async (): Promise<void> => {
      await userEvent.click(screen.getByRole('button', { name: 'More ways to take this file' }))
      await userEvent.click(await screen.findByRole('menuitem', { name: 'Save Portable File…' }))
    }
    await save()
    await waitFor(() => expect(window.ostia.artifacts.portable).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId('portable-problem')).not.toBeInTheDocument()
    await save()
    expect(await screen.findByTestId('portable-problem')).toHaveTextContent(
      'EACCES: permission denied',
    )
  })

  it('PRT-C40 shows the build error when a component does not build', async () => {
    vi.mocked(window.ostia.artifacts.portable).mockResolvedValue({
      ok: false,
      reason: 'not-built',
      message: 'broken.tsx:2:1: Unexpected end of file',
    })
    await renderSettled(actions('broken.tsx'))
    await userEvent.click(screen.getByRole('button', { name: 'Open in Browser' }))
    expect(await screen.findByTestId('portable-problem')).toHaveTextContent(
      'broken.tsx:2:1: Unexpected end of file',
    )
  })
})

describe('portableDocument', () => {
  it('PRT-C7 leaves out raw HTML, remote images and event handlers from Markdown', async () => {
    const source = [
      '# Report',
      '',
      '<script>alert(1)</script>',
      '',
      '![remote](http://127.0.0.1:9/x.png)',
      '',
      '<img src="x" onerror="alert(2)">',
      '',
      '[a link](https://example.com)',
    ].join('\n')
    const made = await portableDocument('/data/a/report.md', source, false)
    expect(made).toBeDefined()
    if (!made) return
    const html = made.body
    const parsed = new DOMParser().parseFromString(html, 'text/html')
    expect(parsed.querySelectorAll('script')).toHaveLength(0)
    expect(parsed.querySelectorAll('img[src^="http"]')).toHaveLength(0)
    expect(parsed.querySelectorAll('[onerror]')).toHaveLength(0)
    expect(parsed.querySelector('h1')).not.toBeNull()
    expect(html).toMatch(
      /<a href="https:\/\/example.com" target="_blank" rel="noopener noreferrer"/,
    )
  })
})
