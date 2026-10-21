import { type ComponentProps, createElement, type ReactElement, type ReactNode } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface HastNode {
  type: string
  value?: string
  tagName?: string
  properties?: Record<string, unknown>
  position?: { start: { line: number }; end: { line: number } }
  children?: HastNode[]
}

const LANGUAGE_MERMAID = 'language-mermaid'

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

function rehypeSourceLines() {
  return (tree: HastNode): void => tagSourceLines(tree)
}

function textOf(node: HastNode): string {
  if (typeof node.value === 'string') return node.value
  return (node.children ?? []).map(textOf).join('')
}

function mermaidSource(pre: HastNode | undefined): string | null {
  const code = pre?.children?.[0]
  if (code?.tagName !== 'code') return null
  const classes = code.properties?.className
  const names = Array.isArray(classes) ? classes : []
  return names.includes(LANGUAGE_MERMAID) ? textOf(code).replace(/\n$/, '') : null
}

export interface MarkdownHooks {
  diagram: (code: string, lines: Record<string, unknown>) => ReactNode
  onLink: (href: string) => void
}

function lineProps(props: Record<string, unknown>): Record<string, unknown> {
  return {
    'data-line-start': props['data-line-start'],
    'data-line-end': props['data-line-end'],
  }
}

interface Activation {
  key?: string
  preventDefault: () => void
}

export function linkHandlers(
  href: string | undefined,
  onLink: (href: string) => void,
): { onClick: (event: Activation) => void; onKeyDown: (event: Activation) => void } {
  const open = (event: Activation): void => {
    event.preventDefault()
    if (href) onLink(href)
  }
  return {
    onClick: open,
    onKeyDown: (event) => {
      if (event.key === 'Enter') open(event)
    },
  }
}

function previewComponents({ diagram, onLink }: MarkdownHooks): Components {
  return {
    a: ({ node: _node, href, ...props }) =>
      createElement('a', { ...props, href, ...linkHandlers(href, onLink) }),
    pre: ({ node, ...props }) => {
      const code = mermaidSource(node as HastNode | undefined)
      return code === null ? createElement('pre', props) : diagram(code, lineProps(props))
    },
    table: ({ node: _node, ...props }) =>
      createElement('div', { className: 'typeset-scroll' }, createElement('table', props)),
    img: () => null,
  }
}

export function markdownElement(source: string, hooks: MarkdownHooks): ReactElement {
  const props: ComponentProps<typeof Markdown> = {
    remarkPlugins: [remarkGfm],
    rehypePlugins: [rehypeSourceLines],
    components: previewComponents(hooks),
    children: source,
  }
  return createElement(Markdown, props)
}
