import { runSdkCli } from './sdkCli'

const result = runSdkCli(process.argv.slice(2))
const print = result.code === 0 ? console.log : console.error
for (const line of result.lines) print(line)
process.exit(result.code)
