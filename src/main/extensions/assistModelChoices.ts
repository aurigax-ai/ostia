import {
  ASSIST_POINTS,
  type AssistModelChoice,
  type AssistModelClass,
  type AssistModelRef,
  type AssistModelSettings,
  type AssistPoint,
  modelClassOf,
  sameModelRef,
} from '@aurigax-ai/ostia-extension-sdk/contract/assist'
import type { Capability } from '@aurigax-ai/ostia-extension-sdk/contract/capabilities'
import type { Runtime } from './extensionRuntime'

export interface AssistModelChoicesHost {
  runtimes: ReadonlyMap<string, Runtime>
  active(rt: Runtime): boolean
  granted(rt: Runtime): Capability[]
  shownName(rt: Runtime): string
  settings(): AssistModelSettings
}

export class AssistModelChoices {
  constructor(private readonly host: AssistModelChoicesHost) {}

  servesAssist(rt: Runtime): boolean {
    return (
      this.host.active(rt) &&
      rt.conn !== null &&
      rt.assistReport !== null &&
      this.host.granted(rt).includes('assist')
    )
  }

  modelChoices(): AssistModelChoice[] {
    const out: AssistModelChoice[] = []
    for (const rt of this.host.runtimes.values()) {
      const report = rt.assistReport
      if (!report || !this.servesAssist(rt)) continue
      const extId = rt.ext.manifest.id
      const points = ASSIST_POINTS.filter(
        (point) =>
          rt.ext.manifest.contributes.assist.includes(point) &&
          rt.assistStatus[point]?.ready === true,
      )
      if (!report.providers) {
        const name = this.host.shownName(rt)
        const tools = rt.assistStatus.chat?.tools
        const choice = { ref: { extId }, group: name, label: report.label ?? name, points }
        out.push(tools ? { ...choice, tools } : choice)
        continue
      }
      for (const provider of report.providers) {
        if (provider.setup !== null) continue
        for (const model of provider.models) {
          const choice: AssistModelChoice = {
            ref: { extId, provider: provider.id, model: model.id },
            group: provider.name,
            label: model.id,
            points,
          }
          out.push(model.tools ? { ...choice, tools: model.tools } : choice)
        }
      }
    }
    return out
  }

  private offers(extId: string, modelClass: AssistModelClass): boolean {
    const assist = this.host.runtimes.get(extId)?.ext.manifest.contributes.assist ?? []
    return assist.some((point) => modelClassOf(point) === modelClass)
  }

  selectedChoice(
    modelClass: AssistModelClass,
    choices: AssistModelChoice[],
  ): AssistModelChoice | null {
    const eligible = choices.filter((c) => this.offers(c.ref.extId, modelClass))
    const wanted =
      modelClass === 'chat' ? this.host.settings().chatModel : this.host.settings().fastModel
    if (wanted) return eligible.find((c) => sameModelRef(c.ref, wanted)) ?? null
    return eligible[0] ?? null
  }

  assistTarget(
    point: AssistPoint,
    explicit: AssistModelRef | null,
  ): { rt: Runtime; choice: AssistModelChoice } | null {
    const choices = this.modelChoices()
    const choice = explicit
      ? choices.find((c) => sameModelRef(c.ref, explicit))
      : this.selectedChoice(modelClassOf(point), choices)
    if (!choice?.points.includes(point)) return null
    const rt = this.host.runtimes.get(choice.ref.extId)
    return rt ? { rt, choice } : null
  }
}
