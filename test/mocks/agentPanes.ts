import { useAttentionStore } from '../../src/renderer/stores/attentionStore'
import { type CommandBlock, useBlocksStore } from '../../src/renderer/stores/blocksStore'

export function runAgentIn(paneIds: readonly string[]): () => void {
  const blocksInit = useBlocksStore.getState()
  const attentionInit = useAttentionStore.getState()
  useBlocksStore.setState((s) => ({
    running: { ...s.running, ...Object.fromEntries(paneIds.map((id) => [id, `agent-${id}`])) },
    byPane: {
      ...s.byPane,
      ...Object.fromEntries(
        paneIds.map((id) => [
          id,
          [{ id: `agent-${id}`, paneId: id, command: 'my-agent' } as unknown as CommandBlock],
        ]),
      ),
    },
  }))
  for (const id of paneIds) {
    useAttentionStore.getState().dispatch(id, { type: 'set', state: 'waiting', at: 1 })
  }
  return () => {
    useBlocksStore.setState(blocksInit, true)
    useAttentionStore.setState(attentionInit, true)
  }
}
