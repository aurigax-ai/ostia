import { useEffect, useState } from 'react'
import { useDict } from '../i18n/useDict'
import { mermaidSvg, releaseImageUrl, svgImageUrl } from '../lib/mermaidImage'
import { useEffectiveTheme } from '../lib/theme'

type Drawn = { url: string } | { problem: string } | null

export function MermaidDiagram({ code }: { code: string }): JSX.Element {
  const d = useDict()
  const dark = useEffectiveTheme()?.appearance !== 'light'
  const [drawn, setDrawn] = useState<Drawn>(null)

  useEffect(() => {
    let alive = true
    let url: string | null = null
    mermaidSvg(code, dark).then(
      (svg) => {
        if (!alive) return
        url = svgImageUrl(svg)
        setDrawn({ url })
      },
      (err: unknown) => {
        if (alive) setDrawn({ problem: err instanceof Error ? err.message : String(err) })
      },
    )
    return () => {
      alive = false
      if (url) releaseImageUrl(url)
    }
  }, [code, dark])

  if (drawn && 'url' in drawn) {
    return (
      <img
        className="mermaid-diagram"
        data-testid="mermaid-diagram"
        src={drawn.url}
        alt={d.viewer.diagram}
      />
    )
  }
  return (
    <>
      {drawn ? (
        <p className="mermaid-problem" data-testid="mermaid-problem">
          {d.viewer.diagramProblem} {drawn.problem}
        </p>
      ) : null}
      <pre>
        <code>{code}</code>
      </pre>
    </>
  )
}
