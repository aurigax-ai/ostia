import {
  ArrowSquareOutIcon,
  FileDashedIcon,
  FolderOpenIcon,
  WarningCircleIcon,
} from '@phosphor-icons/react'
import { useEffect, useState } from 'react'
import { EmptyState } from '@/components/common/EmptyState'
import { Button } from '@/components/ui/button'
import { useDict } from '@/lib/app/useDict'
import { revealFile } from '@/lib/files/revealFolder'

export function NoPreview({
  workspaceId,
  filePath,
}: {
  workspaceId: string
  filePath: string
}): JSX.Element {
  const d = useDict()
  const [openable, setOpenable] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let alive = true
    setOpenable(false)
    setFailed(false)
    void window.ostia.openPath.canOpenDefault(filePath).then((can) => {
      if (alive) setOpenable(can)
    })
    return () => {
      alive = false
    }
  }, [filePath])

  const openDefault = (): void => {
    void window.ostia.openPath.openDefault(filePath).then((res) => setFailed(!res.ok))
  }

  return (
    <EmptyState
      variant="surface"
      size="sm"
      className="absolute inset-0"
      data-testid="no-preview"
      icon={<FileDashedIcon aria-hidden />}
      title={d.editor.noPreview}
      actionsClassName="flex-row flex-wrap justify-center"
      actions={
        <>
          {openable ? (
            <Button size="sm" onClick={openDefault}>
              <ArrowSquareOutIcon data-icon="inline-start" />
              {d.fileMenu.openDefault}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant={openable ? 'outline' : 'default'}
            onClick={() => revealFile(workspaceId, filePath)}
          >
            <FolderOpenIcon data-icon="inline-start" />
            {d.editor.showInFiles}
          </Button>
        </>
      }
    >
      {failed ? (
        <p role="alert" className="flex items-center gap-1.5 text-attn-fg text-ui-sm">
          <WarningCircleIcon size={16} aria-hidden />
          {d.editor.openFailed}
        </p>
      ) : null}
    </EmptyState>
  )
}
