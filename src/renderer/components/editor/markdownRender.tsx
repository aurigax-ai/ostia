import type { ReactNode } from 'react'
import type { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface HastNode {
  type: string
  properties?: Record<string, unknown>
  children?: HastNode[]
}

export const MARKDOWN_REMARK = [remarkGfm]

function textOf(node: HastNode & { value?: string }): string {
  if (typeof node.value === 'string') return node.value
  return (node.children ?? []).map(textOf).join('')
}

function mermaidSource(pre: HastNode | undefined): string | null {
  const code = pre?.children?.[0] as (HastNode & { tagName?: string }) | undefined
  if (code?.tagName !== 'code') return null
  const classes = code.properties?.className
  const names = Array.isArray(classes) ? classes : []
  return names.includes('language-mermaid') ? textOf(code).replace(/\n$/, '') : null
}

export function markdownComponents(diagram: (code: string) => ReactNode): Components {
  return {
    a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
    pre: ({ node, ...props }) => {
      const code = mermaidSource(node as HastNode | undefined)
      return code === null ? <pre {...props} /> : diagram(code)
    },
    table: ({ node: _node, ...props }) => (
      <div className="typeset-scroll">
        <table {...props} />
      </div>
    ),
  }
}
