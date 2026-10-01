import { cliArgs, connect, failure, ok } from '@aurigax-ai/pine-extension-sdk'

async function main(): Promise<void> {
  const ext = await connect()
  await ext.registerCommands({
    greet: async (args) => {
      const name = cliArgs(args)?.argv[0]
      if (!name) return failure('invalid-args', 'greet <name>')
      await ext.notify('Hello', `Hello, ${name}`)
      return ok(`Hello, ${name}`, { name })
    },
  })
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
