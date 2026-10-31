import type { ExtensionSidebarItem } from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { useLayoutEffect, useRef, useState } from 'react'
import { Hint } from '@/components/common/Hint'
import { extensionIcon } from '@/components/extensions/extensionIcons'
import { Badge } from '@/components/ui/badge'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { fmt, useDict } from '@/lib/app/useDict'
import { fitCount, shortenPath } from '@/lib/sidebar/railMeta'
import { openSidebarUrl, visibleSidebarItems } from '@/lib/sidebar/sidebarItems'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useExtensionsStore } from '@/stores/extensions/extensionsStore'

const itemKey = (item: ExtensionSidebarItem): string => `${item.extId}:${item.key}`

const signatureOf = (items: readonly ExtensionSidebarItem[]): string =>
  items
    .map(
      (item) =>
        `${itemKey(item)}\u0000${item.icon ?? ''}\u0000${item.badge ?? ''}\u0000${item.text}`,
    )
    .join('\n')

function onResize(el: HTMLElement, cb: () => void): () => void {
  const observer = new ResizeObserver(cb)
  observer.observe(el)
  return () => observer.disconnect()
}

function columnGap(el: HTMLElement): number {
  return Number.parseFloat(getComputedStyle(el).columnGap) || 0
}

function SidebarItem({
  item,
  workspaceId,
}: {
  item: ExtensionSidebarItem
  workspaceId?: string
}): JSX.Element {
  const d = useDict()
  const extName = useExtensionsStore(
    (s) => s.list.find((e) => e.id === item.extId)?.name ?? item.extId,
  )
  const Icon = item.icon ? extensionIcon(item.icon) : null
  const body = (
    <>
      {Icon ? <Icon size={16} aria-hidden /> : null}
      {item.badge ? (
        <Badge variant="outline" className="h-4 px-1 text-ui-xs tracking-caps">
          {item.badge}
        </Badge>
      ) : null}
      <span className="ext-item-text">{item.text}</span>
    </>
  )
  const url = item.url
  if (url) {
    return (
      <Hint label={fmt(d.rail.openUrl, { url })}>
        <button
          type="button"
          data-meta-item
          className={`ext-item ext-item-link tone-${item.tone}`}
          onClick={(e) => {
            e.stopPropagation()
            openSidebarUrl(workspaceId, url, 'human')
          }}
        >
          {body}
        </button>
      </Hint>
    )
  }
  return (
    <Hint label={`${extName}: ${item.text}`}>
      <span data-meta-item className={`ext-item tone-${item.tone}`}>
        {body}
      </span>
    </Hint>
  )
}

export function PathLine({ path, hint = true }: { path: string; hint?: boolean }): JSX.Element {
  const line = useRef<HTMLDivElement>(null)
  const [maxChars, setMaxChars] = useState(Number.POSITIVE_INFINITY)
  const shown = shortenPath(path, maxChars)

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new path changes the text to measure
  useLayoutEffect(() => {
    const el = line.current
    if (!el) return
    const measure = (): void => {
      const span = el.querySelector<HTMLElement>('.rail-meta-path')
      if (!span?.textContent) return
      const charWidth = span.scrollWidth / span.textContent.length
      if (!charWidth) return
      setMaxChars(Math.max(0, Math.floor(el.clientWidth / charWidth)))
    }
    measure()
    return onResize(el, measure)
  }, [path])

  return (
    <div ref={line} className="rail-meta location">
      {hint ? (
        <Hint label={path}>
          <span className="rail-meta-path">{shown}</span>
        </Hint>
      ) : (
        <span className="rail-meta-path">{shown}</span>
      )}
    </div>
  )
}

export function LiveLine({
  items,
  workspaceId,
}: {
  items: readonly ExtensionSidebarItem[]
  workspaceId?: string
}): JSX.Element | null {
  const d = useDict()
  const line = useRef<HTMLDivElement>(null)
  const widths = useRef<number[]>([])
  const moreWidth = useRef(0)
  const signature = signatureOf(items)
  const [fit, setFit] = useState<{ signature: string; count: number } | null>(null)
  const measuring = fit?.signature !== signature
  const count = measuring ? items.length : (fit?.count ?? items.length)
  const hidden = items.slice(count)

  useLayoutEffect(() => {
    const el = line.current
    if (!el) return
    const recount = (): void =>
      setFit({
        signature,
        count: fitCount({
          widths: widths.current,
          available: el.clientWidth,
          gap: columnGap(el),
          moreWidth: moreWidth.current,
        }),
      })
    if (measuring) {
      widths.current = [...el.querySelectorAll<HTMLElement>('[data-meta-item]')].map(
        (child) => child.getBoundingClientRect().width,
      )
      moreWidth.current = el.querySelector('.rail-meta-probe')?.getBoundingClientRect().width ?? 0
      recount()
    }
    return onResize(el, recount)
  }, [measuring, signature])

  if (items.length === 0) return null
  return (
    <div ref={line} className="rail-meta live" data-measuring={measuring || undefined}>
      {items.slice(0, count).map((item) => (
        <SidebarItem key={itemKey(item)} item={item} workspaceId={workspaceId} />
      ))}
      {measuring ? (
        <span className="rail-meta-more rail-meta-probe" aria-hidden>
          +{items.length}
        </span>
      ) : null}
      {hidden.length > 0 ? (
        <Popover>
          <PopoverTrigger
            render={
              <button
                type="button"
                className="rail-meta-more"
                aria-label={fmt(d.rail.moreItems, { n: hidden.length })}
                onClick={(e) => e.stopPropagation()}
              />
            }
          >
            +{hidden.length}
          </PopoverTrigger>
          <PopoverContent
            side="right"
            align="start"
            className="rail-meta-overflow w-auto max-w-72 gap-1 p-2"
            onClick={(e) => e.stopPropagation()}
          >
            {hidden.map((item) => (
              <SidebarItem key={itemKey(item)} item={item} workspaceId={workspaceId} />
            ))}
          </PopoverContent>
        </Popover>
      ) : null}
    </div>
  )
}

export function useSidebarItems(workspaceId: string | undefined): ExtensionSidebarItem[] {
  const all = useExtensionsStore((s) => s.sidebar)
  const showSSH = useSettingsStore((s) => s.sidebar.showSSH)
  return visibleSidebarItems(all, workspaceId, { showSSH })
}

function FooterItems(): JSX.Element {
  const items = useSidebarItems(undefined)
  return (
    <>
      {items.map((item) => (
        <SidebarItem key={`${item.extId}:${item.key}`} item={item} />
      ))}
    </>
  )
}

export function SidebarFooter(): JSX.Element | null {
  const hasGlobal = useExtensionsStore((s) => s.sidebar.some((i) => i.workspaceId === undefined))
  if (!hasGlobal) return null
  return (
    <div className="rail-ext-footer">
      <FooterItems />
    </div>
  )
}
