import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { openWorkspace, quitApp, runInTerminal, terminalTab } from './helpers'
import { type ElectronApplication, _electron as electron, expect, test } from './test'

const PACKAGED = process.env.OSTIA_E2E_PACKAGED ?? ''
const PREVIEW_URL = 'ostia-preview://'

const WIDGET = `import { useState } from 'react'
import { createPortal } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { Line, LineChart } from 'recharts'
import { Rocket } from 'lucide-react'
import { HeartIcon } from '@phosphor-icons/react'
import { max } from 'd3'
import Papa from 'papaparse'
import initSqlJs from 'sql.js'

const rows = Papa.parse('y\\n1\\n2', { header: true, dynamicTyping: true }).data

export default function Widget() {
  const [count] = useState(3)
  document.title = 'widget ' + count + ' ' + max(rows, (r) => r.y) + ' ' + typeof createPortal + ' ' + typeof createRoot + ' ' + typeof initSqlJs
  return (
    <div className="p-4">
      <Rocket />
      <HeartIcon />
      <LineChart width={200} height={80} data={[{ y: 1 }, { y: 2 }]}>
        <Line dataKey="y" isAnimationActive={false} />
      </LineChart>
    </div>
  )
}
`

const PAGE = `<!doctype html><title>loading</title>
<script type="module">
import * as d3 from 'd3'
document.title = 'd3 max ' + d3.max([1, 7, 3])
</script>
`

function guestTitle(app: ElectronApplication): Promise<string | null> {
  return app.evaluate(
    ({ webContents }, prefix) =>
      webContents
        .getAllWebContents()
        .find((wc) => wc.getURL().startsWith(prefix))
        ?.getTitle() ?? null,
    PREVIEW_URL,
  )
}

test('PRT-C23 the packaged app builds a component with every runtime library from its package tree', async () => {
  test.skip(PACKAGED === '', 'runs only against a packaged build: OSTIA_E2E_PACKAGED=<executable>')
  test.setTimeout(180_000)
  const resources = join(dirname(PACKAGED), 'resources')
  const tree = join(resources, 'artifact-runtime', 'node_modules')
  for (const name of [
    'react',
    'react-dom',
    'recharts',
    'lucide-react',
    '@phosphor-icons/react',
    'd3',
    'papaparse',
    'sql.js',
    'tailwindcss',
  ]) {
    expect(existsSync(join(tree, name, 'package.json')), name).toBe(true)
  }
  expect(existsSync(join(resources, 'artifact-runtime', 'react.js'))).toBe(false)
  expect(existsSync(join(resources, 'artifact-runtime', 'tailwind.js'))).toBe(false)
  const binary = join(
    resources,
    'app.asar.unpacked',
    'node_modules',
    '@esbuild',
    `${process.platform}-${process.arch}`,
    'bin',
    'esbuild',
  )
  expect(statSync(binary).mode & 0o111).not.toBe(0)

  const dataHome = freshDataHome()
  const home = join(dataHome, 'home')
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'Widget.tsx'), WIDGET)
  writeFileSync(join(home, 'page.html'), PAGE)
  writeFileSync(join(home, 'Broken.tsx'), 'export default function Broken() {\n  return <div>\n}\n')
  const launch = isolatedLaunch(dataHome)
  const app = await electron.launch({
    executablePath: PACKAGED,
    args: launch.args.filter((arg) => arg !== '.'),
    env: launch.env,
  })
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    expect(await app.evaluate(({ app: electronApp }) => electronApp.isPackaged)).toBe(true)
    await openWorkspace(win)
    await runInTerminal(
      win,
      'cp ~/Widget.tsx ~/page.html ~/Broken.tsx "$OSTIA_ARTIFACTS/" && ostia open "$OSTIA_ARTIFACTS/Widget.tsx"',
    )
    await expect
      .poll(() => guestTitle(app), { timeout: 60_000 })
      .toBe('widget 3 2 function function function')
    await expect(win.getByTestId('preview-errors')).toHaveCount(0)
    expect(
      await app.evaluate(() => process.env.ESBUILD_BINARY_PATH ?? null),
      'the compiler path never stays in the app environment',
    ).toBeNull()

    await terminalTab(win).click()
    await runInTerminal(
      win,
      'echo "esbuild-env:[${ESBUILD_BINARY_PATH}]"; ostia open "$OSTIA_ARTIFACTS/page.html"',
    )
    await expect.poll(() => guestTitle(app), { timeout: 60_000 }).toBe('d3 max 7')
    await terminalTab(win).click()
    await expect(win.locator('.xterm-rows').first()).toContainText('esbuild-env:[]')

    await runInTerminal(win, 'ostia open "$OSTIA_ARTIFACTS/Broken.tsx"')
    await expect(win.getByTestId('preview-errors')).toContainText(/Broken\.tsx:3:\d+:/, {
      timeout: 60_000,
    })
  } finally {
    await quitApp(app)
  }
})
