import { Button } from '@/components/ui/button'
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
import { Textarea } from '@/components/ui/textarea'
import { useDict } from '@/i18n/useDict'
import { parseTags, suggestedName } from '@/lib/palette/workflows'
import { useWorkflowsStore } from '@/stores/terminal/workflowsStore'
import { fmt } from '@shared/app/dict'
import { placeholderNames, workflowDocument } from '@shared/workflows'
import { type FormEvent, useId, useState } from 'react'
import { WorkflowCommand } from './WorkflowPicker'

interface ArgumentDraft {
  defaultValue: string
  description: string
}

export function SaveWorkflowDialog(): JSX.Element | null {
  const command = useWorkflowsStore((s) => s.saveCommand)
  if (command === null) return null
  return <SaveWorkflowForm key={command} initialCommand={command} />
}

function SaveWorkflowForm({ initialCommand }: { initialCommand: string }): JSX.Element {
  const d = useDict()
  const ids = useId()
  const [name, setName] = useState(() => suggestedName(initialCommand))
  const [description, setDescription] = useState('')
  const [tags, setTags] = useState('')
  const [command, setCommand] = useState(initialCommand)
  const [argDrafts, setArgDrafts] = useState<Record<string, ArgumentDraft>>({})
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const names = placeholderNames(command)

  const close = (): void => useWorkflowsStore.getState().startSave(null)

  const editArg = (arg: string, patch: Partial<ArgumentDraft>): void =>
    setArgDrafts((all) => ({
      ...all,
      [arg]: { ...(all[arg] ?? { defaultValue: '', description: '' }), ...patch },
    }))

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    setSaving(true)
    const doc = workflowDocument({
      name: name.trim(),
      command,
      description: description.trim() || undefined,
      tags: parseTags(tags),
      arguments: names.map((arg) => {
        const draft = argDrafts[arg]
        return {
          name: arg,
          description: draft?.description.trim() || undefined,
          defaultValue: draft?.defaultValue || undefined,
        }
      }),
    })
    const res = await window.ostia.workflows.save(doc)
    setSaving(false)
    if (res.ok) close()
    else setError(res.error)
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) close()
      }}
    >
      <DialogContent showCloseButton={false} className="sm:max-w-xl">
        <form onSubmit={(e) => void submit(e)} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{d.workflows.saveTitle}</DialogTitle>
            <DialogDescription>{d.workflows.saveDesc}</DialogDescription>
          </DialogHeader>
          <Field id={`${ids}-name`} label={d.workflows.name}>
            <Input
              id={`${ids}-name`}
              value={name}
              required
              autoFocus
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field id={`${ids}-command`} label={d.workflows.command}>
            <Textarea
              id={`${ids}-command`}
              value={command}
              required
              spellCheck={false}
              className="max-h-40 font-mono"
              onChange={(e) => setCommand(e.target.value)}
            />
          </Field>
          <Field id={`${ids}-description`} label={d.workflows.description}>
            <Input
              id={`${ids}-description`}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
          <Field id={`${ids}-tags`} label={d.workflows.tags}>
            <Input
              id={`${ids}-tags`}
              value={tags}
              placeholder={d.workflows.tagsHint}
              onChange={(e) => setTags(e.target.value)}
            />
          </Field>
          <section className="grid gap-2" aria-label={d.workflows.arguments}>
            <span className="font-medium text-fg text-ui-sm">{d.workflows.arguments}</span>
            {names.length === 0 ? (
              <span className="text-fg-muted text-ui-xs">{d.workflows.noArguments}</span>
            ) : (
              <>
                <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-all rounded-sm border border-line bg-surface-1 p-2 font-mono text-fg text-ui-sm">
                  <WorkflowCommand command={command} />
                </pre>
                {names.map((arg) => (
                  <div
                    key={arg}
                    className="grid grid-cols-[minmax(0,8rem)_1fr_1fr] items-center gap-2"
                  >
                    <span className="truncate font-mono text-fg text-ui-sm">{arg}</span>
                    <Input
                      aria-label={fmt(d.workflows.defaultValueFor, { name: arg })}
                      placeholder={d.workflows.defaultValue}
                      value={argDrafts[arg]?.defaultValue ?? ''}
                      className="font-mono"
                      onChange={(e) => editArg(arg, { defaultValue: e.target.value })}
                    />
                    <Input
                      aria-label={fmt(d.workflows.argumentDescription, { name: arg })}
                      placeholder={d.workflows.description}
                      value={argDrafts[arg]?.description ?? ''}
                      onChange={(e) => editArg(arg, { description: e.target.value })}
                    />
                  </div>
                ))}
              </>
            )}
          </section>
          {error ? (
            <p role="alert" className="text-attn-fg text-ui-xs">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={close}>
              {d.workflows.cancel}
            </Button>
            <Button type="submit" size="sm" disabled={saving || !name.trim() || !command.trim()}>
              {d.workflows.save}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function Field({
  id,
  label,
  children,
}: {
  id: string
  label: string
  children: JSX.Element
}): JSX.Element {
  return (
    <div className="grid gap-1">
      <Label htmlFor={id} className="text-ui-sm">
        {label}
      </Label>
      {children}
    </div>
  )
}
