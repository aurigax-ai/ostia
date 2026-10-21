import mermaid from 'mermaid'

let counter = 0

async function renderSvg(code: string, dark: boolean): Promise<string> {
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

;(window as unknown as { ostiaMermaid: typeof renderSvg }).ostiaMermaid = renderSvg
