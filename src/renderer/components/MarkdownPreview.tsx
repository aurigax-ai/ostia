import { useEffect, useRef } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { sourceLinesOf, trackSelection } from '../lib/domSelection'

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

const COMPONENTS: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
  table: ({ node: _node, ...props }) => (
    <div className="typeset-scroll">
      <table {...props} />
    </div>
  ),
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

  return (
    <div ref={rootRef} className="markdown-preview">
      <article className="typeset typeset-ostia">
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
