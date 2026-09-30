import {
  type WorkflowArgument,
  type WorkflowEntry,
  commandParts,
  defaultValues,
  renderWorkflow,
  workflowArguments,
} from '@shared/workflows'
import { type FormEvent, useId, useState } from 'react'
import { useDict } from '../i18n/useDict'
import { canTypeInto } from '../lib/blockActions'
import { isIdlePrompt } from '../lib/blocks'
import { deliverCommand } from '../lib/workflows'
import { useBlocksStore } from '../stores/blocksStore'
import { useWorkflowsStore } from '../stores/workflowsStore'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from './ui/command'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog'
import { Input } from './ui/input'
import { Label } from './ui/label'

export function WorkflowCommand({
  command,
  values,
}: {
  command: string
  values?: Readonly<Record<string, string>>
}): JSX.Element {
  return (
    <span className="workflow-command">
      {commandParts(command).map((part, i) => {
        const key = `${i}`
        if ('text' in part) return <span key={key}>{part.text}</span>
        const value = values?.[part.arg]
        return (
          <span key={key} className="workflow-arg" data-arg={part.arg}>
            {value || `{{${part.arg}}}`}
          </span>
        )
      })}
    </span>
  )
}

export function WorkflowPicker(): JSX.Element {
  const d = useDict()
  const open = useWorkflowsStore((s) => s.pickerOpen)
  const listing = useWorkflowsStore((s) => s.listing)
  const chosen = useWorkflowsStore((s) => s.chosen)
  const targetPaneId = useWorkflowsStore((s) => s.targetPaneId)

  const pick = (workflow: WorkflowEntry): void => {
    const store = useWorkflowsStore.getState()
    if (workflowArguments(workflow).length > 0) {
      store.choose(workflow)
      return
    }
    store.closePicker()
    void deliverCommand(targetPaneId, renderWorkflow(workflow.command, {}))
  }

  return (
    <>
      <CommandDialog
        open={open && !chosen}
        onOpenChange={(o) => {
          if (!o) useWorkflowsStore.getState().closePicker()
        }}
        className="top-[12vh] sm:max-w-2xl"
        title={d.workflows.title}
        description={d.workflows.placeholder}
      >
        <CommandInput placeholder={d.workflows.placeholder} />
        <CommandList>
          <CommandEmpty>
            {listing.workflows.length === 0 ? d.workflows.none : d.workflows.empty}
          </CommandEmpty>
          {listing.workflows.map((w, i) => (
            <CommandItem
              key={`${w.source}:${w.origin}:${w.name}:${i}`}
              value={`${w.name} ${w.source}:${w.origin}:${i}`}
              keywords={[w.description ?? '', ...w.tags, w.command]}
              onSelect={() => pick(w)}
              className="workflow-row"
            >
              <span className="workflow-row-head">
                <span className="workflow-name">{w.name}</span>
                {w.tags.map((tag) => (
                  <Badge key={tag} variant="outline" className="text-ui-xs">
                    {tag}
                  </Badge>
                ))}
                <span className="workflow-source">
                  {d.workflows.sources[w.source]} · {w.origin}
                </span>
              </span>
              {w.description ? <span className="workflow-description">{w.description}</span> : null}
              <WorkflowCommand command={w.command} />
            </CommandItem>
          ))}
          {listing.problems.length > 0 ? (
            <CommandGroup heading={d.workflows.problems}>
              {listing.problems.map((p) => (
                <CommandItem
                  key={`${p.source}:${p.origin}`}
                  value={`${d.workflows.problems} ${p.origin}`}
                  disabled
                  className="workflow-row"
                >
                  <span className="workflow-name">{p.origin}</span>
                  <span className="workflow-description">{p.error}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}
        </CommandList>
      </CommandDialog>
      {chosen ? (
        <WorkflowForm
          key={`${chosen.source}:${chosen.origin}:${chosen.name}`}
          workflow={chosen}
          targetPaneId={targetPaneId}
        />
      ) : null}
    </>
  )
}

function WorkflowForm({
  workflow,
  targetPaneId,
}: {
  workflow: WorkflowEntry
  targetPaneId: string | null
}): JSX.Element {
  const d = useDict()
  const ids = useId()
  const [values, setValues] = useState(() => defaultValues(workflow))
  const args = workflowArguments(workflow)
  const idle = useBlocksStore((s) => (targetPaneId ? isIdlePrompt(s, targetPaneId) : false))
  const canInsert = idle && targetPaneId !== null && canTypeInto(targetPaneId)

  const back = (): void => useWorkflowsStore.getState().choose(null)

  const submit = (e: FormEvent): void => {
    e.preventDefault()
    useWorkflowsStore.getState().closePicker()
    void deliverCommand(targetPaneId, renderWorkflow(workflow.command, values))
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
            <DialogTitle>{workflow.name}</DialogTitle>
            <DialogDescription>{workflow.description ?? d.workflows.formDesc}</DialogDescription>
          </DialogHeader>
          <pre
            aria-label={d.workflows.preview}
            className="workflow-preview max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-sm border border-line bg-surface-1 p-2 font-mono text-fg text-ui-sm"
          >
            <WorkflowCommand command={workflow.command} values={values} />
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
          {canInsert ? null : <p className="text-fg-muted text-ui-xs">{d.workflows.copyHint}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={back}>
              {d.workflows.cancel}
            </Button>
            <Button type="submit" size="sm">
              {canInsert ? d.workflows.insert : d.workflows.copy}
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
  arg: WorkflowArgument
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
