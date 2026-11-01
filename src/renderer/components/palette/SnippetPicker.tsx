import {
  commandParts,
  defaultValues,
  renderSnippet,
  type SnippetArgument,
  type SnippetEntry,
  snippetArguments,
} from '@aurigax-ai/ostia-extension-sdk/contract/snippets'
import { type FormEvent, type JSX, useId, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useDict } from '@/lib/app/useDict'
import { deliverCommand } from '@/lib/palette/snippets'
import { canTypeInto } from '@/lib/terminal/blockActions'
import { isIdlePrompt } from '@/lib/terminal/blocks'
import { useBlocksStore } from '@/stores/terminal/blocksStore'
import { useSnippetsStore } from '@/stores/terminal/snippetsStore'

export function SnippetCommand({
  command,
  values,
}: {
  command: string
  values?: Readonly<Record<string, string>>
}): JSX.Element {
  return (
    <span className="snippet-command">
      {commandParts(command).map((part, i) => {
        const key = `${i}`
        if ('text' in part) return <span key={key}>{part.text}</span>
        const value = values?.[part.arg]
        return (
          <span key={key} className="snippet-arg" data-arg={part.arg}>
            {value || `{{${part.arg}}}`}
          </span>
        )
      })}
    </span>
  )
}

export function SnippetPicker(): JSX.Element {
  const d = useDict()
  const open = useSnippetsStore((s) => s.pickerOpen)
  const listing = useSnippetsStore((s) => s.listing)
  const chosen = useSnippetsStore((s) => s.chosen)
  const targetPaneId = useSnippetsStore((s) => s.targetPaneId)

  const pick = (snippet: SnippetEntry): void => {
    const store = useSnippetsStore.getState()
    if (snippetArguments(snippet).length > 0) {
      store.choose(snippet)
      return
    }
    store.closePicker()
    void deliverCommand(targetPaneId, renderSnippet(snippet.command, {}))
  }

  return (
    <>
      <CommandDialog
        open={open && !chosen}
        onOpenChange={(o) => {
          if (!o) useSnippetsStore.getState().closePicker()
        }}
        className="top-[12vh] sm:max-w-2xl"
        title={d.snippets.title}
        description={d.snippets.placeholder}
      >
        <CommandInput placeholder={d.snippets.placeholder} />
        <CommandList>
          <CommandEmpty>
            {listing.snippets.length === 0 ? d.snippets.none : d.snippets.empty}
          </CommandEmpty>
          {listing.snippets.map((w, i) => (
            <CommandItem
              // biome-ignore lint/suspicious/noArrayIndexKey: the index tells repeated entries apart and the list is rebuilt, never reordered
              key={`${w.source}:${w.origin}:${w.name}:${i}`}
              value={`${w.name} ${w.source}:${w.origin}:${i}`}
              keywords={[w.description ?? '', ...w.tags, w.command]}
              onSelect={() => pick(w)}
              className="snippet-row"
            >
              <span className="snippet-row-head">
                <span className="snippet-name">{w.name}</span>
                {w.tags.map((tag) => (
                  <Badge key={tag} variant="outline" className="text-ui-xs">
                    {tag}
                  </Badge>
                ))}
                <span className="snippet-source">
                  {d.snippets.sources[w.source]} · {w.origin}
                </span>
              </span>
              {w.description ? <span className="snippet-description">{w.description}</span> : null}
              <SnippetCommand command={w.command} />
            </CommandItem>
          ))}
          {listing.problems.length > 0 ? (
            <CommandGroup heading={d.snippets.problems}>
              {listing.problems.map((p) => (
                <CommandItem
                  key={`${p.source}:${p.origin}`}
                  value={`${d.snippets.problems} ${p.origin}`}
                  disabled
                  className="snippet-row"
                >
                  <span className="snippet-name">{p.origin}</span>
                  <span className="snippet-description">{p.error}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}
        </CommandList>
      </CommandDialog>
      {chosen ? (
        <SnippetForm
          key={`${chosen.source}:${chosen.origin}:${chosen.name}`}
          snippet={chosen}
          targetPaneId={targetPaneId}
        />
      ) : null}
    </>
  )
}

function SnippetForm({
  snippet,
  targetPaneId,
}: {
  snippet: SnippetEntry
  targetPaneId: string | null
}): JSX.Element {
  const d = useDict()
  const ids = useId()
  const [values, setValues] = useState(() => defaultValues(snippet))
  const args = snippetArguments(snippet)
  const idle = useBlocksStore((s) => (targetPaneId ? isIdlePrompt(s, targetPaneId) : false))
  const canInsert = idle && targetPaneId !== null && canTypeInto(targetPaneId)

  const back = (): void => useSnippetsStore.getState().choose(null)

  const submit = (e: FormEvent): void => {
    e.preventDefault()
    useSnippetsStore.getState().closePicker()
    void deliverCommand(targetPaneId, renderSnippet(snippet.command, values))
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) back()
      }}
    >
      <DialogContent showCloseButton={false} className="sm:max-w-xl">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{snippet.name}</DialogTitle>
            <DialogDescription>{snippet.description ?? d.snippets.formDesc}</DialogDescription>
          </DialogHeader>
          {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: the label names the block for screen readers and tests; a role would change how it is announced */}
          <pre
            aria-label={d.snippets.preview}
            className="snippet-preview max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-sm border border-line bg-surface-1 p-2 font-mono text-fg text-ui-sm"
          >
            <SnippetCommand command={snippet.command} values={values} />
          </pre>
          <div className="grid gap-3">
            {args.map((arg, i) => (
              <ArgumentField
                key={arg.name}
                id={`${ids}-${arg.name}`}
                arg={arg}
                value={values[arg.name] ?? ''}
                autoFocus={i === 0}
                onChange={(value) => setValues((v) => ({ ...v, [arg.name]: value }))}
              />
            ))}
          </div>
          {canInsert ? null : <p className="text-fg-muted text-ui-xs">{d.snippets.copyHint}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={back}>
              {d.snippets.cancel}
            </Button>
            <Button type="submit" size="sm">
              {canInsert ? d.snippets.insert : d.snippets.copy}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function ArgumentField({
  id,
  arg,
  value,
  autoFocus,
  onChange,
}: {
  id: string
  arg: SnippetArgument
  value: string
  autoFocus: boolean
  onChange: (value: string) => void
}): JSX.Element {
  return (
    <div className="grid gap-1">
      <Label htmlFor={id} className="font-mono text-ui-sm">
        {arg.name}
      </Label>
      <Input
        id={id}
        value={value}
        autoFocus={autoFocus}
        spellCheck={false}
        autoComplete="off"
        className="font-mono"
        onChange={(e) => onChange(e.target.value)}
      />
      {arg.description ? <span className="text-fg-muted text-ui-xs">{arg.description}</span> : null}
    </div>
  )
}
