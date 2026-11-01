import type { JSX } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { fmt, useDict } from '@/lib/app/useDict'
import { useTabSleepNoticeStore } from '@/stores/workspaces/tabSleepNoticeStore'

export function TabSleepNoticeDialog(): JSX.Element {
  const d = useDict()
  const notice = useTabSleepNoticeStore((s) => s.notice)
  const dismiss = useTabSleepNoticeStore((s) => s.dismiss)
  const text = notice
    ? notice.kind === 'conflict'
      ? fmt(d.tabSleepNotice.conflict, { tab: notice.tab })
      : notice.kind === 'forkFolderMissing'
        ? fmt(d.tabSleepNotice.forkFolderMissing, { agent: notice.agent, path: notice.path })
        : d.tabSleepNotice[notice.kind]
    : ''

  return (
    <AlertDialog
      open={notice !== null}
      onOpenChange={(open) => {
        if (!open) dismiss()
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{d.tabSleepNotice.title}</AlertDialogTitle>
          <AlertDialogDescription>{text}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogAction size="sm" onClick={dismiss}>
            {d.tabSleepNotice.ok}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
