import { TerminalWindowIcon } from '@phosphor-icons/react'
import { resolveLinkPath } from '@shared/files/fileLinks'
import type { ReactNode } from 'react'
import type { Components } from 'react-markdown'
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockHeader,
  CodeBlockTitle,
} from '@/components/ai-elements/code-block'
import { Hint } from '@/components/common/Hint'
import { IconButton } from '@/components/common/IconButton'
import { fmt, useDict } from '@/lib/app/useDict'
import { isShellLanguage } from '@/lib/assist/askContext'
import { insertInto, looksLikeCommand } from '@/lib/assist/chatActions'
import type { FileLinkTarget } from '@/lib/assist/chatLinks'
import { fileLinkOf, isWebUrl, wholeFileLink } from '@/lib/assist/chatLinks'
import { openFileAt } from '@/lib/files/openFile'
import { openSidebarUrl } from '@/lib/sidebar/sidebarItems'
import { useUIStore } from '@/stores/app/uiStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import {
  type ChatActionNotice,
  ChatCodeActions,
  insertReason,
  useTerminals,
} from './ChatCodeActions'

interface HastLike {
  type: string
  value?: string
  tagName?: string
  properties?: { className?: unknown }
  children?: HastLike[]
}

function hastText(node: HastLike): string {
  if (node.type === 'text') return node.value ?? ''
  return (node.children ?? []).map(hastText).join('')
}

function codeLanguage(node: HastLike | undefined): string {
  const code = node?.children?.find((c) => c.tagName === 'code')
  const classes = code?.properties?.className
  const list = Array.isArray(classes) ? classes.map(String) : []
  const match = list.find((c) => c.startsWith('language-'))
  return match ? match.slice('language-'.length) : ''
}

interface MarkdownContext {
  workspaceId: string | null
  sessionId: string
  onNotice: (notice: ChatActionNotice) => void
  onInserted?: () => void
}

function workspaceRoot(workspaceId: string | null): string {
  const { workspaces, activeWorkspaceId } = useWorkspacesStore.getState()
  return workspaces.find((w) => w.id === (workspaceId ?? activeWorkspaceId))?.workDir ?? '~'
}

function openFileLink(target: FileLinkTarget, workspaceId: string | null): void {
  useUIStore.getState().closePalette()
  openFileAt(resolveLinkPath(target.path, workspaceRoot(workspaceId)), target.line, target.column)
}

function FileLink({
  target,
  workspaceId,
  children,
}: {
  target: FileLinkTarget
  workspaceId: string | null
  children: ReactNode
}): JSX.Element {
  const d = useDict()
  return (
    <Hint label={fmt(d.chatActions.openFile, { path: target.path })}>
      <button
        type="button"
        className="chat-file-link"
        onClick={() => openFileLink(target, workspaceId)}
      >
        {children}
      </button>
    </Hint>
  )
}

function InlineCommand({
  command,
  ctx,
  children,
}: {
  command: string
  ctx: MarkdownContext
  children: ReactNode
}): JSX.Element {
  const d = useDict()
  const terminals = useTerminals(ctx.workspaceId)
  const reason = insertReason(d, terminals)
  const target = terminals.find((t) => t.idle)
  return (
    <span className="chat-inline-command">
      <code>{children}</code>
      <IconButton
        icon={TerminalWindowIcon}
        label={reason ? fmt(d.ask.insertRefused, { reason }) : d.ask.insert}
        aria-disabled={reason !== null}
        className="chat-inline-insert aria-disabled:opacity-50"
        onClick={() => {
          if (!target) return
          if (insertInto(target.paneId, command)) {
            ctx.onNotice('inserted')
            ctx.onInserted?.()
          }
        }}
      />
    </span>
  )
}

export function markdownComponents(ctx: MarkdownContext): Components {
  return {
    a: ({ node: _node, href, children, ...props }) => {
      const file = fileLinkOf(props as Record<string, unknown>)
      if (file) {
        return (
          <FileLink target={file} workspaceId={ctx.workspaceId}>
            {children}
          </FileLink>
        )
      }
      if (isWebUrl(href)) {
        return (
          <a
            href={href}
            onClick={(e) => {
              e.preventDefault()
              useUIStore.getState().closePalette()
              openSidebarUrl(ctx.workspaceId ?? undefined, href, 'human')
            }}
          >
            {children}
          </a>
        )
      }
      return <span>{children}</span>
    },
    code: ({ node: _node, children, className, ...props }) => {
      const text = typeof children === 'string' ? children : ''
      const file = text ? wholeFileLink(text) : null
      if (file) {
        return (
          <FileLink target={file} workspaceId={ctx.workspaceId}>
            <code>{children}</code>
          </FileLink>
        )
      }
      if (text && looksLikeCommand(text)) {
        return (
          <InlineCommand command={text} ctx={ctx}>
            {children}
          </InlineCommand>
        )
      }
      return (
        <code className={className} {...props}>
          {children}
        </code>
      )
    },
    table: ({ node: _node, ...props }) => (
      <div className="typeset-scroll">
        <table {...props} />
      </div>
    ),
    pre: ({ node }) => {
      const hast = node as HastLike | undefined
      const code = hast ? hastText(hast).replace(/\n$/, '') : ''
      const language = codeLanguage(hast)
      return (
        <CodeBlock code={code} language={language} className="not-typeset">
          <CodeBlockHeader>
            <CodeBlockTitle className="font-mono text-fg-muted text-ui-xs">
              {language}
            </CodeBlockTitle>
            <CodeBlockActions className="code-block-actions">
              <ChatCodeActions
                code={code}
                language={language}
                shell={isShellLanguage(language)}
                sessionId={ctx.sessionId}
                workspaceId={ctx.workspaceId}
                onNotice={ctx.onNotice}
                onInserted={ctx.onInserted}
              />
            </CodeBlockActions>
          </CodeBlockHeader>
        </CodeBlock>
      )
    },
  }
}
