import type { WikiFailure, WikiPage, WikiPageSummary, WikiScope } from '@shared/types'
import { Plus } from 'lucide-react'
import { type JSX, useCallback, useEffect, useState } from 'react'
import { useDict } from '../i18n/useDict'
import { useSessionsStore } from '../stores/sessionsStore'
import { IconButton } from './IconButton'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Textarea } from './ui/textarea'
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group'

function isFailure<T>(r: T | WikiFailure): r is WikiFailure {
  return typeof r === 'object' && r !== null && 'error' in r
}

function useWorkDir(sessionId: string): string {
  return useSessionsStore((s) => s.sessions.find((c) => c.id === sessionId)?.workDir ?? '~')
}

function inlineFragments(line: string): (string | JSX.Element)[] {
  const re = /`([^`]+)`|\*\*([^*]+)\*\*/g
  const parts: (string | JSX.Element)[] = []
  let last = 0
  let key = 0
  for (const m of line.matchAll(re)) {
    if (m.index === undefined) continue
    if (m.index > last) parts.push(line.slice(last, m.index))
    if (m[1] !== undefined) {
      parts.push(
        <code key={key++} className="rounded-sm bg-surface-2 px-1 font-mono text-ui-xs">
          {m[1]}
        </code>,
      )
    } else if (m[2] !== undefined) {
      parts.push(
        <strong key={key++} className="font-semibold text-fg">
          {m[2]}
        </strong>,
      )
    }
    last = m.index + m[0].length
  }
  if (last < line.length) parts.push(line.slice(last))
  return parts.length ? parts : [line]
}

const HEADING_CLASS = [
  '',
  'mt-3 mb-1 font-semibold text-fg text-ui-lg',
  'mt-3 mb-1 font-semibold text-fg text-ui-emphasis',
  'mt-2 mb-1 font-semibold text-fg text-ui-base',
]

function renderBody(body: string): JSX.Element {
  const lines = body.split('\n')
  const blocks: JSX.Element[] = []
  let listBuf: string[] = []

  const flushList = (key: string): void => {
    if (listBuf.length === 0) return
    const items = listBuf
    listBuf = []
    blocks.push(
      <ul key={key} className="list-disc space-y-0.5 pl-5">
        {items.map((item, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static render of an immutable list buffer
          <li key={i}>{inlineFragments(item)}</li>
        ))}
      </ul>,
    )
  }

  lines.forEach((line, i) => {
    const bullet = /^[-*]\s+(.*)$/.exec(line)
    if (bullet) {
      listBuf.push(bullet[1])
      return
    }
    flushList(`ul-${i}`)
    const heading = /^(#{1,3})\s+(.*)$/.exec(line)
    if (heading) {
      const level = heading[1].length
      blocks.push(
        // biome-ignore lint/suspicious/noArrayIndexKey: stable per render — a fixed split of one immutable body string, never reordered
        <div key={i} className={HEADING_CLASS[level]}>
          {inlineFragments(heading[2])}
        </div>,
      )
    } else if (line.trim() === '') {
      // biome-ignore lint/suspicious/noArrayIndexKey: stable per render — see heading branch above
      blocks.push(<div key={i} className="h-2" />)
    } else {
      blocks.push(
        // biome-ignore lint/suspicious/noArrayIndexKey: stable per render — see heading branch above
        <p key={i} className="text-fg-muted leading-relaxed">
          {inlineFragments(line)}
        </p>,
      )
    }
  })
  flushList('ul-end')

  return <div>{blocks}</div>
}

const SCOPE_ITEM_CLASS =
  'flex-1 text-fg-muted text-ui-sm hover:bg-surface-3 aria-pressed:bg-surface-3 aria-pressed:text-fg'

export function WikiView({ sessionId }: { sessionId: string }): JSX.Element {
  const d = useDict()
  const workDir = useWorkDir(sessionId)
  const [scope, setScope] = useState<WikiScope>('project')
  const [pages, setPages] = useState<WikiPageSummary[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [page, setPage] = useState<WikiPage | null>(null)
  const [editing, setEditing] = useState(false)
  const [draftTitle, setDraftTitle] = useState('')
  const [draftBody, setDraftBody] = useState('')
  const [newSlug, setNewSlug] = useState('')
  const [error, setError] = useState<string | null>(null)

  const refreshList = useCallback(() => {
    window.pine.wiki.list({ scope, workDir }).then((r) => setPages(r.pages))
  }, [scope, workDir])

  useEffect(() => {
    refreshList()
  }, [refreshList])

  useEffect(() => {
    window.addEventListener('focus', refreshList)
    return () => window.removeEventListener('focus', refreshList)
  }, [refreshList])

  useEffect(() => {
    if (!selected) {
      setPage(null)
      return
    }
    let alive = true
    window.pine.wiki.get({ slug: selected, scope, workDir }).then((r) => {
      if (!alive) return
      if (isFailure(r)) {
        setError(r.message ?? r.error)
        setPage(null)
      } else {
        setError(null)
        setPage(r)
        setDraftTitle(r.title)
        setDraftBody(r.body)
        setEditing(false)
      }
    })
    return () => {
      alive = false
    }
  }, [selected, scope, workDir])

  const save = async (): Promise<void> => {
    if (!selected) return
    const result = await window.pine.wiki.set({
      slug: selected,
      title: draftTitle,
      body: draftBody,
      scope,
      workDir,
    })
    if (isFailure(result)) {
      setError(result.message ?? result.error)
      return
    }
    setError(null)
    setEditing(false)
    setPage({
      slug: selected,
      title: draftTitle,
      body: draftBody,
      updatedAt: new Date().toISOString(),
    })
    refreshList()
  }

  const createPage = async (): Promise<void> => {
    const slug = newSlug.trim().toLowerCase().replace(/\s+/g, '-')
    if (!slug) return
    setNewSlug('')
    const result = await window.pine.wiki.set({ slug, title: slug, body: '', scope, workDir })
    if (isFailure(result)) {
      setError(result.message ?? result.error)
      return
    }
    setError(null)
    refreshList()
    setSelected(slug)
  }

  const switchScope = (s: WikiScope): void => {
    setScope(s)
    setSelected(null)
  }

  return (
    <div className="flex h-full w-full bg-surface-1 text-fg text-ui-sm">
      <div className="flex w-56 shrink-0 flex-col border-line border-r bg-surface-2">
        <div className="border-line border-b p-2">
          <ToggleGroup
            aria-label={d.wiki.scope}
            size="sm"
            className="w-full"
            value={[scope]}
            onValueChange={(v) => {
              const next = v[0]
              if (next === 'project' || next === 'global') switchScope(next)
            }}
          >
            <ToggleGroupItem value="project" className={SCOPE_ITEM_CLASS}>
              {d.wiki.project}
            </ToggleGroupItem>
            <ToggleGroupItem value="global" className={SCOPE_ITEM_CLASS}>
              {d.wiki.global}
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
        <div className="flex-1 overflow-y-auto">
          {pages.length === 0 ? (
            <div className="p-3 text-center text-fg-muted">{d.wiki.noPages}</div>
          ) : (
            pages.map((p) => (
              <button
                key={p.slug}
                type="button"
                onClick={() => setSelected(p.slug)}
                className={`block w-full truncate px-3 py-1.5 text-left ${
                  selected === p.slug
                    ? 'bg-surface-3 text-fg'
                    : 'text-fg-muted hover:bg-surface-3/60'
                }`}
              >
                {p.title}
              </button>
            ))
          )}
        </div>
        <div className="flex items-center gap-1 border-line border-t p-2">
          <Input
            value={newSlug}
            onChange={(e) => setNewSlug(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') createPage()
            }}
            placeholder={d.wiki.newSlugPlaceholder}
            aria-label={d.wiki.newSlug}
            className="h-7 flex-1 font-mono"
          />
          <IconButton size="bar" icon={Plus} label={d.wiki.create} onClick={createPage} />
        </div>
      </div>

      <div className="flex flex-1 flex-col overflow-hidden">
        {error ? <div className="border-line border-b p-2 text-attn-fg">{error}</div> : null}
        {!selected ? (
          <div className="flex flex-1 items-center justify-center text-fg-muted">
            {d.wiki.selectOrCreate}
          </div>
        ) : !page ? (
          <div className="flex flex-1 items-center justify-center text-fg-muted">
            {d.wiki.loading}
          </div>
        ) : editing ? (
          <div className="flex flex-1 flex-col gap-2 p-3">
            <Input
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              aria-label={d.wiki.pageTitle}
              className="h-7 font-medium"
            />
            <Textarea
              value={draftBody}
              onChange={(e) => setDraftBody(e.target.value)}
              aria-label={d.wiki.pageBody}
              className="field-sizing-fixed flex-1 resize-none font-mono"
            />
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setEditing(false)}>
                {d.wiki.cancel}
              </Button>
              <Button size="sm" onClick={save}>
                {d.wiki.save}
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between border-line border-b p-3">
              <div className="font-medium text-fg text-ui-emphasis">{page.title}</div>
              <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                {d.wiki.edit}
              </Button>
            </div>
            <div className="flex-1 overflow-y-auto p-3">{renderBody(page.body)}</div>
          </>
        )}
      </div>
    </div>
  )
}
