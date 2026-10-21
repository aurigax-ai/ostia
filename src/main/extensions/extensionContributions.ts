import { join } from 'node:path'
import { AGENT_PLUGIN_CAPABILITY } from '@aurigax-ai/ostia-extension-sdk/contract/agentPlugins'
import type { Capability } from '@aurigax-ai/ostia-extension-sdk/contract/capabilities'
import type { ExtensionSettingValues } from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import type { IconThemeContribution } from '@aurigax-ai/ostia-extension-sdk/contract/iconTheme'
import { LANGUAGE_SERVER_CAPABILITY } from '@aurigax-ai/ostia-extension-sdk/contract/languageServers'
import type { Snippet } from '@aurigax-ai/ostia-extension-sdk/contract/snippets'
import type { AgentPluginSource } from '@aurigax-ai/ostia-extension-sdk/manifest/agentSkills'
import type { EditorLanguageSource } from '../lsp/editorLanguages'
import type { LanguageServerSource } from '../lsp/serverBinaries'
import type { ExtensionHostDeps } from './extensionHostDeps'
import type { Runtime } from './extensionRuntime'
import type { ExtensionRecord } from './extensionStore'
import type { KeymapSource } from './keymaps'
import type { LanguageSource } from './languagePacks'

export interface ExtensionContributionsHost {
  deps: Pick<ExtensionHostDeps, 'store'>
  runtimes: ReadonlyMap<string, Runtime>
  active(rt: Runtime): boolean
  pending(rt: Runtime): boolean
  record(rt: Runtime): ExtensionRecord
  granted(rt: Runtime): Capability[]
  settingValues(rt: Runtime): ExtensionSettingValues
  eager(rt: Runtime): boolean
  start(rt: Runtime): void
  changed(rt?: Runtime): void
}

export class ExtensionContributions {
  constructor(private readonly host: ExtensionContributionsHost) {}

  snippets(): { extId: string; snippets: Snippet[] }[] {
    return [...this.host.runtimes.values()]
      .filter((rt) => this.host.active(rt) && rt.ext.manifest.contributes.snippets)
      .map((rt) => ({
        extId: rt.ext.manifest.id,
        snippets: rt.ext.manifest.contributes.snippets ?? [],
      }))
  }

  completionDirs(): string[] {
    return [...this.host.runtimes.values()]
      .filter((rt) => this.host.active(rt) && rt.ext.manifest.contributes.completions)
      .map((rt) => join(rt.ext.dir, rt.ext.manifest.contributes.completions ?? ''))
  }

  languages(): LanguageSource[] {
    return [...this.host.runtimes.values()]
      .filter((rt) => this.host.active(rt))
      .flatMap((rt) =>
        (rt.ext.manifest.contributes.languages ?? []).map((language) => ({
          extId: rt.ext.manifest.id,
          dir: rt.ext.dir,
          language,
        })),
      )
  }

  keymaps(): KeymapSource[] {
    return [...this.host.runtimes.values()]
      .filter((rt) => this.host.active(rt))
      .flatMap((rt) =>
        (rt.ext.manifest.contributes.keymaps ?? []).map((keymap) => ({
          extId: rt.ext.manifest.id,
          dir: rt.ext.dir,
          keymap,
        })),
      )
  }

  editorLanguages(): EditorLanguageSource[] {
    return [...this.host.runtimes.values()]
      .filter((rt) => this.host.active(rt))
      .flatMap((rt) =>
        (rt.ext.manifest.contributes.editorLanguages ?? []).map((language) => ({
          extId: rt.ext.manifest.id,
          dir: rt.ext.dir,
          language,
        })),
      )
  }

  private languageServerState(rt: Runtime, serverId: string): LanguageServerSource['state'] {
    if (this.host.pending(rt)) return 'pending'
    const record = this.host.record(rt)
    if (!record.enabled) return 'off'
    if (!this.host.granted(rt).includes(LANGUAGE_SERVER_CAPABILITY)) return 'pending'
    return record.serversOff?.includes(serverId) ? 'off' : 'on'
  }

  languageServers(): LanguageServerSource[] {
    return [...this.host.runtimes.values()].flatMap((rt) =>
      (rt.ext.manifest.contributes.languageServers ?? []).map((server) => ({
        extId: rt.ext.manifest.id,
        extName: rt.ext.manifest.name,
        dir: rt.ext.dir,
        builtin: rt.ext.builtin,
        state: this.languageServerState(rt, server.id),
        server,
        settingValues: this.host.settingValues(rt),
      })),
    )
  }

  setLanguageServerEnabled(extId: string, serverId: string, enabled: boolean): void {
    const rt = this.host.runtimes.get(extId)
    if (!rt || this.host.pending(rt)) return
    const declared = rt.ext.manifest.contributes.languageServers ?? []
    if (!declared.some((server) => server.id === serverId)) return
    const record = this.host.record(rt)
    const off = new Set(record.serversOff ?? [])
    if (enabled) off.delete(serverId)
    else off.add(serverId)
    const { serversOff: _previous, ...kept } = record
    this.host.deps.store.set(extId, {
      ...kept,
      enabled: enabled ? true : record.enabled,
      approved: record.approved ?? [],
      ...(off.size > 0 ? { serversOff: [...off] } : {}),
    })
    if (enabled && !record.enabled && this.host.eager(rt)) this.host.start(rt)
    this.host.changed(rt)
  }

  agentPlugins(): AgentPluginSource[] {
    return [...this.host.runtimes.values()]
      .filter(
        (rt) => this.host.active(rt) && this.host.granted(rt).includes(AGENT_PLUGIN_CAPABILITY),
      )
      .map((rt) => ({
        extId: rt.ext.manifest.id,
        builtin: rt.ext.builtin,
        dir: rt.ext.dir,
        skills: rt.ext.manifest.contributes.agentSkills ?? [],
        hooks: rt.ext.manifest.contributes.agentHooks ?? [],
      }))
      .filter((source) => source.skills.length > 0 || source.hooks.length > 0)
  }

  iconThemes(): { dir: string; theme: IconThemeContribution }[] {
    return [...this.host.runtimes.values()]
      .filter((rt) => this.host.active(rt))
      .flatMap((rt) =>
        (rt.ext.manifest.contributes.iconThemes ?? []).map((theme) => ({ dir: rt.ext.dir, theme })),
      )
  }
}
