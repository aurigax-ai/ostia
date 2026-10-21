import { type PortableDocument, portableType } from '@shared/artifacts/portable'
import Markdown, { type Components } from 'react-markdown'
import { mermaidSvg } from '@/lib/files/mermaidImage'
import { stylesMatching } from '@/lib/files/portableStyles'
import { MARKDOWN_REMARK, markdownComponents } from './MarkdownPreview'

const MARKDOWN_STYLES = /\.typeset|\.markdown-preview|\.mermaid-diagram/

function base64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function staticComponents(diagram: (code: string) => JSX.Element): Components {
  return {
    ...markdownComponents(diagram),
    a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
    img: ({ node: _node, src, alt }) =>
      typeof src === 'string' && src.startsWith('data:') ? (
        <img src={src} alt={alt ?? ''} />
      ) : (
        <span>{alt}</span>
      ),
  }
}

async function render(element: JSX.Element): Promise<string> {
  const { renderToStaticMarkup } = await import('react-dom/server')
  return renderToStaticMarkup(element)
}

async function markdownDocument(source: string, dark: boolean): Promise<PortableDocument> {
  const codes: string[] = []
  await render(
    <Markdown
      remarkPlugins={MARKDOWN_REMARK}
      components={staticComponents((code) => {
        codes.push(code)
        return <span />
      })}
    >
      {source}
    </Markdown>,
  )
  const drawn = new Map<string, string | null>()
  for (const code of codes) {
    if (drawn.has(code)) continue
    drawn.set(code, await mermaidSvg(code, dark).then(base64, () => null))
  }
  const diagram = (code: string): JSX.Element => {
    const svg = drawn.get(code)
    return svg ? (
      <img className="mermaid-diagram" src={`data:image/svg+xml;base64,${svg}`} alt="" />
    ) : (
      <pre>
        <code>{code}</code>
      </pre>
    )
  }
  const body = await render(
    <div className="markdown-preview">
      <article className="typeset typeset-ostia">
        <Markdown remarkPlugins={MARKDOWN_REMARK} components={staticComponents(diagram)}>
          {source}
        </Markdown>
      </article>
    </div>,
  )
  return { body, css: stylesMatching(MARKDOWN_STYLES) }
}

export async function portableDocument(
  path: string,
  text: string,
  dark: boolean,
): Promise<PortableDocument | undefined> {
  const type = portableType(path)
  if (type === 'markdown') return markdownDocument(text, dark)
  return undefined
}
