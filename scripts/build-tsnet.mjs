import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const moduleDir = join(root, 'tsnet-helper')
const outDir = join(root, 'out', 'tsnet')
const goos = process.env.GOOS ?? { win32: 'windows', darwin: 'darwin' }[process.platform] ?? 'linux'
const output = join(outDir, goos === 'windows' ? 'ostia-tsnet.exe' : 'ostia-tsnet')

const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const goVersion = readFileSync(join(moduleDir, 'go.mod'), 'utf8').match(/^go (\S+)$/m)?.[1]
const go = process.env.GO ?? 'go'

mkdirSync(outDir, { recursive: true })
const result = spawnSync(
  go,
  ['build', '-trimpath', '-ldflags', `-s -w -X main.version=${version}`, '-o', output, '.'],
  {
    cwd: moduleDir,
    stdio: 'inherit',
    env: { ...process.env, CGO_ENABLED: '0' },
  },
)

if (result.error?.code === 'ENOENT') {
  console.error(
    `build-tsnet: Go was not found (${go}). Install Go ${goVersion} (pinned in tsnet-helper/go.mod) to build ostia-tsnet.`,
  )
  process.exit(1)
}
if (result.error) {
  console.error(`build-tsnet: ${result.error.message}`)
  process.exit(1)
}
if (result.status !== 0) process.exit(result.status ?? 1)
