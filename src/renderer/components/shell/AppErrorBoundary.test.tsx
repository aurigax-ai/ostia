import { commands } from '@/commands/registry'
import { SurfaceErrorBoundary } from '@/components/panes/SurfaceErrorBoundary'
import { startErrorReporting } from '@/lib/app/errorReporting'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppErrorBoundary, CrashTestHook } from './AppErrorBoundary'

function Boom({ message }: { message: string }): JSX.Element {
  throw new Error(message)
}

let consoleError: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  consoleError.mockRestore()
})

describe('AppErrorBoundary', () => {
  it('shows the recovery screen with the error instead of a blank window', () => {
    render(
      <AppErrorBoundary>
        <Boom message="layout exploded" />
      </AppErrorBoundary>,
    )
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByText('Something went wrong')).toBeInTheDocument()
    expect(screen.getByText('layout exploded')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reload window' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy details' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open log folder' })).toBeInTheDocument()
  })

  it('reports the error to main as a render error, with the component stack', () => {
    render(
      <AppErrorBoundary>
        <Boom message="layout exploded" />
      </AppErrorBoundary>,
    )
    expect(window.ostia.diagnostics.report).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'render',
        message: 'layout exploded',
        stack: expect.stringContaining('Boom'),
      }),
    )
  })

  it('reloads the window, opens the log folder and copies the details', async () => {
    const user = userEvent.setup()
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
    vi.mocked(window.ostia.info).mockResolvedValue({
      name: 'ostia',
      version: '1.2.3',
      platform: 'linux',
    } as Awaited<ReturnType<typeof window.ostia.info>>)
    render(
      <AppErrorBoundary>
        <Boom message="layout exploded" />
      </AppErrorBoundary>,
    )
    await user.click(screen.getByRole('button', { name: 'Reload window' }))
    expect(window.ostia.diagnostics.reloadWindow).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: 'Open log folder' }))
    expect(window.ostia.diagnostics.openLogFolder).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(window.ostia.info).toHaveBeenCalled())
    await user.click(screen.getByRole('button', { name: 'Copy details' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument())
    const copied = writeText.mock.calls[0]?.[0] ?? ''
    expect(copied).toContain('error: layout exploded')
    expect(copied).toContain('version: 1.2.3')
  })

  it('crashes on the test hook only when main enables test hooks', async () => {
    let crash: () => void = () => {}
    vi.mocked(window.ostia.diagnostics.testHooks).mockResolvedValue(true)
    vi.mocked(window.ostia.diagnostics.onTestCrash).mockImplementation((handler) => {
      crash = handler
      return () => {}
    })
    render(
      <AppErrorBoundary>
        <span>app body</span>
        <CrashTestHook />
      </AppErrorBoundary>,
    )
    await waitFor(() => expect(window.ostia.diagnostics.onTestCrash).toHaveBeenCalled())
    expect(screen.getByText('app body')).toBeInTheDocument()
    act(() => crash())
    expect(screen.getByText('Something went wrong')).toBeInTheDocument()
  })

  it('does not listen for the test crash when test hooks are off', async () => {
    render(<CrashTestHook />)
    await waitFor(() => expect(window.ostia.diagnostics.testHooks).toHaveBeenCalled())
    expect(window.ostia.diagnostics.onTestCrash).not.toHaveBeenCalled()
  })
})

describe('SurfaceErrorBoundary', () => {
  it('keeps a broken pane to itself and offers to close it', async () => {
    const user = userEvent.setup()
    const exec = vi.spyOn(commands, 'exec').mockResolvedValue({ ok: true, result: undefined })
    render(
      <>
        <SurfaceErrorBoundary paneId="p-2">
          <Boom message="viewer broke" />
        </SurfaceErrorBoundary>
        <SurfaceErrorBoundary paneId="p-1">
          <span>healthy pane</span>
        </SurfaceErrorBoundary>
      </>,
    )
    expect(screen.getByText('healthy pane')).toBeInTheDocument()
    expect(screen.getByText('This pane hit an error')).toBeInTheDocument()
    expect(screen.getByText('viewer broke')).toBeInTheDocument()
    expect(window.ostia.diagnostics.report).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'surface', message: 'viewer broke', source: 'pane p-2' }),
    )
    await user.click(screen.getByRole('button', { name: 'Close pane' }))
    expect(exec).toHaveBeenCalledWith('pane.close', { paneId: 'p-2' })
    exec.mockRestore()
  })
})

describe('startErrorReporting', () => {
  it('reports uncaught errors and unhandled rejections to main', () => {
    const stop = startErrorReporting(window)
    window.dispatchEvent(
      new ErrorEvent('error', {
        error: new Error('late failure'),
        message: 'late failure',
        filename: 'app.js',
        lineno: 3,
        colno: 9,
      }),
    )
    const rejection = new Event('unhandledrejection') as PromiseRejectionEvent
    Object.defineProperty(rejection, 'reason', { value: new Error('lost promise') })
    window.dispatchEvent(rejection)
    stop()
    expect(window.ostia.diagnostics.report).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'error', message: 'late failure', source: 'app.js:3:9' }),
    )
    expect(window.ostia.diagnostics.report).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'rejection', message: 'lost promise' }),
    )
  })
})
