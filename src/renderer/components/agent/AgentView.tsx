import { useChat } from '@ai-sdk/react'
import type { ChatContextItem } from '@aurigax-ai/ostia-extension-sdk/contract/assist'
import { PI_MANAGER_AGENT } from '@shared/agents/managerSettings'
import { type MutableRefObject, useEffect, useMemo, useRef, useState } from 'react'
import { ChatConversation } from '@/components/chat/ChatConversation'
import { markdownComponents } from '@/components/chat/ChatMarkdown'
import { ChatReviewBar } from '@/components/chat/ChatReviewBar'
import { useChatAsk } from '@/components/chat/useChatAsk'
import { useChatContext } from '@/components/chat/useChatContext'
import { focusAtEnd } from '@/components/chat/useChatFocus'
import { fmt, useDict } from '@/lib/app/useDict'
import { workspaceFolder } from '@/lib/assist/chatTools'
import { decodeChatError } from '@/lib/assist/chatTransport'
import { agentAttachmentKey, agentChatFor, useAgentStore } from '@/stores/agent/agentStore'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useChatStore } from '@/stores/assist/chatStore'
import { retryPendingFocus } from '@/stores/workspaces/surfaceSlotsStore'
import { AgentComposer } from './AgentComposer'

const NO_ATTACHMENTS: ChatContextItem[] = []
const NO_STOPPED: ReadonlySet<string> = new Set()
const NO_CHECKPOINTS: ReadonlySet<string> = new Set()

export function AgentView({
  workspaceId,
  sessionId,
  focusRef,
  manager = false,
}: {
  workspaceId: string
  sessionId: string
  focusRef: MutableRefObject<HTMLElement | null>
  manager?: boolean
}): JSX.Element {
  const d = useDict()
  const chat = useMemo(() => agentChatFor(sessionId), [sessionId])
  const helpers = useChat({ chat })
  const { messages, status, error } = helpers
  const key = agentAttachmentKey(workspaceId)
  const attachments = useChatStore((s) => s.attachments[key] ?? NO_ATTACHMENTS)
  const draftSeed = useChatStore((s) => s.drafts[key])
  const model = useAgentStore((s) => s.models[sessionId])
  const providers = useSettingsStore((s) => s.agent.providers)
  const [draft, setDraft] = useState('')
  const [picking, setPicking] = useState(false)
  const areaRef = useRef<HTMLTextAreaElement>(null)
  const busy = status === 'submitted' || status === 'streaming'
  const labels = d.ask.context
  const context = useChatContext({ workspaceId, labels })
  const { ask, willRedact } = useChatAsk({
    workspaceId,
    sessionId,
    chatKey: key,
    labels,
    context,
    attachments,
    draft,
    setDraft,
    busy,
    editing: null,
    setEditing: () => undefined,
    chat: helpers,
    setNotice: () => undefined,
    setCard: () => undefined,
  })
  const markdown = useMemo(
    () =>
      markdownComponents({
        workspaceId,
        sessionId,
        onNotice: () => undefined,
        onInserted: undefined,
      }),
    [workspaceId, sessionId],
  )
  useEffect(() => {
    focusRef.current = areaRef.current
    retryPendingFocus()
    return () => {
      focusRef.current = null
    }
  }, [focusRef])
  useEffect(() => {
    if (draftSeed === undefined) return
    const taken = useChatStore.getState().takeDraft(key)
    if (taken === undefined) return
    setDraft((prev) => (prev ? `${prev}\n${taken}` : taken))
    requestAnimationFrame(() => focusAtEnd(areaRef.current))
  }, [draftSeed, key])
  const last = messages[messages.length - 1]
  const provider = providers.find((p) => p.id === model?.provider)
  const modelName = model ? model.model : null
  const waiting =
    busy && (last?.role === 'user' || !last?.parts.some((p) => p.type !== 'step-start'))
  return (
    <div className="chat-view relative flex h-full min-h-0 flex-col bg-bg">
      <ChatReviewBar sessionId={sessionId} />
      <ChatConversation
        variant="pane"
        workspaceId={workspaceId}
        chat={helpers}
        actions={{
          quote: (text) =>
            setDraft(
              (prev) =>
                `${text
                  .trim()
                  .split('\n')
                  .map((l) => `> ${l}`)
                  .join('\n')}\n\n${prev}`,
            ),
        }}
        last={last}
        provider={null}
        empty={{
          title: manager ? PI_MANAGER_AGENT : d.agentPane.paneTitle,
          description: manager
            ? fmt(d.manager.sessionEmpty, { folder: workspaceFolder(workspaceId) })
            : modelName
              ? fmt(d.agentPane.emptyBody, {
                  model: provider ? `${provider.name} · ${modelName}` : modelName,
                })
              : d.agentPane.noProvider,
        }}
        options={{}}
        markdown={markdown}
        busy={busy}
        stopped={NO_STOPPED}
        editing={null}
        checkpoints={NO_CHECKPOINTS}
        card={null}
        waiting={waiting}
        errorInfo={error ? decodeChatError(error.message) : null}
        ask={ask}
        setNotice={() => undefined}
        setCheckpoint={() => undefined}
        setCard={() => undefined}
      />
      <AgentComposer
        sessionId={sessionId}
        workspaceId={workspaceId}
        attachmentKey={key}
        chat={helpers}
        busy={busy}
        ready={Boolean(model)}
        draft={draft}
        setDraft={setDraft}
        areaRef={areaRef}
        picking={picking}
        setPicking={setPicking}
        attachments={attachments}
        willRedact={willRedact}
        context={context}
        ask={ask}
        onStop={() => void helpers.stop()}
        hints={manager}
      />
    </div>
  )
}
