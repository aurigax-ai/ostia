import { isRemotePath } from '@aurigax-ai/ostia-extension-sdk/contract/remoteFolders'
import { WarningIcon } from '@phosphor-icons/react'
import type { Dict } from '@shared/app/dict'
import {
  type PortableAction,
  type PortableResult,
  portableType,
  runsScripts,
} from '@shared/artifacts/portable'
import type { PublishOptions } from '@shared/artifacts/shares'
import { type JSX, useEffect, useState } from 'react'
import { MenuItem } from '@/components/common/Menu'
import { SplitButton, SplitButtonMenu } from '@/components/common/SplitButton'
import { PublishDialog } from '@/components/shares/PublishDialog'
import { PublishMenuItems } from '@/components/shares/PublishMenuItems'
import { type Publishing, usePublishing } from '@/components/shares/usePublishing'
import { Button } from '@/components/ui/button'
import { useCopied } from '@/lib/app/useCopied'
import { fmt, useDict } from '@/lib/app/useDict'
import { useArtifactListing } from '@/lib/files/artifacts'
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
  if (result.reason === 'no-tables') return d.portable.openFirst
  if (result.reason === 'sandboxed') return d.portable.sandboxed
  return fmt(d.portable.failed, { message: result.message ?? result.reason })
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

export function usePortableFile(workspaceId: string, filePath: string) {
  const d = useDict()
  const sandboxed = useSandboxStore((s) => s.enabled[workspaceId] ?? false)
  const artifactDir = useArtifactListing(workspaceId)?.dir ?? null
  const viewed = useExtensionsStore((s) => viewerOptions(filePath, s.list).length > 0)
  const [problem, setProblem] = useState<string | null>(null)
  const [copied, markCopied] = useCopied()

  useEffect(() => {
    void useSandboxStore.getState().load(workspaceId)
  }, [workspaceId])

  const run = async (
    action: PortableAction,
    publish?: PublishOptions,
  ): Promise<PortableResult | null> => {
    setProblem(null)
    const theme = previewTheme()
    const type = portableType(filePath)
    let document: Awaited<ReturnType<typeof portableDocument>>
    if (type === 'markdown') {
      const read = await window.ostia.fs.read(filePath)
      if (!read.ok) {
        setProblem(fmt(d.portable.failed, { message: read.error }))
        return null
      }
      document = await portableDocument(filePath, read.text, theme.dark)
    }
    const result = await window.ostia.artifacts.portable(action, {
      workspaceId,
      path: filePath,
      theme,
      ...(document ? { document } : {}),
      ...(publish ? { publish } : {}),
    })
    if (action !== 'publish') setProblem(problemOf(d, result))
    if (result.ok && action === 'copy') markCopied()
    return result
  }

  return { shown: canTakeOut(filePath, viewed, sandboxed, artifactDir), run, problem, copied }
}

export function PortableProblem({ problem }: { problem: string | null }): JSX.Element | null {
  if (!problem) return null
  return (
    <span
      role="alert"
      data-testid="portable-problem"
      className="portable-problem text-warn-fg text-ui-xs"
    >
      <WarningIcon size={16} aria-hidden />
      <span className="truncate">{problem}</span>
    </span>
  )
}

export function PortableActions({
  workspaceId,
  filePath,
}: {
  workspaceId: string
  filePath: string
}): JSX.Element | null {
  const d = useDict()
  const { shown, run, problem, copied } = usePortableFile(workspaceId, filePath)
  const publishing = usePublishing(filePath, run)
  if (!shown) return null
  return (
    <span className="portable-actions">
      <PortableProblem problem={problem ?? publishing.problem} />
      <SplitButton
        label={d.portable.group}
        variant="outline"
        main={
          <Button variant="outline" size="xs" onClick={() => void run('open')}>
            {copied ? d.portable.copied : d.portable.open}
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
