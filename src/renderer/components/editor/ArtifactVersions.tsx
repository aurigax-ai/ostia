import type { ArtifactVersion } from '@shared/artifacts/artifacts'
import { useEffect, useState } from 'react'
import { DropdownMenu, MenuItem } from '@/components/common/Menu'
import { Alert } from '@/components/ui/alert'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { formatBytes, formatDate } from '@/lib/app/localeFormat'
import { fmt, useDict } from '@/lib/app/useDict'
import { usePaneVisible } from '@/lib/attention/workspaceActivity'
import { useArtifactListing } from '@/lib/files/artifacts'
import { baseName } from '@/lib/files/fileTree'
import { viewerOptions } from '@/lib/files/viewerChoice'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useExtensionsStore } from '@/stores/extensions/extensionsStore'
import { useArtifactsStore } from '@/stores/files/artifactsStore'
import { type ShownVersion, useArtifactVersionsStore } from '@/stores/files/artifactVersionsStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { FileViewerFrame } from './FileViewerFrame'
import { HtmlPreview } from './HtmlPreview'

function useTopArtifact(workspaceId: string, filePath: string): boolean {
  const listing = useArtifactListing(workspaceId)
  return Boolean(
    listing &&
      filePath.startsWith(`${listing.dir}/`) &&
      !filePath.slice(listing.dir.length + 1).includes('/'),
  )
}

function useVersions(workspaceId: string, filePath: string, enabled: boolean): ArtifactVersion[] {
  const modified = useArtifactsStore(
    (s) => s.byWorkspace[workspaceId]?.entries.find((entry) => entry.path === filePath)?.modified,
  )
  const [versions, setVersions] = useState<ArtifactVersion[]>([])
  // biome-ignore lint/correctness/useExhaustiveDependencies: a change to the file on disk makes a new version, so the list is read again
  useEffect(() => {
    if (!enabled) return
    let alive = true
    const load = (): void => {
      void window.ostia.artifacts.versions(workspaceId, filePath).then((found) => {
        if (alive) setVersions(found ?? [])
      })
    }
    load()
    const later = setTimeout(load, 3_000)
    return () => {
      alive = false
      clearTimeout(later)
    }
  }, [workspaceId, filePath, enabled, modified])
  return versions
}

export function ArtifactVersionsButton({
  workspaceId,
  paneId,
  filePath,
}: {
  workspaceId: string
  paneId: string
  filePath: string
}): JSX.Element | null {
  const d = useDict()
  const locale = useSettingsStore((s) => s.locale)
  const top = useTopArtifact(workspaceId, filePath)
  const versions = useVersions(workspaceId, filePath, top)
  if (!top || versions.length === 0) return null
  const name = baseName(filePath)
  return (
    <DropdownMenu
      trigger={
        <Button
          variant="outline"
          size="xs"
          aria-label={fmt(d.portable.versionCount, { count: versions.length })}
        >
          {d.portable.versions}
          <Badge variant="secondary" className="text-ui-xs">
            {versions.length}
          </Badge>
        </Button>
      }
    >
      {versions.map((version) => (
        <MenuItem
          key={version.id}
          aria-label={fmt(d.portable.versionRow, { name, time: formatDate(version.time, locale) })}
          hint={
            <>
              {formatBytes(version.size, locale)}
              {version.current ? (
                <Badge variant="outline" className="text-ui-xs">
                  {d.portable.current}
                </Badge>
              ) : null}
            </>
          }
          onClick={() => {
            if (version.current) useArtifactVersionsStore.getState().back(paneId)
            else
              void useArtifactVersionsStore.getState().show(workspaceId, paneId, filePath, version)
          }}
        >
          {formatDate(version.time, locale)}
        </MenuItem>
      ))}
    </DropdownMenu>
  )
}

const IGNORE_FAILURE = (): void => {}

function VersionBody({
  workspaceId,
  paneId,
  filePath,
  shown,
}: {
  workspaceId: string
  paneId: string
  filePath: string
  shown: ShownVersion
}): JSX.Element {
  const visible = usePaneVisible(paneId)
  const extensions = useExtensionsStore((s) => s.list)
  const { content } = shown
  const source = content.sources[baseName(filePath)] ?? ''
  const options = viewerOptions(filePath, extensions)
  const viewer = options.find((option) => option.priority === 'default') ?? options[0] ?? null
  if (content.type === 'component' || content.type === 'page') {
    return (
      <HtmlPreview
        key={content.file}
        workspaceId={workspaceId}
        paneId={paneId}
        filePath={content.file}
        visible={visible}
      />
    )
  }
  if (viewer) {
    return (
      <FileViewerFrame
        key={content.file}
        workspaceId={workspaceId}
        paneId={paneId}
        filePath={content.file}
        viewer={viewer}
        onFailed={IGNORE_FAILURE}
      />
    )
  }
  return <pre className="version-source font-mono text-ui-sm">{source}</pre>
}

export function VersionView({
  workspaceId,
  paneId,
  filePath,
}: {
  workspaceId: string
  paneId: string
  filePath: string
}): JSX.Element | null {
  const d = useDict()
  const locale = useSettingsStore((s) => s.locale)
  const shown = useArtifactVersionsStore((s) =>
    s.byPane[paneId]?.path === filePath ? s.byPane[paneId] : undefined,
  )
  const modified = useArtifactsStore(
    (s) => s.byWorkspace[workspaceId]?.entries.find((entry) => entry.path === filePath)?.modified,
  )
  const [asking, setAsking] = useState(false)
  const [refused, setRefused] = useState<string[]>([])

  useEffect(() => {
    if (shown && modified !== undefined && modified !== shown.modifiedAtOpen) {
      useArtifactVersionsStore.getState().back(paneId)
    }
  }, [shown, modified, paneId])

  if (!shown) return null
  const time = formatDate(shown.version.time, locale)
  const back = (): void => useArtifactVersionsStore.getState().back(paneId)
  const compare = async (): Promise<void> => {
    const now = await window.ostia.fs.read(filePath)
    if (!now.ok) return
    useLayoutStore.getState().openDiff(workspaceId, {
      title: fmt(d.portable.compareTitle, { name: baseName(filePath), time }),
      original: shown.content.sources[baseName(filePath)] ?? '',
      modified: now.text,
      path: filePath,
    })
  }
  const restore = async (): Promise<void> => {
    setAsking(false)
    const result = await window.ostia.artifacts.restore(workspaceId, filePath, shown.version.id)
    if (result && result.refused.length > 0) setRefused(result.refused)
  }
  return (
    <div className="version-view" data-testid="version-view">
      <Alert className="version-bar" data-testid="version-bar">
        <span className="min-w-0 flex-1">{fmt(d.portable.versionFrom, { time })}</span>
        {refused.length > 0 ? (
          <span role="alert" className="text-warn-fg text-ui-xs">
            {fmt(d.portable.notRestored, { files: refused.join(', ') })}
          </span>
        ) : null}
        <Button variant="outline" size="xs" onClick={() => setAsking(true)}>
          {d.portable.restore}
        </Button>
        <Button variant="outline" size="xs" onClick={() => void compare()}>
          {d.portable.compare}
        </Button>
        <Button variant="outline" size="xs" onClick={back}>
          {d.portable.back}
        </Button>
      </Alert>
      <div className="version-body">
        <VersionBody workspaceId={workspaceId} paneId={paneId} filePath={filePath} shown={shown} />
      </div>
      <AlertDialog open={asking} onOpenChange={setAsking}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{d.portable.restoreTitle}</AlertDialogTitle>
            <AlertDialogDescription>{fmt(d.portable.restoreBody, { time })}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{d.portable.cancel}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void restore()}>
              {d.portable.restore}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
