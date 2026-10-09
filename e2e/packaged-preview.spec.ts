import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { openWorkspace, quitApp, runInTerminal } from './helpers'
import { type ElectronApplication, _electron as electron, expect, test } from './test'

const PACKAGED = process.env.OSTIA_E2E_PACKAGED ?? ''
const PREVIEW_URL = 'ostia-preview://'

const WIDGET = `import { useState } from 'react'
import { Line, LineChart } from 'recharts'
import { Rocket } from 'lucide-react'

export default function Widget() {
  const [count] = useState(3)
  document.title = 'widget ' + count
  return (
    <div className="p-4">
      <Rocket />
      <LineChart width={200} height={80} data={[{ y: 1 }, { y: 2 }]}>
        <Line dataKey="y" isAnimationActive={false} />
      </LineChart>
    </div>
  )
}
`

const PAGE = `<!doctype html><title>loading</title>
<script type="module">
import * as d3 from '/runtime/d3.js'
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

test('the packaged app compiles a component, serves the bundled runtime and reports a compile error', async () => {
  test.skip(PACKAGED === '', 'runs only against a packaged build: OSTIA_E2E_PACKAGED=<executable>')
  test.setTimeout(180_000)
  const resources = join(dirname(PACKAGED), 'resources')
  expect(existsSync(join(resources, 'artifact-runtime', 'react.js'))).toBe(true)
  expect(existsSync(join(resources, 'artifact-runtime', 'tailwind.js'))).toBe(true)
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
    await expect.poll(() => guestTitle(app), { timeout: 60_000 }).toBe('widget 3')
    await expect(win.getByTestId('preview-errors')).toHaveCount(0)
    expect(
      await app.evaluate(() => process.env.ESBUILD_BINARY_PATH ?? null),
      'the compiler path never stays in the app environment',
    ).toBeNull()

    await win.locator('.pane-tab').filter({ hasText: 'zsh' }).getByRole('tab').click()
    await runInTerminal(
      win,
      'echo "esbuild-env:[${ESBUILD_BINARY_PATH}]"; ostia open "$OSTIA_ARTIFACTS/page.html"',
    )
    await expect.poll(() => guestTitle(app), { timeout: 60_000 }).toBe('d3 max 7')
    await win.locator('.pane-tab').filter({ hasText: 'zsh' }).getByRole('tab').click()
    await expect(win.locator('.xterm-rows').first()).toContainText('esbuild-env:[]')

    await runInTerminal(win, 'ostia open "$OSTIA_ARTIFACTS/Broken.tsx"')
    await expect(win.getByTestId('preview-errors')).toContainText(/Broken\.tsx:3:\d+:/, {
      timeout: 60_000,
    })
  } finally {
    await quitApp(app)
  }
})
