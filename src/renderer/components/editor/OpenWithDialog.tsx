import { OWN_VIEW } from '@aurigax-ai/ostia-extension-sdk/contract/fileKinds'
import { useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { fmt, useDict } from '@/lib/app/useDict'
import { associationPattern, type ViewerOption } from '@/lib/files/viewerChoice'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useOpenWithStore } from '@/stores/files/openWithStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'

interface OpenWithBodyProps {
  workspaceId: string
  paneId: string
  filePath: string
  options: readonly ViewerOption[]
  current: string
  ownLabel: string
}

function OpenWithBody({
  workspaceId,
  paneId,
  filePath,
  options,
  current,
  ownLabel,
}: OpenWithBodyProps): JSX.Element {
  const d = useDict()
  const ids = useId()
  const close = useOpenWithStore((s) => s.close)
  const setViewType = useLayoutStore((s) => s.setViewType)
  const files = useSettingsStore((s) => s.files)
  const setFiles = useSettingsStore((s) => s.setFiles)
  const [picked, setPicked] = useState(current)
  const [always, setAlways] = useState(false)
  const pattern = associationPattern(filePath)
  const choices = [
    { viewType: OWN_VIEW, label: ownLabel, detail: null as string | null },
    ...options.map((option) => ({
      viewType: option.viewType,
      label: option.displayName,
      detail: option.viewType,
    })),
  ]

  const confirm = (): void => {
    setViewType(workspaceId, paneId, picked)
    if (always) {
      setFiles({ viewerAssociations: { ...files.viewerAssociations, [pattern]: picked } })
    }
    close()
  }

  return (
    <DialogContent showCloseButton={false} className="w-[min(90vw,28rem)] max-w-none sm:max-w-none">
      <DialogHeader>
        <DialogTitle>{d.viewer.openWith}</DialogTitle>
        <DialogDescription>{filePath.slice(filePath.lastIndexOf('/') + 1)}</DialogDescription>
      </DialogHeader>
      <RadioGroup
        aria-label={d.viewer.openWith}
        value={picked}
        onValueChange={(value) => setPicked(value as string)}
        className="flex flex-col gap-0"
      >
        {choices.map((choice) => (
          <label
            key={choice.viewType}
            htmlFor={`${ids}-${choice.viewType}`}
            className={`flex items-center gap-2 rounded-sm px-2 py-1 text-ui-sm hover:bg-surface-2${choice.viewType === picked ? ' bg-surface-2' : ''}`}
          >
            <RadioGroupItem id={`${ids}-${choice.viewType}`} value={choice.viewType} />
            <span className="min-w-0 flex-1 truncate">{choice.label}</span>
            {choice.detail ? (
              <span className="truncate font-mono text-fg-muted text-ui-xs">{choice.detail}</span>
            ) : null}
          </label>
        ))}
      </RadioGroup>
      <label htmlFor={`${ids}-always`} className="flex items-center gap-2 text-ui-sm">
        <Checkbox
          id={`${ids}-always`}
          checked={always}
          onCheckedChange={(value) => setAlways(value === true)}
        />
        {fmt(d.viewer.alwaysUse, { pattern })}
      </label>
      <DialogFooter>
        <Button variant="outline" size="sm" onClick={close}>
          {d.viewer.cancel}
        </Button>
        <Button size="sm" onClick={confirm}>
          {d.viewer.open}
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}

export function OpenWithDialog(props: OpenWithBodyProps): JSX.Element {
  const open = useOpenWithStore((s) => s.paneId === props.paneId)
  const close = useOpenWithStore((s) => s.close)
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close()
      }}
    >
      {open ? <OpenWithBody {...props} /> : null}
    </Dialog>
  )
}
