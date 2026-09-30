import type { AssistExtensionState, AssistFeatureId, AssistFeatureState } from '@shared/assist'
import { useMemo } from 'react'
import { useAssistStore } from '../stores/assistStore'
import { useExtensionsStore } from '../stores/extensionsStore'

export interface AssistFeatureRef {
  extId: string
  feature: AssistFeatureState
}

function findFeature(
  overview: readonly AssistExtensionState[],
  id: AssistFeatureId,
): AssistFeatureRef | null {
  for (const ext of overview) {
    const feature = ext.features.find((f) => f.id === id)
    if (feature) return { extId: ext.extId, feature }
  }
  return null
}

export function assistFeature(id: AssistFeatureId): AssistFeatureRef | null {
  return findFeature(useAssistStore.getState().overview, id)
}

export function useAssistFeature(id: AssistFeatureId): AssistFeatureRef | null {
  const feature = useAssistStore((s) => findFeature(s.overview, id)?.feature ?? null)
  const extId = useAssistStore((s) => findFeature(s.overview, id)?.extId ?? null)
  return useMemo(() => (feature && extId ? { extId, feature } : null), [feature, extId])
}

export function featureEnabled(ref: AssistFeatureRef | null): boolean {
  return ref === null || ref.feature.on
}

export function setAssistFeature(id: AssistFeatureId, on: boolean): Promise<string | null> {
  const ref = assistFeature(id)
  if (!ref) return Promise.resolve('unknown-feature')
  return useExtensionsStore.getState().setSetting(ref.extId, ref.feature.setting, on)
}
