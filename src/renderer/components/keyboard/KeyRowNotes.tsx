import { type ChordSpec, chordText, isPaletteF1 } from '@shared/keyboard/chordSpec'
import { desktopTaking } from '@shared/keyboard/desktopChords'
import type { JSX } from 'react'
import { Notice } from '@/components/common/Notice'
import { currentDesktops } from '@/lib/app/desktop'
import { fmt, useDict } from '@/lib/app/useDict'
import type { KeySource } from '@/lib/keyboard/keySources'
import { isMac } from '@/platform'

export function SourceLabel({
  label,
  presetName,
}: {
  label: KeySource | null
  presetName: string | null
}): JSX.Element | null {
  const d = useDict()
  if (label === 'user') {
    return <span className="text-brand text-ui-xs">{d.keyboard.custom}</span>
  }
  if (label === 'preset' && presetName) {
    return <span className="text-fg-muted text-ui-xs">{presetName}</span>
  }
  return null
}

export function DesktopNote({ specs }: { specs: readonly ChordSpec[] }): JSX.Element | null {
  const d = useDict()
  const desktops = currentDesktops()
  const taken = specs.flatMap((spec) => {
    const desktop = desktopTaking(spec, desktops)
    return desktop ? [{ desktop, keys: chordText(spec, isMac) }] : []
  })
  if (taken.length === 0) return null
  return (
    <Notice>
      {fmt(d.keyboard.desktopTakes, {
        desktop: taken[0].desktop,
        keys: taken.map((t) => t.keys).join(' '),
      })}
    </Notice>
  )
}

export function TerminalLosesNote({
  id,
  specs,
}: {
  id: string
  specs: readonly ChordSpec[]
}): JSX.Element | null {
  const d = useDict()
  const lost = specs.filter((spec) => isPaletteF1(id, spec))
  if (lost.length === 0) return null
  return (
    <Notice>
      {fmt(d.keyboard.terminalLoses, {
        keys: lost.map((spec) => chordText(spec, isMac)).join(' '),
      })}
    </Notice>
  )
}

export function CustomBar({ on }: { on: boolean }): JSX.Element | null {
  if (!on) return null
  return (
    <span
      aria-hidden
      data-slot="custom-bar"
      className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-brand"
    />
  )
}
