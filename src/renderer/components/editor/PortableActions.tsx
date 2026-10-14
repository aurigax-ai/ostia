import { MenuItem } from '@/components/common/Menu'
import { SplitButton, SplitButtonMenu } from '@/components/common/SplitButton'
import { Button } from '@/components/ui/button'
import { fmt, useDict } from '@/i18n/useDict'
import { useArtifactListing } from '@/lib/files/artifacts'
import { previewTheme } from '@/lib/theme/previewTheme'
import { useSandboxStore } from '@/stores/app/sandboxStore'
import { WarningIcon } from '@phosphor-icons/react'
import type { Dict } from '@shared/app/dict'
import {
  type PortableAction,
  type PortableResult,
  portableType,
  runsScripts,
} from '@shared/artifacts/portable'
import { isRemotePath } from '@shared/remoteFolders'
import { useEffect, useRef, useState } from 'react'
import { portableDocument } from './portableDocuments'

const COPIED_MS = 2_000

function problemOf(d: Dict, result: PortableResult): string | null {
  if (result.ok || result.reason === 'cancelled') return null
  if (result.reason === 'not-built')
    return fmt(d.portable.notBuilt, { message: result.message ?? '' })
  if (result.reason === 'too-large') return d.portable.tooLarge
  if (result.reason === 'sandboxed') return d.portable.sandboxed
  return fmt(d.portable.failed, { message: result.message ?? result.reason })
}

function canTakeOut(filePath: string, sandboxed: boolean, artifactDir: string | null): boolean {
  const type = portableType(filePath)
  if (type === null || isRemotePath(filePath) || !artifactDir) return false
  if (!filePath.startsWith(`${artifactDir}/`)) return false
  return !(runsScripts(type) && sandboxed)
}

export function usePortableFile(workspaceId: string, filePath: string) {
  const d = useDict()
  const sandboxed = useSandboxStore((s) => s.enabled[workspaceId] ?? false)
  const artifactDir = useArtifactListing(workspaceId)?.dir ?? null
  const [problem, setProblem] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    void useSandboxStore.getState().load(workspaceId)
  }, [workspaceId])

  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current)
    },
    [],
  )

  const run = async (action: PortableAction): Promise<void> => {
    setProblem(null)
    const theme = previewTheme()
    const type = portableType(filePath)
    let document: Awaited<ReturnType<typeof portableDocument>>
    if (type === 'markdown' || type === 'csv') {
      const read = await window.ostia.fs.read(filePath)
      if (!read.ok) {
        setProblem(fmt(d.portable.failed, { message: read.error }))
        return
      }
      document = await portableDocument(filePath, read.text, theme.dark)
    }
    const result = await window.ostia.artifacts.portable(action, {
      workspaceId,
      path: filePath,
      theme,
      ...(document ? { document } : {}),
    })
    setProblem(problemOf(d, result))
    if (result.ok && action === 'copy') {
      setCopied(true)
      if (copiedTimer.current) clearTimeout(copiedTimer.current)
      copiedTimer.current = setTimeout(() => setCopied(false), COPIED_MS)
    }
  }

  return { shown: canTakeOut(filePath, sandboxed, artifactDir), run, problem, copied }
}

export function PortableProblem({ problem }: { problem: string | null }): JSX.Element | null {
  if (!problem) return null
  return (
    <span
      role="alert"
      data-testid="portable-problem"
      className="portable-problem text-warn-fg text-ui-xs"
    >
      <WarningIcon aria-hidden />
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
  if (!shown) return null
  return (
    <span className="portable-actions">
      <PortableProblem problem={problem} />
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
        </SplitButtonMenu>
      </SplitButton>
    </span>
  )
}

export function PortableMenuItems({
  run,
}: { run: (action: PortableAction) => Promise<void> }): JSX.Element {
  const d = useDict()
  return (
    <>
      <MenuItem onClick={() => void run('open')}>{d.portable.open}</MenuItem>
      <MenuItem onClick={() => void run('save')}>{d.portable.save}</MenuItem>
      <MenuItem onClick={() => void run('copy')}>{d.portable.copy}</MenuItem>
    </>
  )
}
