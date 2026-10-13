import { sourceLinesOf, trackSelection } from '@/lib/browser/domSelection'
import { findStep, matchChord } from '@/lib/keys/chords'
import { isMac } from '@/platform'
import { type KeyboardEvent, useEffect, useRef, useState } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { DocumentFind } from './DocumentFind'
import { MermaidDiagram } from './MermaidDiagram'

interface HastNode {
  type: string
  properties?: Record<string, unknown>
  position?: { start: { line: number }; end: { line: number } }
  children?: HastNode[]
}

function tagSourceLines(node: HastNode): void {
  if (node.type === 'element' && node.position) {
    node.properties = {
      ...node.properties,
      'data-line-start': node.position.start.line,
      'data-line-end': node.position.end.line,
    }
  }
  for (const child of node.children ?? []) tagSourceLines(child)
}

export function rehypeSourceLines() {
  return (tree: HastNode): void => tagSourceLines(tree)
}

const REMARK_PLUGINS = [remarkGfm]
const REHYPE_PLUGINS = [rehypeSourceLines]

function textOf(node: HastNode & { value?: string }): string {
  if (typeof node.value === 'string') return node.value
  return (node.children ?? []).map(textOf).join('')
}

export function mermaidSource(pre: HastNode | undefined): string | null {
  const code = pre?.children?.[0] as (HastNode & { tagName?: string }) | undefined
  if (!code || code.tagName !== 'code') return null
  const classes = code.properties?.className
  const names = Array.isArray(classes) ? classes : []
  return names.includes('language-mermaid') ? textOf(code).replace(/\n$/, '') : null
}

const COMPONENTS: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
  pre: ({ node, ...props }) => {
    const diagram = mermaidSource(node as HastNode | undefined)
    return diagram === null ? <pre {...props} /> : <MermaidDiagram code={diagram} />
  },
  table: ({ node: _node, ...props }) => (
    <div className="typeset-scroll">
      <table {...props} />
    </div>
  ),
}

function isPlainFindKey(e: KeyboardEvent<HTMLElement>): boolean {
  return (isMac ? e.metaKey : e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f'
}

export interface PreviewSelection {
  text: string
  startLine: number
  endLine: number
}

export function MarkdownPreview({
  source,
  onSelectionChange,
}: {
  source: string
  onSelectionChange?: (selection: PreviewSelection | null) => void
}): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const articleRef = useRef<HTMLElement>(null)
  const [finding, setFinding] = useState(false)
  const findStepRef = useRef<((by: number) => void) | null>(null)
  const onChangeRef = useRef(onSelectionChange)
  onChangeRef.current = onSelectionChange

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const stop = trackSelection(root, (range) => {
      const lines = range ? sourceLinesOf(range, root) : null
      onChangeRef.current?.(range && lines ? { text: range.toString(), ...lines } : null)
    })
    return () => {
      stop()
      onChangeRef.current?.(null)
    }
  }, [])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const chord = matchChord(e, isMac)
    const by = findStep(chord)
    if (by !== null) {
      e.preventDefault()
      if (findStepRef.current) findStepRef.current(by)
      else setFinding(true)
      return
    }
    if (chord !== 'find' && !isPlainFindKey(e)) return
    e.preventDefault()
    setFinding(true)
  }

  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: the preview takes focus so its find key reaches it
    <div ref={rootRef} className="markdown-preview" tabIndex={0} onKeyDown={onKeyDown}>
      {finding ? (
        <DocumentFind
          rootRef={articleRef}
          content={source}
          stepRef={findStepRef}
          onClose={() => {
            setFinding(false)
            rootRef.current?.focus()
          }}
        />
      ) : null}
      <article ref={articleRef} className="typeset typeset-ostia">
        <Markdown
          remarkPlugins={REMARK_PLUGINS}
          rehypePlugins={REHYPE_PLUGINS}
          components={COMPONENTS}
        >
          {source}
        </Markdown>
      </article>
    </div>
  )
}

export function isMarkdownPath(path: string | undefined): boolean {
  return path !== undefined && /\.(md|markdown|mdx)$/i.test(path)
}
