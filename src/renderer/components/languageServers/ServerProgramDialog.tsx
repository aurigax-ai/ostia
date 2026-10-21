import type {
  LanguageServerInfo,
  LanguageServerOverrideProblem,
} from '@aurigax-ai/ostia-extension-sdk/contract/languageServers'
import { type FormEvent, useId, useState } from 'react'
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
import { fmt, useDict } from '@/lib/app/useDict'
import { useLanguageServersStore } from '@/stores/extensions/languageServersStore'

function programArguments(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

export function ServerProgramDialog({
  server,
  onClose,
}: {
  server: LanguageServerInfo
  onClose: () => void
}): JSX.Element {
  const d = useDict()
  const t = d.languageServers
  const setOverride = useLanguageServersStore((s) => s.setOverride)
  const [path, setPath] = useState(server.override?.path ?? '')
  const [args, setArgs] = useState((server.override?.args ?? []).join('\n'))
  const [problem, setProblem] = useState<LanguageServerOverrideProblem | null>(null)
  const pathId = useId()
  const argsId = useId()
  const problemId = useId()
  const apply = async (override: { path: string; args: string[] } | null): Promise<void> => {
    const refused = await setOverride(server.key, override)
    setProblem(refused)
    if (refused === null) onClose()
  }
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    void apply({ path: path.trim(), args: programArguments(args) })
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{fmt(t.programTitle, { name: server.name })}</DialogTitle>
          <DialogDescription>{t.programDesc}</DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={submit}>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={pathId}>{t.programPath}</Label>
            <Input
              id={pathId}
              className="font-mono"
              value={path}
              placeholder={t.programPathHint}
              spellCheck={false}
              aria-invalid={problem !== null}
              aria-describedby={problem !== null ? problemId : undefined}
              onChange={(event) => setPath(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={argsId}>{t.programArgs}</Label>
            <Textarea
              id={argsId}
              className="font-mono"
              rows={3}
              value={args}
              spellCheck={false}
              onChange={(event) => setArgs(event.target.value)}
            />
          </div>
          {problem !== null ? (
            <p id={problemId} role="alert" className="text-attn-fg text-ui-sm">
              {fmt(t.statusOverride, { reason: t.overrideReasons[problem] })}
            </p>
          ) : null}
          <DialogFooter>
            {server.override ? (
              <Button type="button" variant="outline" onClick={() => void apply(null)}>
                {t.programClear}
              </Button>
            ) : null}
            <Button type="button" variant="ghost" onClick={onClose}>
              {t.programCancel}
            </Button>
            <Button type="submit" disabled={path.trim() === ''}>
              {t.programSave}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
