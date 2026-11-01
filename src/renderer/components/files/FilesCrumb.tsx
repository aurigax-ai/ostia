import { CaretRightIcon } from '@phosphor-icons/react'
import { type JSX, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useElementSize } from '@/lib/app/useElementSize'
import { crumbsOf, FOLDED_CRUMB, fitCrumbs, maxFitLevel } from '@/lib/files/breadcrumb'
import { homeDir } from '@/lib/files/homeDir'
import { useSettingsStore } from '@/stores/app/settingsStore'

export function FilesCrumb({ path }: { path: string }): JSX.Element {
  const style = useSettingsStore((s) => s.files.breadcrumb)
  const lineRef = useRef<HTMLDivElement>(null)
  const { width } = useElementSize(lineRef)
  const crumbs = useMemo(() => crumbsOf(path, homeDir()), [path])
  const start = style === 'short' ? 1 : 0
  const max = style === 'full' ? 0 : maxFitLevel(crumbs)
  const fitKey = `${style}|${path}|${width}`
  const [fit, setFit] = useState({ key: fitKey, level: start })
  const level = fit.key === fitKey ? fit.level : start
  const shown = fitCrumbs(crumbs, level)

  useLayoutEffect(() => {
    const line = lineRef.current
    if (!line) return
    if (line.scrollWidth <= line.clientWidth) return
    if (level < max) setFit({ key: fitKey, level: level + 1 })
    else line.scrollLeft = line.scrollWidth
  })

  return (
    <div ref={lineRef} className="files-crumb-line" data-style={style}>
      {shown.map((crumb, i) => (
        <span
          key={crumb.key}
          className={`crumb${i === shown.length - 1 ? ' current' : ''}${crumb.key === FOLDED_CRUMB ? ' folded' : ''}`}
        >
          {i > 0 ? <CaretRightIcon size={16} className="crumb-sep" /> : null}
          {crumb.label}
        </span>
      ))}
    </div>
  )
}
