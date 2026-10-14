import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const HERE = __dirname
const REPO = resolve(HERE, '../../..')
const ENGINE_PACKAGE = join(REPO, 'node_modules/@aurigax-ai/graph')
const ENGINE = join(ENGINE_PACKAGE, 'src')

function files(dir: string, test: (name: string) => boolean): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return files(path, test)
    return test(name) ? [path] : []
  })
}

const sources = (dir: string) => files(dir, (n) => n.endsWith('.ts') && !n.endsWith('.test.ts'))
const read = (path: string) => readFileSync(path, 'utf8')
const extensionSource = sources(HERE).filter((f) => !f.endsWith('fakeExt.ts'))
const runtimeSource = [
  ...extensionSource,
  ...sources(ENGINE).filter((f) => !/fakeHost|fixtures|contractSuite/.test(f)),
]

function skillSection(): string {
  const skill = read(join(REPO, 'src/main/agents/skills/ostia/SKILL.md'))
  const start = skill.indexOf('## Graphs')
  return skill.slice(start, skill.indexOf('\n## ', start + 1))
}

function catalogText(): string {
  return [
    read(join(HERE, 'ostia.json')),
    read(join(HERE, 'locales/en.json')),
    read(join(HERE, 'locales/zh-Hant.json')),
  ].join('\n')
}

describe('what the graphs extension may do', () => {
  it('GRF-C3 nothing it runs writes, renames or deletes a file but its own data files', () => {
    const WRITES =
      /\b(writeFileSync|writeFile|appendFileSync|appendFile|rmSync|rm|unlinkSync|unlink|renameSync|rename|mkdirSync|copyFileSync|createWriteStream|openSync\([^)]*'a')\(/
    const writers = runtimeSource
      .filter((f) => WRITES.test(read(f)))
      .map((f) => f.slice(REPO.length + 1))
    expect(writers.sort()).toEqual([
      'node_modules/@aurigax-ai/graph/src/engine/fileStore.ts',
      'src/extensions/graphs/enabled.ts',
    ])
    expect(read(join(HERE, 'enabled.ts'))).not.toContain('graphsFolder')
    expect(read(join(ENGINE, 'engine/fileStore.ts'))).not.toContain('.ostia')
  })

  it('GRF-C4 no surveyed engine is a dependency of the bundle, the engine or the app', () => {
    const names = ['@langchain/', 'langsmith', 'xstate', '@mastra/', '@temporalio/', '@restatedev/']
    const bundle = join(REPO, 'out/extensions/graphs/main.js')
    const texts = [read(join(REPO, 'package.json')), read(join(ENGINE_PACKAGE, 'package.json'))]
    if (existsSync(bundle)) texts.push(read(bundle))
    expect(texts).toHaveLength(3)
    for (const text of texts) for (const name of names) expect(text).not.toContain(name)
  })

  it('GRF-C5 it never types into, reads, closes or kills a pane, opens a plain terminal or changes a setting', () => {
    const FORBIDDEN = [
      "'pane.input'",
      "'pane.read'",
      "'pane.close'",
      "'process.run'",
      "'process.kill'",
      "'settings.set'",
      "'pane.setAttention'",
      '.offerToAgent(',
      '.openTerminal(',
      '.setAttention(',
      '.callAs(',
      'ext.call(',
      '.setSetting(',
    ]
    for (const file of extensionSource) {
      const text = read(file)
      for (const word of FORBIDDEN) expect(text.includes(word), `${file} uses ${word}`).toBe(false)
    }
  })

  it('GRF-C7 it never claims to run while Ostia is closed and the panel says it runs while Ostia is open', () => {
    const text = `${catalogText()}\n${skillSection()}`.toLowerCase()
    for (const claim of ['always running', '24/7', 'in the background while closed'])
      expect(text).not.toContain(claim)
    expect(JSON.parse(read(join(HERE, 'locales/en.json'))).messages.runsWhileOpen).toContain(
      'while Ostia is open',
    )
    expect(read(join(HERE, 'panel.ts'))).toContain("t('runsWhileOpen')")
  })

  it('GRF-C143 every English key has a Traditional Chinese one and the feature is 狀態圖 there', () => {
    const en = JSON.parse(read(join(HERE, 'locales/en.json'))).messages as Record<string, string>
    const zh = JSON.parse(read(join(HERE, 'locales/zh-Hant.json'))) as {
      manifest: Record<string, string>
      messages: Record<string, string>
    }
    expect(Object.keys(en).filter((k) => !(k in zh.messages))).toEqual([])
    expect(zh.manifest.name).toBe('狀態圖')
    expect(zh.messages.title).toBe('狀態圖')
    expect(JSON.stringify(zh)).not.toContain('線圖')
  })

  it('GRF-C150 core has no graph command, setting or export of its own, and the feature is never a workflow, job or flow', () => {
    const core = files(
      join(REPO, 'src'),
      (n) => /\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n),
    ).filter((f) => !f.includes('/extensions/graphs/') && !f.includes('/extensions/sdk/'))
    for (const file of core.filter((f) => f.includes('/renderer/commands/'))) {
      expect(read(file)).not.toMatch(/id: 'graphs?\./)
    }
    const dict = read(join(REPO, 'src/shared/app/dict.ts'))
    expect(dict).not.toMatch(/^\s{4}graphs?: \{/m)
    const owned = core.filter(
      (f) =>
        (f.includes('/src/shared/') || f.includes('/src/main/')) &&
        !/\/git\/|boards\/git|ports/.test(f),
    )
    for (const file of owned)
      expect(read(file), file).not.toMatch(/^export (?:function|const|interface|type|class) Graph/m)
    expect(read(join(REPO, 'src/cli/verbs/coreBoards.ts'))).not.toMatch(/case 'graph'/)
    const words = `${catalogText()}\n${skillSection()}`.toLowerCase()
    for (const word of ['workflow', ' job', 'flow ']) expect(words).not.toContain(word)
  })
})
