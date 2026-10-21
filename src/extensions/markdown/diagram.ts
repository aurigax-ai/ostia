import { createElement, type ReactElement, useEffect, useState } from 'react'

export const MERMAID_SOURCE_MAX = 50_000
const MERMAID_SCRIPT = 'mermaid.script.js'

export type MermaidRenderer = (code: string, dark: boolean) => Promise<string>

export type Drawn = { url: string } | { tooLarge: true } | { problem: string }

export interface DiagramLabels {
  alt: string
  problem: string
  tooLarge: string
}

interface MermaidScope {
  ostiaMermaid?: MermaidRenderer
}

let loading: Promise<MermaidRenderer> | null = null

function loadMermaid(): Promise<MermaidRenderer> {
  loading ??= new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = MERMAID_SCRIPT
    script.onload = () => {
      const renderer = (window as unknown as MermaidScope).ostiaMermaid
      if (renderer) resolve(renderer)
      else reject(new Error('the diagram library did not start'))
    }
    script.onerror = () => {
      loading = null
      reject(new Error('the diagram library did not load'))
    }
    document.head.append(script)
  })
  return loading
}

function prefersDark(): boolean {
  return !getComputedStyle(document.documentElement).colorScheme.startsWith('light')
}

export async function drawDiagram(
  code: string,
  dark: boolean,
  render: MermaidRenderer = (source, isDark) => loadMermaid().then((draw) => draw(source, isDark)),
): Promise<Drawn> {
  if (code.length > MERMAID_SOURCE_MAX) return { tooLarge: true }
  try {
    const svg = await render(code, dark)
    return { url: URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' })) }
  } catch (error) {
    return { problem: error instanceof Error ? error.message : String(error) }
  }
}

export function MermaidDiagram({
  code,
  labels,
  lines,
}: {
  code: string
  labels: DiagramLabels
  lines: Record<string, unknown>
}): ReactElement {
  const [drawn, setDrawn] = useState<Drawn | null>(null)

  useEffect(() => {
    let alive = true
    let url: string | null = null
    void drawDiagram(code, prefersDark()).then((result) => {
      if (!alive) {
        if ('url' in result) URL.revokeObjectURL(result.url)
        return
      }
      if ('url' in result) url = result.url
      setDrawn(result)
    })
    return () => {
      alive = false
      if (url) URL.revokeObjectURL(url)
    }
  }, [code])

  if (drawn && 'url' in drawn) {
    return createElement(
      'div',
      lines,
      createElement('img', {
        className: 'mermaid-diagram',
        'data-testid': 'mermaid-diagram',
        src: drawn.url,
        alt: labels.alt,
      }),
    )
  }
  const detail = drawn && 'tooLarge' in drawn ? labels.tooLarge : drawn?.problem
  return createElement(
    'div',
    lines,
    detail
      ? createElement(
          'p',
          { className: 'mermaid-problem', 'data-testid': 'mermaid-problem' },
          `${labels.problem} ${detail}`,
        )
      : null,
    createElement('pre', null, createElement('code', null, code)),
  )
}
