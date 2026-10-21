import type { CSSProperties, ReactNode, RefObject } from 'react'
import { type ShellToken, tokenizeShell } from '@/lib/prompt/shellTokens'
import type { Ghost } from '@/lib/prompt/terminalGhost'

function unescapeWord(word: string): string {
  return word.replace(/\\(.)/g, '$1')
}

function tokenClass(token: ShellToken, commands: ReadonlySet<string> | null): string {
  if (token.kind !== 'command') return `syn-${token.kind}`
  const name = unescapeWord(token.text)
  const known = !commands || name.includes('/') || commands.has(name)
  return known ? 'syn-command' : 'syn-unknown'
}

function renderDraft(
  text: string,
  commands: ReadonlySet<string> | null,
  cursor: number | null,
): ReactNode[] {
  const block = (char: string): ReactNode => (
    <span key="cursor" className="input-editor-block-cursor">
      {char}
    </span>
  )
  const nodes: ReactNode[] = []
  for (const token of tokenizeShell(text)) {
    const className = tokenClass(token, commands)
    const data = {
      className,
      'data-token': token.kind,
      'data-known': token.kind === 'command' ? String(className === 'syn-command') : undefined,
    }
    const at = cursor === null ? -1 : cursor - token.start
    if (at < 0 || at >= token.text.length) {
      nodes.push(
        <span key={token.start} {...data}>
          {token.text}
        </span>,
      )
    } else if (token.text[at] === '\n') {
      nodes.push(block(' '))
      nodes.push(
        <span key={token.start} {...data}>
          {token.text}
        </span>,
      )
    } else {
      nodes.push(
        <span key={token.start} {...data}>
          {token.text.slice(0, at)}
          {block(token.text[at])}
          {token.text.slice(at + 1)}
        </span>,
      )
    }
  }
  if (cursor !== null && cursor >= text.length) nodes.push(block(' '))
  return nodes
}

export function InputEditorHighlight({
  overlayRef,
  style,
  text,
  commands,
  cursor,
  ghost,
}: {
  overlayRef: RefObject<HTMLDivElement>
  style: CSSProperties
  text: string
  commands: ReadonlySet<string> | null
  cursor: number | null
  ghost: Ghost
}): JSX.Element {
  return (
    <div
      ref={overlayRef}
      className="input-editor-highlight"
      style={style}
      aria-hidden="true"
      data-testid="input-editor-highlight"
    >
      {renderDraft(text, commands, cursor)}
      {ghost ? (
        <span className="input-editor-ghost" data-ghost={ghost.kind}>
          {ghost.text}
        </span>
      ) : null}
    </div>
  )
}
