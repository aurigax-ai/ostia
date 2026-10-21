import {
  booleanSetting,
  type CommandHandler,
  connect,
  createTranslator,
  failure,
  ok,
  startPanelServer,
} from '@aurigax-ai/ostia-extension-sdk'
import { readEnv } from '@aurigax-ai/ostia-extension-sdk/contract/appEnv'
import { AppliedStore } from './appliedStore'
import { signalCapture } from './capture'
import { EvalStore } from './evalStore'
import { folderScope } from './scope'
import { beforeCounts } from './scoreboard'
import { type SkillsCommand, skillsService } from './service'
import { SignalStore } from './signalStore'
import { RulesStore } from './store'

const PANEL_FILES = ['panel.html', 'panel.js', 'panel.css', 'base.css']

async function main(): Promise<void> {
  const ext = await connect()
  const dataDir = readEnv('EXTENSION_DATA') ?? null
  const signals = new SignalStore(dataDir, Date.now)
  const store = new RulesStore(dataDir, Date.now, (rule) => beforeCounts(rule, signals.list()))
  const applied = new AppliedStore(dataDir, Date.now)
  const evals = new EvalStore(dataDir)
  let holdout = false
  const settingsLoaded = ext.getSettings().then((values) => {
    holdout = booleanSetting(values, 'holdout', false)
  })
  ext.onSettingsChanged((values) => {
    holdout = booleanSetting(values, 'holdout', false)
  })
  const panelStarting = startPanelServer({
    dir: __dirname,
    files: PANEL_FILES,
    toolbar: (state) => ext.setPanelToolbar(state),
    handle: async (command, args, caller) => {
      const handler = panelHandlers[command]
      return handler ? handler(args, caller) : failure('unknown-command', command)
    },
  })
  let panelChanged = (): void => {}
  const changed = (): void => panelChanged()
  const translate = createTranslator()
  const redact = (texts: string[]) => ext.redact(texts)
  const workspace = async (workspaceId: string) => {
    const listed = await ext.listWorkspaces().catch(() => [])
    const found = (Array.isArray(listed) ? listed : []).find(
      (w: { workspaceId?: string }) => w.workspaceId === workspaceId,
    )
    return typeof found?.kind === 'string' && typeof found.workDir === 'string'
      ? { kind: found.kind, workDir: found.workDir }
      : null
  }
  const service = skillsService({
    store,
    signals,
    applied,
    evals,
    now: Date.now,
    holdout: () => holdout,
    complete: (system, input) => ext.agentComplete({ system, input }),
    redact,
    workspace,
    confirmDelete: (rule, locale) => {
      const t = translate(locale)
      return ext.confirm({
        title: t('delete.title'),
        message: t('delete.message', { rule }),
        confirmLabel: t('delete.confirm'),
        cancelLabel: t('cancel'),
      })
    },
    changed,
  })
  const capture = signalCapture({
    signals,
    now: Date.now,
    redact,
    workspace,
    folderScopeOf: folderScope,
    confirmForget: (locale) => {
      const t = translate(locale)
      return ext.confirm({
        title: t('forget.title'),
        message: t('forget.message'),
        confirmLabel: t('forget.confirm'),
        cancelLabel: t('cancel'),
      })
    },
    changed,
  })
  const panelHandlers: Record<string, SkillsCommand> = { ...service.panel, ...capture.panel }
  ext.onPanel(async (caller) => ({
    url: (await panelStarting).url({
      workspaceId: caller.workspaceId ?? '',
      locale: caller.locale ?? '',
    }),
  }))
  const handlers: Record<string, CommandHandler> = {
    open: async (_args, caller) => {
      await ext.openPanel(caller.workspaceId)
      return ok()
    },
    'on-session': (args, caller) => service.onSession(args, caller),
    'on-prompt': (args, caller) => capture.onPrompt(args, caller),
  }
  await settingsLoaded
  await ext.registerCommands(handlers)
  panelChanged = () => void panelStarting.then((panel) => panel.changed())
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
