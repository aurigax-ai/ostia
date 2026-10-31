import { createHash } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { shellEnv } from '@aurigax-ai/ostia-extension-sdk/contract/appEnv'
import { PRODUCT_NAME } from '@aurigax-ai/ostia-extension-sdk/contract/product'
import { AGENT_HOOKS_OFF_ENV } from '../../shared/agents/agentHooks'
import { CLI_RUN, IN_PANE } from './agentHookCommands'
import { installGenerated, removeUntouchedGenerations } from './generatedFolder'

const AGY_PLUGIN_PREFIX = 'ostia-'
const AGY_PLUGIN_FILES = ['plugin.json', 'hooks.json']

const HOOKS_ON = `[ -z "${shellEnv(AGENT_HOOKS_OFF_ENV.agy)}" ]`

function agyHookCommand(cliArgs: string): string {
  return `${IN_PANE} && ${HOOKS_ON} && ${CLI_RUN} ${cliArgs} >/dev/null 2>&1; echo '{}'`
}

const commandHook = (command: string) => ({ type: 'command', command })

export function agyHooksJson(): string {
  const hooks = {
    [PRODUCT_NAME]: {
      SessionStart: [commandHook(agyHookCommand('resume-token agy -'))],
      PreInvocation: [
        commandHook(agyHookCommand('resume-token agy -')),
        commandHook(agyHookCommand('state working')),
      ],
      Stop: [commandHook(agyHookCommand('state done --stop'))],
    },
  }
  return `${JSON.stringify(hooks, null, 2)}\n`
}

function agyPluginJson(): string {
  return `${JSON.stringify({ name: PRODUCT_NAME, description: `${PRODUCT_NAME} start signal, resume token and attention state; does nothing outside a ${PRODUCT_NAME} pane.` }, null, 2)}\n`
}

export function agyPluginDigest(): string {
  return createHash('sha256')
    .update(agyPluginJson())
    .update(agyHooksJson())
    .digest('hex')
    .slice(0, 16)
}

export function installAgyPlugin(configDir: string): string | null {
  if (!existsSync(configDir)) return null
  const root = join(configDir, 'plugins')
  const dir = join(root, `${AGY_PLUGIN_PREFIX}${agyPluginDigest()}`)
  installGenerated(root, dir, AGY_PLUGIN_FILES, (staging) => {
    writeFileSync(join(staging, 'plugin.json'), agyPluginJson(), 'utf8')
    writeFileSync(join(staging, 'hooks.json'), agyHooksJson(), 'utf8')
  })
  removeUntouchedGenerations(root, new Set([dir]), Number.POSITIVE_INFINITY)
  return dir
}
