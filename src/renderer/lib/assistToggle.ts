import type { AssistExtensionState, AssistFeatureState } from '@shared/assist'
import { useExtensionsStore } from '../stores/extensionsStore'

export function toggleAssistFeature(
  extId: string,
  feature: AssistFeatureState,
): Promise<string | null> {
  return useExtensionsStore.getState().setSetting(extId, feature.setting, !feature.on)
}

export function toggleCommandId(extId: string, feature: AssistFeatureState): string {
  return `assist.toggle.${extId}.${feature.id}`
}

export function primaryAssistExtension(
  overview: readonly AssistExtensionState[],
): AssistExtensionState | null {
  return overview[0] ?? null
}
