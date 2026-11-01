import { WarningIcon } from '@phosphor-icons/react'
import { type JSX, useEffect } from 'react'
import { PromptCard } from '@/components/common/PromptCard'
import { Button } from '@/components/ui/button'
import { fmt, useDict } from '@/lib/app/useDict'
import { useSandboxStore } from '@/stores/app/sandboxStore'
import { useUIStore } from '@/stores/app/uiStore'
import { useFileTreeStore } from '@/stores/files/fileTreeStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'

const SHOWN_PATHS = 4

export function SandboxLeftBehindNotice(): JSX.Element | null {
  const d = useDict()
  const activeId = useWorkspacesStore((s) => s.activeWorkspaceId)
  const notice = useSandboxStore((s) => (activeId ? s.leftBehind[activeId] : undefined))
  const dismiss = useSandboxStore((s) => s.dismissLeftBehind)
  useEffect(
    () =>
      window.ostia.sandbox.onLeftBehind((next) => useSandboxStore.getState().noteLeftBehind(next)),
    [],
  )
  if (!notice) return null
  const more = notice.paths.length - SHOWN_PATHS
  const files = [
    ...notice.paths.slice(0, SHOWN_PATHS),
    ...(more > 0 ? [fmt(d.sandbox.leftBehindMore, { count: String(more) })] : []),
  ].join(', ')
  return (
    <PromptCard
      icon={WarningIcon}
      tone="warn"
      label={d.sandbox.leftBehindLabel}
      title={d.sandbox.leftBehindTitle}
      dismissLabel={d.window.close}
      onDismiss={() => dismiss(notice.workspaceId)}
      actions={
        <Button
          size="sm"
          onClick={() => {
            useFileTreeStore
              .getState()
              .reveal(notice.workDir, `${notice.workDir}/${notice.paths[0]}`)
            useUIStore.getState().showFiles()
            dismiss(notice.workspaceId)
          }}
        >
          {d.sandbox.leftBehindShow}
        </Button>
      }
    >
      {fmt(d.sandbox.leftBehindBody, { files })}
    </PromptCard>
  )
}
