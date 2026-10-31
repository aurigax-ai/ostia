import { isRemotePath } from '@aurigax-ai/ostia-extension-sdk/contract/remoteFolders'
import type { Dict } from '@shared/app/dict'
import {
  type PortableAction,
  type PortableResult,
  portableType,
  runsScripts,
} from '@shared/artifacts/portable'
import type { PublishOptions } from '@shared/artifacts/shares'
import { useEffect } from 'react'
import { MenuItem } from '@/components/common/Menu'
import { SplitButton, SplitButtonMenu } from '@/components/common/SplitButton'
import { PublishDialog } from '@/components/shares/PublishDialog'
import { PublishMenuItems } from '@/components/shares/PublishMenuItems'
import { type Publishing, usePublishing } from '@/components/shares/usePublishing'
import { Button } from '@/components/ui/button'
import { fmt, useDict } from '@/lib/app/useDict'
import { type CaptureChipTone, showCaptureChip } from '@/lib/capture/captureSession'
import { useArtifactListing } from '@/lib/files/artifacts'
import { chipPaneFor, showInViewer } from '@/lib/files/portableViewer'
import { viewerOptions } from '@/lib/files/viewerChoice'
import { previewTheme } from '@/lib/theme/previewTheme'
import { useSandboxStore } from '@/stores/app/sandboxStore'
import { useExtensionsStore } from '@/stores/extensions/extensionsStore'
import { portableDocument } from './portableDocuments'

function problemOf(d: Dict, result: PortableResult): string | null {
  if (result.ok || result.reason === 'cancelled') return null
  if (result.reason === 'not-built')
    return fmt(d.portable.notBuilt, { message: result.message ?? '' })
  if (result.reason === 'too-large') return d.portable.tooLarge
  if (result.reason === 'no-tables') return d.portable.noTables
  if (result.reason === 'sandboxed') return d.portable.sandboxed
  return fmt(d.portable.failed, { message: result.message ?? result.reason })
}

function doneText(d: Dict, action: PortableAction): string | null {
  if (action === 'open') return d.portable.openedInBrowser
  if (action === 'save') return d.portable.saved
  if (action === 'copy') return d.portable.copiedHtml
  return null
}

function canTakeOut(
  filePath: string,
  viewed: boolean,
  sandboxed: boolean,
  artifactDir: string | null,
): boolean {
  const type = portableType(filePath) ?? (viewed ? 'tables' : null)
  if (type === null || isRemotePath(filePath) || !artifactDir) return false
  if (!filePath.startsWith(`${artifactDir}/`)) return false
  return !(runsScripts(type) && sandboxed)
}

export function usePortableFile(workspaceId: string, filePath: string, paneId?: string) {
  const d = useDict()
  const sandboxed = useSandboxStore((s) => s.enabled[workspaceId] ?? false)
  const artifactDir = useArtifactListing(workspaceId)?.dir ?? null
  const viewed = useExtensionsStore((s) => viewerOptions(filePath, s.list).length > 0)

  useEffect(() => {
    void useSandboxStore.getState().load(workspaceId)
  }, [workspaceId])

  const say = (text: string, tone: CaptureChipTone): void => {
    const pane = chipPaneFor(workspaceId, filePath, paneId)
    if (pane) showCaptureChip(pane, text, tone)
  }

  const run = async (
    action: PortableAction,
    publish?: PublishOptions,
  ): Promise<PortableResult | null> => {
    const theme = previewTheme()
    const type = portableType(filePath)
    let document: Awaited<ReturnType<typeof portableDocument>>
    if (type === 'markdown') {
      const read = await window.ostia.fs.read(filePath)
      if (!read.ok) {
        say(fmt(d.portable.failed, { message: read.error }), 'warn')
        return null
      }
      document = await portableDocument(filePath, read.text, theme.dark)
    }
    const ask = (awaitTables: boolean) =>
      window.ostia.artifacts.portable(action, {
        workspaceId,
        path: filePath,
        theme,
        ...(document ? { document } : {}),
        ...(publish ? { publish } : {}),
        ...(awaitTables ? { awaitTables } : {}),
      })
    let result = await ask(false)
    if (!result.ok && result.reason === 'no-tables' && showInViewer(workspaceId, filePath)) {
      result = await ask(true)
    }
    if (action !== 'publish') {
      const problem = problemOf(d, result)
      if (problem) say(problem, 'warn')
      else if (result.ok) {
        const done = doneText(d, action)
        if (done) say(done, 'ok')
      }
    }
    return result
  }

  return { shown: canTakeOut(filePath, viewed, sandboxed, artifactDir), run, say }
}

export function PortableActions({
  workspaceId,
  filePath,
  paneId,
}: {
  workspaceId: string
  filePath: string
  paneId: string
}): JSX.Element | null {
  const d = useDict()
  const { shown, run, say } = usePortableFile(workspaceId, filePath, paneId)
  const publishing = usePublishing(filePath, run, say)
  if (!shown) return null
  return (
    <span className="portable-actions">
      <SplitButton
        label={d.portable.group}
        variant="outline"
        main={
          <Button variant="outline" size="xs" onClick={() => void run('open')}>
            {d.portable.open}
          </Button>
        }
      >
        <SplitButtonMenu label={d.portable.more} size="xs" variant="outline">
          <MenuItem onClick={() => void run('save')}>{d.portable.save}</MenuItem>
          <MenuItem onClick={() => void run('copy')}>{d.portable.copy}</MenuItem>
          <PublishMenuItems publishing={publishing} />
        </SplitButtonMenu>
      </SplitButton>
      <PublishDialog publishing={publishing} />
    </span>
  )
}

export function PortableMenuItems({
  run,
  publishing,
}: {
  run: (action: PortableAction) => Promise<PortableResult | null>
  publishing: Publishing
}): JSX.Element {
  const d = useDict()
  return (
    <>
      <MenuItem onClick={() => void run('open')}>{d.portable.open}</MenuItem>
      <MenuItem onClick={() => void run('save')}>{d.portable.save}</MenuItem>
      <MenuItem onClick={() => void run('copy')}>{d.portable.copy}</MenuItem>
      <PublishMenuItems publishing={publishing} />
    </>
  )
}
