import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { POLKIT_ACTION, POLKIT_POLICY_FILE } from '../../shared/permissions/scriptTokens'

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
    expect(builder.asarUnpack).toContain('node_modules/@esbuild/**')
    expect(builder.files).toContain('!node_modules/esbuild/bin/**')
    const build = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')).scripts
      .build
    expect(build).toContain('build:artifact-runtime')
  })

  it('ships the polkit action for script tokens and installs it from the deb', () => {
    const file = POLKIT_POLICY_FILE
    const builder = parse(readFileSync(join(process.cwd(), 'electron-builder.yml'), 'utf8')) as {
      linux: { extraResources: { from: string; to: string }[] }
    }
    expect(builder.linux.extraResources).toContainEqual({
      from: `packaging/linux/${file}`,
      to: `polkit/${file}`,
    })
    const policy = readFileSync(join(process.cwd(), 'packaging/linux', file), 'utf8')
    expect(policy).toContain(`<action id="${POLKIT_ACTION}">`)
    expect(policy).toContain('<allow_active>auth_self</allow_active>')
    expect(policy).toContain('<allow_any>no</allow_any>')
    expect(policy).toContain('<allow_inactive>no</allow_inactive>')
    const aptScript = (name: string) =>
      readFileSync(join(process.cwd(), 'packaging/apt', name), 'utf8')
    expect(aptScript('after-install.tpl')).toContain(
      `cp -f '/opt/\${sanitizedProductName}/resources/polkit/${file}' /usr/share/polkit-1/actions/`,
    )
    expect(aptScript('after-remove.tpl')).toContain(
      `remove|purge) rm -f /usr/share/polkit-1/actions/${file} ;;`,
    )
  })
})
