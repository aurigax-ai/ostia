import { useExtensionsStore } from '@/stores/extensions/extensionsStore'
import {
  focusSurfaceWhenReady,
  mountSurface,
  releaseSurfaces,
  surfaceHost,
} from '@/stores/workspaces/surfaceSlotsStore'
import type { ExtensionInfo } from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { ExtensionSidePanel } from './ExtensionSidePanel'

const PANE = 'panel-pane'
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve)))

describe('ExtensionSidePanel keyboard target', () => {
  let extensionsInit: ReturnType<typeof useExtensionsStore.getState>

  beforeAll(() => {
    extensionsInit = useExtensionsStore.getState()
  })

  afterEach(() => {
    cleanup()
    releaseSurfaces(new Set())
    document.body.innerHTML = ''
    useExtensionsStore.setState(extensionsInit, true)
  })

  it('takes the keyboard only once its guest is ready, so a key pressed before that is never lost in it', async () => {
    const info = {
      id: 'graphs',
      name: 'Graphs',
      enabled: true,
      panel: { title: 'Graphs' },
    } as unknown as ExtensionInfo
    useExtensionsStore.setState({ list: [info] })
    vi.mocked(window.ostia.extensions.panel).mockResolvedValue({
      ok: true,
      src: 'http://127.0.0.1:1/panel',
    })
    const slot = document.createElement('div')
    document.body.appendChild(slot)
    mountSurface(PANE, slot)
    render(<ExtensionSidePanel extId="graphs" workspaceId="w1" focusKey={PANE} />, {
      container: surfaceHost(PANE),
    })
    const webview = await waitFor(() => {
      const found = surfaceHost(PANE).querySelector<HTMLElement>('webview')
      if (!found) throw new Error('no webview yet')
      return found
    })
    webview.tabIndex = 0

    focusSurfaceWhenReady(PANE, () => true)
    await settle()
    expect(document.activeElement).not.toBe(webview)

    act(() => {
      webview.dispatchEvent(new Event('dom-ready'))
    })
    await waitFor(() => expect(document.activeElement).toBe(webview))
  })
})
