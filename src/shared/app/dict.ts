import { PRODUCT_PLACEHOLDER } from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import type { LanguageCatalog } from '@aurigax-ai/ostia-extension-sdk/contract/languagePack'
import { PRODUCT_DISPLAY_NAME } from '@aurigax-ai/ostia-extension-sdk/contract/productDisplay'
import { agentEn } from '../strings/agentEn'
import { agentZhHant } from '../strings/agentZhHant'
import { appEn } from '../strings/appEn'
import { appZhHant } from '../strings/appZhHant'
import { assistantEn } from '../strings/assistantEn'
import { assistantZhHant } from '../strings/assistantZhHant'
import { browserEn } from '../strings/browserEn'
import { browserZhHant } from '../strings/browserZhHant'
import { chatToolsEn } from '../strings/chatToolsEn'
import { chatToolsZhHant } from '../strings/chatToolsZhHant'
import { commandsEn } from '../strings/commandsEn'
import { commandsZhHant } from '../strings/commandsZhHant'
import { extensionsEn } from '../strings/extensionsEn'
import { extensionsZhHant } from '../strings/extensionsZhHant'
import { filesEn } from '../strings/filesEn'
import { filesZhHant } from '../strings/filesZhHant'
import { playbooksEn } from '../strings/playbooksEn'
import { playbooksZhHant } from '../strings/playbooksZhHant'
import { securityEn } from '../strings/securityEn'
import { securityZhHant } from '../strings/securityZhHant'
import { serverEn } from '../strings/serverEn'
import { serverZhHant } from '../strings/serverZhHant'
import { settingsEn } from '../strings/settingsEn'
import { settingsZhHant } from '../strings/settingsZhHant'
import { sharesEn } from '../strings/sharesEn'
import { sharesZhHant } from '../strings/sharesZhHant'
import { terminalEn } from '../strings/terminalEn'
import { terminalZhHant } from '../strings/terminalZhHant'
import { workspacesEn } from '../strings/workspacesEn'
import { workspacesZhHant } from '../strings/workspacesZhHant'

export type Locale = string

export const en = {
  formats: appEn.formats,
  agentPane: agentEn.agentPane,
  claudeAccounts: agentEn.claudeAccounts,
  commands: commandsEn.commands,
  assistMenu: assistantEn.assistMenu,
  search: commandsEn.search,
  rail: workspacesEn.rail,
  attention: workspacesEn.attention,
  mail: workspacesEn.mail,
  languageServers: extensionsEn.languageServers,
  languageNotice: appEn.languageNotice,
  workzone: workspacesEn.workzone,
  riskyPaste: terminalEn.riskyPaste,
  sandbox: securityEn.sandbox,
  pane: workspacesEn.pane,
  palette: commandsEn.palette,
  topbar: workspacesEn.topbar,
  window: appEn.window,
  blocks: terminalEn.blocks,
  history: terminalEn.history,
  snippets: terminalEn.snippets,
  inputEditor: terminalEn.inputEditor,
  prompt: terminalEn.prompt,
  find: terminalEn.find,
  editor: filesEn.editor,
  crash: appEn.crash,
  diff: filesEn.diff,
  browser: browserEn.browser,
  browserStorage: browserEn.browserStorage,
  send: terminalEn.send,
  agentOffer: assistantEn.agentOffer,
  update: appEn.update,
  passwords: browserEn.passwords,
  scriptTokens: securityEn.scriptTokens,
  actions: commandsEn.actions,
  views: workspacesEn.views,
  agentSession: assistantEn.agentSession,
  artifacts: filesEn.artifacts,
  inbox: workspacesEn.inbox,
  approvals: assistantEn.approvals,
  remoteFolders: filesEn.remoteFolders,
  filesView: filesEn.filesView,
  fileMenu: commandsEn.fileMenu,
  openFile: filesEn.openFile,
  portable: appEn.portable,
  preview: filesEn.preview,
  viewer: filesEn.viewer,
  marketplace: extensionsEn.marketplace,
  git: filesEn.git,
  ports: terminalEn.ports,
  playbooks: playbooksEn,
  extensions: extensionsEn.extensions,
  extensionsBrowse: extensionsEn.extensionsBrowse,
  workspaceSettings: settingsEn.workspaceSettings,
  privacy: securityEn.privacy,
  manager: workspacesEn.manager,
  requirements: appEn.requirements,
  closeConfirm: workspacesEn.closeConfirm,
  appMenu: appEn.appMenu,
  scratch: workspacesEn.scratch,
  merge: workspacesEn.merge,
  hibernateSkipped: workspacesEn.hibernateSkipped,
  tabSleepNotice: workspacesEn.tabSleepNotice,
  tabMove: workspacesEn.tabMove,
  cmuxImport: appEn.cmuxImport,
  sync: appEn.sync,
  server: serverEn.server,
  shares: sharesEn.shares,
  syncServer: serverEn.syncServer,
  browserSettings: settingsEn.browserSettings,
  editorSettings: settingsEn.editorSettings,
  keyboard: commandsEn.keyboard,
  terminalMenu: commandsEn.terminalMenu,
  terminalLinks: terminalEn.terminalLinks,
  terminalGhost: terminalEn.terminalGhost,
  assist: assistantEn.assist,
  ask: assistantEn.ask,
  chatActions: assistantEn.chatActions,
  chat: assistantEn.chat,
  chatSlash: assistantEn.chatSlash,
  chatTools: chatToolsEn.chatTools,
  assistantSettings: chatToolsEn.assistantSettings,
  settings: settingsEn.settings,
  native: appEn.native,
}

export type Dict = typeof en

export const zhHant: Dict = {
  formats: appZhHant.formats,
  agentPane: agentZhHant.agentPane,
  claudeAccounts: agentZhHant.claudeAccounts,
  commands: commandsZhHant.commands,
  assistMenu: assistantZhHant.assistMenu,
  search: commandsZhHant.search,
  rail: workspacesZhHant.rail,
  attention: workspacesZhHant.attention,
  mail: workspacesZhHant.mail,
  languageServers: extensionsZhHant.languageServers,
  languageNotice: appZhHant.languageNotice,
  workzone: workspacesZhHant.workzone,
  riskyPaste: terminalZhHant.riskyPaste,
  sandbox: securityZhHant.sandbox,
  pane: workspacesZhHant.pane,
  palette: commandsZhHant.palette,
  topbar: workspacesZhHant.topbar,
  window: appZhHant.window,
  blocks: terminalZhHant.blocks,
  history: terminalZhHant.history,
  snippets: terminalZhHant.snippets,
  inputEditor: terminalZhHant.inputEditor,
  prompt: terminalZhHant.prompt,
  find: terminalZhHant.find,
  editor: filesZhHant.editor,
  crash: appZhHant.crash,
  diff: filesZhHant.diff,
  browser: browserZhHant.browser,
  browserStorage: browserZhHant.browserStorage,
  send: terminalZhHant.send,
  agentOffer: assistantZhHant.agentOffer,
  update: appZhHant.update,
  passwords: browserZhHant.passwords,
  scriptTokens: securityZhHant.scriptTokens,
  actions: commandsZhHant.actions,
  views: workspacesZhHant.views,
  agentSession: assistantZhHant.agentSession,
  artifacts: filesZhHant.artifacts,
  inbox: workspacesZhHant.inbox,
  approvals: assistantZhHant.approvals,
  remoteFolders: filesZhHant.remoteFolders,
  filesView: filesZhHant.filesView,
  fileMenu: commandsZhHant.fileMenu,
  openFile: filesZhHant.openFile,
  portable: appZhHant.portable,
  preview: filesZhHant.preview,
  viewer: filesZhHant.viewer,
  marketplace: extensionsZhHant.marketplace,
  git: filesZhHant.git,
  ports: terminalZhHant.ports,
  playbooks: playbooksZhHant,
  extensions: extensionsZhHant.extensions,
  extensionsBrowse: extensionsZhHant.extensionsBrowse,
  workspaceSettings: settingsZhHant.workspaceSettings,
  privacy: securityZhHant.privacy,
  manager: workspacesZhHant.manager,
  requirements: appZhHant.requirements,
  closeConfirm: workspacesZhHant.closeConfirm,
  appMenu: appZhHant.appMenu,
  scratch: workspacesZhHant.scratch,
  merge: workspacesZhHant.merge,
  hibernateSkipped: workspacesZhHant.hibernateSkipped,
  tabSleepNotice: workspacesZhHant.tabSleepNotice,
  tabMove: workspacesZhHant.tabMove,
  cmuxImport: appZhHant.cmuxImport,
  sync: appZhHant.sync,
  server: serverZhHant.server,
  shares: sharesZhHant.shares,
  syncServer: serverZhHant.syncServer,
  browserSettings: settingsZhHant.browserSettings,
  editorSettings: settingsZhHant.editorSettings,
  keyboard: commandsZhHant.keyboard,
  terminalMenu: commandsZhHant.terminalMenu,
  terminalLinks: terminalZhHant.terminalLinks,
  terminalGhost: terminalZhHant.terminalGhost,
  assist: assistantZhHant.assist,
  ask: assistantZhHant.ask,
  chatActions: assistantZhHant.chatActions,
  chat: assistantZhHant.chat,
  chatSlash: assistantZhHant.chatSlash,
  chatTools: chatToolsZhHant.chatTools,
  assistantSettings: chatToolsZhHant.assistantSettings,
  settings: settingsZhHant.settings,
  native: appZhHant.native,
}

export function withProductName(text: string, product: string = PRODUCT_DISPLAY_NAME): string {
  return text.split(PRODUCT_PLACEHOLDER).join(product)
}

export function fmt(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`))
}

type Strings = { [key: string]: string | Strings }

function mergeStrings(base: Strings, catalog: LanguageCatalog | undefined): Strings {
  const out: Strings = {}
  for (const [key, value] of Object.entries(base)) {
    const translated = catalog && Object.hasOwn(catalog, key) ? catalog[key] : undefined
    if (typeof value === 'string') {
      out[key] = withProductName(typeof translated === 'string' ? translated : value)
    } else {
      out[key] = mergeStrings(value, typeof translated === 'object' ? translated : undefined)
    }
  }
  return out
}

export function mergeCatalog(catalog: LanguageCatalog): Dict {
  return mergeStrings(en as unknown as Strings, catalog) as unknown as Dict
}
