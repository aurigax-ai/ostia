import { useAssistStore } from '@/stores/assist/assistStore'
import { useExtensionsStore } from '@/stores/extensions/extensionsStore'
import {
  ASSIST_FEATURES,
  type AssistCatalog,
  type AssistExtensionState,
  type AssistFeatureId,
  type AssistFeatureState,
  choiceLabel,
  featureModelClass,
  sameModelRef,
} from '@shared/assist'
import { useMemo } from 'react'

export interface AssistFeatureRef {
  extId: string
  feature: AssistFeatureState
}

interface AssistView {
  overview: readonly AssistExtensionState[]
  catalog: AssistCatalog
}

function findFeature(
  { overview, catalog }: AssistView,
  id: AssistFeatureId,
): AssistFeatureRef | null {
  const owner = catalog[featureModelClass(id)]?.extId
  const candidates = owner ? overview.filter((ext) => ext.extId === owner) : overview
  for (const ext of candidates) {
    const feature = ext.features.find((f) => f.id === id)
    if (feature) return { extId: ext.extId, feature }
  }
  return null
}

export interface FeatureInUse extends AssistFeatureRef {
  model: string
}

export function featuresInUse({ overview, catalog }: AssistView): FeatureInUse[] {
  const out: FeatureInUse[] = []
  for (const id of ASSIST_FEATURES) {
    const ref = catalog[featureModelClass(id)]
    const choice = catalog.models.find((c) => sameModelRef(c.ref, ref))
    const found = ref && choice ? findFeature({ overview, catalog }, id) : null
    if (found && choice) out.push({ ...found, model: choiceLabel(choice) })
  }
  return out
}

export function assistFeature(id: AssistFeatureId): AssistFeatureRef | null {
  return findFeature(useAssistStore.getState(), id)
}

export function useAssistFeature(id: AssistFeatureId): AssistFeatureRef | null {
  const feature = useAssistStore((s) => findFeature(s, id)?.feature ?? null)
  const extId = useAssistStore((s) => findFeature(s, id)?.extId ?? null)
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

export function toggleAssistFeature(
  extId: string,
  feature: AssistFeatureState,
): Promise<string | null> {
  return useExtensionsStore.getState().setSetting(extId, feature.setting, !feature.on)
}

export function toggleCommandId(extId: string, feature: AssistFeatureState): string {
  return `assist.toggle.${extId}.${feature.id}`
}

export function chatAvailable(): boolean {
  const state = useAssistStore.getState()
  return Boolean(state.availability.chat) && featureEnabled(findFeature(state, 'chat'))
}

export function useChatAvailable(): boolean {
  return useAssistStore(
    (s) => Boolean(s.availability.chat) && featureEnabled(findFeature(s, 'chat')),
  )
}
