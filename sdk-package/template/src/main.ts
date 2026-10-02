import { cliArgs, connect, createTranslator, failure, ok } from '@aurigax-ai/pine-extension-sdk'

async function main(): Promise<void> {
  const ext = await connect()
  const translate = createTranslator()
  await ext.registerCommands({
    greet: async (args, caller) => {
      const t = translate(caller.locale)
      const name = cliArgs(args)?.argv[0]
      if (!name) return failure('invalid-args', t('usage'))
      const greeting = t('greeting', { name })
      await ext.notify(t('greetingTitle'), greeting)
      return ok(greeting, { name })
    },
    'agent-hook': async (args, caller) => {
      const event = cliArgs(args)?.argv[1]
      return event === 'SessionStart' ? ok(translate(caller.locale)('agentContext')) : ok()
    },
  })
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
