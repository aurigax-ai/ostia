import type { JSX } from 'react'
import { ASK_COMMAND_ID } from '@/commands/askCommand'
import { type CommandWording, commands, commandWording } from '@/commands/registry'
import { CommandGroup, CommandItem } from '@/components/ui/command'
import { useDict } from '@/lib/app/useDict'
import { chordLabel, useBindings } from '@/lib/keyboard/chords'
import { symbolOf } from '@/lib/palette/paletteModes'
import { isMac } from '@/platform'
import { type ArgumentCommand, runFromPalette } from './ArgumentStep'
import { ItemRow } from './PaletteItemRow'
import { GROUP_CLASS } from './paletteClasses'

type RegisteredCommand = ReturnType<typeof commands.list>[number]

interface PaletteCommand {
  command: RegisteredCommand
  shown: CommandWording
}

function searchValue(symbol: string, command: RegisteredCommand, shown: CommandWording): string {
  const words = [shown.title, command.title, command.id, shown.category, command.category]
  return [symbol, ...new Set(words.filter(Boolean))].join(' ')
}

export function CommandItems({
  grouped,
  heading,
  onDone,
  onAsk,
  onAskAssistant,
}: {
  grouped: boolean
  heading?: string
  onDone: () => void
  onAsk: (command: ArgumentCommand) => void
  onAskAssistant: () => void
}): JSX.Element {
  const d = useDict()
  useBindings()
  const groups = new Map<string, { heading: string; items: PaletteCommand[] }>()
  for (const command of commands.list()) {
    if (command.hidden || command.listed?.() === false) continue
    const shown = commandWording(command, d)
    const key = command.category ?? ''
    const group = groups.get(key) ?? { heading: shown.category ?? d.palette.general, items: [] }
    group.items.push({ command, shown })
    groups.set(key, group)
  }
  const symbol = symbolOf('commands')
  const renderItem = ({ command: c, shown }: PaletteCommand): JSX.Element => {
    const keys = chordLabel(c.id, isMac)
    return (
      <CommandItem
        key={c.id}
        className={grouped || heading ? undefined : 'mx-1'}
        value={searchValue(symbol, c, shown)}
        onSelect={() => {
          if (c.id === ASK_COMMAND_ID) {
            onAskAssistant()
            return
          }
          if (shown.argument) {
            onAsk({
              id: c.id,
              title: shown.title,
              argument: shown.argument,
              choices: c.choices,
              emptyChoices: c.emptyChoices,
            })
            return
          }
          runFromPalette(c.id)
          onDone()
        }}
      >
        <ItemRow name={shown.title} meta={c.id} keys={keys} mono />
      </CommandItem>
    )
  }
  if (!grouped) {
    const items = [...groups.values()].flatMap((group) => group.items).map(renderItem)
    if (!heading) return <>{items}</>
    return (
      <CommandGroup heading={heading} className={GROUP_CLASS}>
        {items}
      </CommandGroup>
    )
  }
  return (
    <>
      {[...groups.entries()].map(([key, group]) => (
        <CommandGroup key={key} heading={group.heading} className={GROUP_CLASS}>
          {group.items.map(renderItem)}
        </CommandGroup>
      ))}
    </>
  )
}
