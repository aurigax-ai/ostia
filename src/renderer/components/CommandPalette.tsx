import { useMemo } from 'react'
import { commands } from '../commands/registry'
import { useDict } from '../i18n/useDict'
import { useUIStore } from '../stores/uiStore'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from './ui/command'

export function CommandPalette(): JSX.Element {
  const d = useDict()
  const open = useUIStore((s) => s.paletteOpen)
  const close = useUIStore((s) => s.closePalette)

  const groups = useMemo(() => {
    const byCat = new Map<string, ReturnType<typeof commands.list>>()
    for (const c of commands.list()) {
      if (c.hidden) continue
      const cat = c.category ?? 'General'
      const arr = byCat.get(cat) ?? []
      arr.push(c)
      byCat.set(cat, arr)
    }
    return [...byCat.entries()]
  }, [])

  const run = (id: string): void => {
    void commands.exec(id)
    close()
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={(o) => {
        if (!o) close()
      }}
      title={d.palette.title}
      description={d.palette.placeholder}
    >
      <CommandInput placeholder={d.palette.placeholder} />
      <CommandList>
        <CommandEmpty>{d.palette.empty}</CommandEmpty>
        {groups.map(([category, items]) => (
          <CommandGroup key={category} heading={category}>
            {items.map((c) => (
              <CommandItem
                key={c.id}
                value={`${c.title} ${c.id} ${c.category ?? ''}`}
                onSelect={() => run(c.id)}
              >
                <span>{c.title}</span>
                <CommandShortcut>{c.id}</CommandShortcut>
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
      </CommandList>
    </CommandDialog>
  )
}
