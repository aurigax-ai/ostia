import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

interface Step {
  run?: string
  with?: { path?: string; files?: string }
}

const workflow = parse(
  readFileSync(join(process.cwd(), '.github/workflows/release.yml'), 'utf8'),
) as {
  jobs: Record<string, { steps?: Step[] }>
}
const steps = Object.values(workflow.jobs).flatMap((job) => job.steps ?? [])

describe('release packaging', () => {
  it('KSH-C62 packages Linux as the unpacked folder and a tarball, with no AppImage', () => {
    const builds = steps
      .map((s) => s.run ?? '')
      .filter((run) => run.includes('electron-builder --linux'))
    expect(builds.length).toBeGreaterThan(0)
    for (const build of builds) {
      expect(build).toMatch(/--linux\b.*\bdir\b/)
      expect(build).not.toMatch(/AppImage/i)
    }
    const published = steps.map((s) => `${s.with?.path ?? ''}\n${s.with?.files ?? ''}`).join('\n')
    expect(published).toContain('dist/*.tar.gz')
    expect(published).not.toMatch(/AppImage/i)
  })

  it('ships the preview runtime as a resource and the compiler binary outside the archive', () => {
    const builder = parse(readFileSync(join(process.cwd(), 'electron-builder.yml'), 'utf8')) as {
      files: string[]
      extraResources: { from: string; to: string }[]
      asarUnpack: string[]
    }
    expect(builder.extraResources).toContainEqual({
      from: 'out/artifact-runtime',
      to: 'artifact-runtime',
    })
    expect(builder.files).toContain('!out/artifact-runtime/**')
    expect(builder.asarUnpack).toEqual(
      expect.arrayContaining(['node_modules/esbuild/**', 'node_modules/@esbuild/**']),
    )
    const build = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')).scripts
      .build
    expect(build).toContain('build:artifact-runtime')
  })
})
