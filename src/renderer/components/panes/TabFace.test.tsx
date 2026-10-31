import '@testing-library/jest-dom/vitest'
import type { LoadedIconTheme } from '@aurigax-ai/ostia-extension-sdk/contract/iconTheme'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { createPane } from '@/lib/layout/tree'
import { TabFace } from './TabFace'

const active = vi.hoisted(() => ({ theme: null as LoadedIconTheme | null }))

vi.mock('@/stores/extensions/iconThemeStore', () => ({
  useActiveIconTheme: () => active.theme,
}))

afterEach(() => {
  cleanup()
  active.theme = null
})

describe('TabFace', () => {
  it('marks a tab that is kept awake, and no other', () => {
    const { rerender } = render(
      <TooltipProvider>
        <TabFace pane={createPane('terminal')} />
      </TooltipProvider>,
    )
    expect(screen.queryByRole('img', { name: 'Kept awake' })).toBeNull()
    rerender(
      <TooltipProvider>
        <TabFace pane={{ ...createPane('terminal'), keepAwake: true }} />
      </TooltipProvider>,
    )
    expect(screen.getByRole('img', { name: 'Kept awake' })).toBeInTheDocument()
  })

  it('shows the icon theme icon on a file tab and the default icon without a theme', () => {
    const theme: LoadedIconTheme = {
      id: 'fixture-icons',
      label: 'Fixture Icons',
      icons: { ts: 'data:image/svg+xml,ts' },
      base: {
        fileExtensions: { ts: 'ts' },
        fileNames: {},
        folderNames: {},
        folderNamesExpanded: {},
        languageIds: {},
      },
    }
    const pane = { ...createPane('editor'), filePath: '/w/main.ts', title: 'main.ts' }
    const view = () => (
      <TooltipProvider>
        <TabFace pane={pane} />
      </TooltipProvider>
    )
    const { container, rerender } = render(view())
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('svg.pane-kind')).not.toBeNull()
    active.theme = theme
    rerender(view())
    expect(container.querySelector('img')?.getAttribute('src')).toBe('data:image/svg+xml,ts')
  })
})
