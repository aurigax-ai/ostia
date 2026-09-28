import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

const REMARK_PLUGINS = [remarkGfm]

const COMPONENTS: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
  table: ({ node: _node, ...props }) => (
    <div className="typeset-scroll">
      <table {...props} />
    </div>
  ),
}

export function MarkdownPreview({ source }: { source: string }): JSX.Element {
  return (
    <div className="markdown-preview">
      <article className="typeset typeset-pine">
        <Markdown remarkPlugins={REMARK_PLUGINS} components={COMPONENTS}>
          {source}
        </Markdown>
      </article>
    </div>
  )
}

export function isMarkdownPath(path: string | undefined): boolean {
  return path !== undefined && /\.(md|markdown|mdx)$/i.test(path)
}
