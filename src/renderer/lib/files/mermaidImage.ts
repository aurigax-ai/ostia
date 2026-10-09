export const MERMAID_SOURCE_MAX = 50_000

let counter = 0

export async function mermaidSvg(code: string, dark: boolean): Promise<string> {
  if (code.length > MERMAID_SOURCE_MAX) throw new Error('the diagram is too large to draw')
  const { default: mermaid } = await import('mermaid')
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: dark ? 'dark' : 'default',
    htmlLabels: false,
    flowchart: { htmlLabels: false },
  })
  counter += 1
  const { svg } = await mermaid.render(`ostia-mermaid-${counter}`, code)
  return svg
}

export function svgImageUrl(svg: string): string {
  return URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
}

export function releaseImageUrl(url: string): void {
  URL.revokeObjectURL(url)
}
