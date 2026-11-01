import { type JSX, useEffect, useState } from 'react'
import { type CommandChoice, commands } from '@/commands/registry'
import { CommandEmpty, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { countUsage } from '@/lib/app/usageCounts'
import { fmt, useDict } from '@/lib/app/useDict'
import { ItemRow } from './PaletteItemRow'
import { LIST_CLASS } from './paletteClasses'

export function runFromPalette(id: string, args?: { argument: string }): void {
  countUsage('features', 'command', id)
  void commands.exec(id, args)
}

export interface ArgumentCommand {
  id: string
  title: string
  argument: string
  choices?: () => Promise<CommandChoice[]>
  emptyChoices?: () => string
}

export function ArgumentStep({
  command,
  value,
  onValueChange,
  onDone,
}: {
  command: ArgumentCommand
  value: string
  onValueChange: (value: string) => void
  onDone: () => void
}): JSX.Element {
  const d = useDict()
  const argument = value.trim()
  const run = (): void => {
    if (!argument) return
    runFromPalette(command.id, { argument })
    onDone()
  }
  if (command.choices) {
    return (
      <ChoiceStep
        command={command}
        choices={command.choices}
        value={value}
        onValueChange={onValueChange}
        onDone={onDone}
      />
    )
  }
  return (
    <>
      <CommandInput
        autoFocus
        placeholder={command.argument}
        value={value}
        onValueChange={onValueChange}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return
          e.preventDefault()
          run()
        }}
      />
      <CommandList className={LIST_CLASS}>
        <CommandEmpty>
          {argument
            ? fmt(d.palette.runWith, { title: command.title, value: argument })
            : d.palette.argumentEmpty}
        </CommandEmpty>
      </CommandList>
    </>
  )
}

function ChoiceStep({
  command,
  choices: loadChoices,
  value,
  onValueChange,
  onDone,
}: {
  command: ArgumentCommand
  choices: () => Promise<CommandChoice[]>
  value: string
  onValueChange: (value: string) => void
  onDone: () => void
}): JSX.Element {
  const [choices, setChoices] = useState<CommandChoice[] | null>(null)
  useEffect(() => {
    let live = true
    void loadChoices().then((next) => {
      if (live) setChoices(next)
    })
    return () => {
      live = false
    }
  }, [loadChoices])
  return (
    <>
      <CommandInput
        autoFocus
        placeholder={command.argument}
        value={value}
        onValueChange={onValueChange}
      />
      <CommandList className={LIST_CLASS}>
        {choices !== null && choices.length === 0 ? (
          <CommandEmpty>{command.emptyChoices?.() ?? command.argument}</CommandEmpty>
        ) : null}
        {choices?.map((choice) => (
          <CommandItem
            key={choice.value}
            value={`${choice.label} ${choice.value}`}
            disabled={choice.disabledReason !== undefined}
            onSelect={() => {
              runFromPalette(command.id, { argument: choice.value })
              onDone()
            }}
          >
            <ItemRow name={choice.label} meta={choice.disabledReason} />
          </CommandItem>
        ))}
      </CommandList>
    </>
  )
}
