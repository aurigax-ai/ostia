import { execFileSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { vendoredPackages } from '../marketplace-package/build-extension.mjs'
import { marketplaceIds, marketplaceProject } from './marketplace.mjs'

const out = 'out/marketplace'
const sdk = 'out/sdk'
const sdkName = '@aurigax-ai/ostia-extension-sdk'
const repository = 'https://github.com/aurigax-ai/ostia-extensions'
const toolFixtures = 'test/fixtures/tools'
const app = JSON.parse(readFileSync('package.json', 'utf8'))
const versionOf = (name) => app.dependencies[name] ?? app.devDependencies[name]
const ids = marketplaceIds()
const vendored = ids.flatMap((id) => {
  const { packages, closures } = vendoredPackages(join('src/extensions', id))
  return [...Object.keys(packages), ...Object.keys(closures)]
})
const dependencies = [
  ...new Set([
    '@ai-sdk-tool/parser',
    '@ai-sdk/openai-compatible',
    '@phosphor-icons/core',
    '@types/node',
    'ai',
    'esbuild',
    'mdast-util-from-markdown',
    'mdast-util-gfm',
    'micromark-extension-gfm',
    'typescript',
    'undici',
    'vitest',
    'zod',
    ...vendored,
  ]),
].sort()

if (!existsSync(join(sdk, 'package.json'))) {
  console.error(`${sdk} is missing: run pnpm build:sdk first`)
  process.exit(1)
}

rmSync(out, { recursive: true, force: true })
cpSync(marketplaceProject, out, { recursive: true })
cpSync('LICENSE', join(out, 'LICENSE'))
for (const id of ids) {
  cpSync(join('src/extensions', id), join(out, 'src/extensions', id), { recursive: true })
}
cpSync(toolFixtures, join(out, toolFixtures), { recursive: true })

writeFileSync(
  join(out, 'package.json'),
  `${JSON.stringify(
    {
      name: 'ostia-extensions',
      version: app.version,
      private: true,
      description: 'Extensions for Ostia that are not built in',
      license: app.license,
      repository: { type: 'git', url: `git+${repository}.git` },
      packageManager: app.packageManager,
      engines: { node: '>=20' },
      scripts: {
        build: 'node build.mjs',
        typecheck: 'tsc --noEmit',
        test: 'vitest run',
        validate: 'ostia-extension validate .',
      },
      devDependencies: {
        [sdkName]: app.version,
        ...Object.fromEntries(dependencies.map((name) => [name, versionOf(name)])),
      },
    },
    null,
    2,
  )}\n`,
)

const sdkLink = join(out, 'node_modules', sdkName)
mkdirSync(dirname(sdkLink), { recursive: true })
symlinkSync(resolve(sdk), sdkLink, 'dir')

execFileSync(process.execPath, ['build.mjs'], { cwd: out, stdio: 'inherit' })
