import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  KubeContextReader,
  NodeVersionResolver,
  hasPackageJson,
  kubeconfigFiles,
  nodeVersionFromPath,
  parseKubeCurrentContext,
  promptContext,
  runNodeVersion,
  shortHostname,
  virtualEnvName,
} from './promptContext'
import type { ShellState } from './shellCommands'

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pine-prompt-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function executable(dir: string, name: string, body = '#!/bin/sh\n'): string {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, name)
  writeFileSync(file, body)
  chmodSync(file, 0o755)
  return file
}

const state = (patch: Partial<ShellState> = {}): ShellState => ({
  path: '',
  virtualEnv: null,
  condaEnv: null,
  kubeconfig: null,
  names: [],
  ...patch,
})

describe('parseKubeCurrentContext', () => {
  it('reads the top-level current-context, quoted or not', () => {
    expect(
      parseKubeCurrentContext('apiVersion: v1\ncurrent-context: prod-eu\nkind: Config\n'),
    ).toBe('prod-eu')
    expect(parseKubeCurrentContext('current-context: "kind-dev"  \n')).toBe('kind-dev')
    expect(parseKubeCurrentContext("current-context: 'a b'\r\n")).toBe('a b')
    expect(parseKubeCurrentContext('current-context: staging # picked by kubectx\n')).toBe(
      'staging',
    )
  })

  it('ignores nested keys and empty values', () => {
    expect(parseKubeCurrentContext('contexts:\n  current-context: nested\n')).toBeNull()
    expect(parseKubeCurrentContext('current-context: ""\n')).toBeNull()
    expect(parseKubeCurrentContext('current-context:\n')).toBeNull()
    expect(parseKubeCurrentContext('')).toBeNull()
  })
})

describe('kubeconfigFiles', () => {
  it('uses ~/.kube/config unless KUBECONFIG lists files', () => {
    expect(kubeconfigFiles(null, '/home/u')).toEqual(['/home/u/.kube/config'])
    expect(kubeconfigFiles('/a:/b::', '/home/u')).toEqual(['/a', '/b'])
  })
})

describe('KubeContextReader', () => {
  it('takes the first file that names a context, and rereads a file after it changes', async () => {
    const empty = join(root, 'empty')
    const config = join(root, 'config')
    writeFileSync(empty, 'kind: Config\n')
    writeFileSync(config, 'current-context: one\n')
    const reader = new KubeContextReader()
    expect(await reader.read([join(root, 'missing'), empty, config])).toBe('one')
    writeFileSync(config, 'current-context: two-longer\n')
    expect(await reader.read([config])).toBe('two-longer')
  })

  it('refuses directories and files over 1 MiB, follows symlinks to files', async () => {
    const big = join(root, 'big')
    writeFileSync(big, `current-context: huge\n${'#'.repeat(1024 * 1024)}`)
    const link = join(root, 'link')
    const target = join(root, 'target')
    writeFileSync(target, 'current-context: linked\n')
    symlinkSync(target, link)
    const reader = new KubeContextReader()
    expect(await reader.read([root])).toBeNull()
    expect(await reader.read([big])).toBeNull()
    expect(await reader.read([link])).toBe('linked')
  })
})

describe('virtualEnvName and shortHostname', () => {
  it('shows the virtualenv folder name and the host without its domain', () => {
    expect(virtualEnvName('/home/u/proj/.venv/')).toBe('.venv')
    expect(virtualEnvName('/home/u/envs/ml')).toBe('ml')
    expect(virtualEnvName(null)).toBeNull()
    expect(shortHostname('box.lan.example')).toBe('box')
  })
})

describe('nodeVersionFromPath', () => {
  it('reads the version from nvm, fnm and volta style install paths', () => {
    expect(nodeVersionFromPath('/home/u/.nvm/versions/node/v20.11.1/bin/node')).toBe('v20.11.1')
    expect(
      nodeVersionFromPath('/home/u/.local/share/fnm/node-versions/v22.3.0/installation/bin/node'),
    ).toBe('v22.3.0')
    expect(nodeVersionFromPath('/home/u/.volta/tools/image/node/18.19.0/bin/node')).toBe('v18.19.0')
    expect(nodeVersionFromPath('/usr/bin/node')).toBeNull()
  })
})

describe('NodeVersionResolver', () => {
  it('reads a versioned install path without running node', async () => {
    const bin = join(root, '.nvm', 'versions', 'node', 'v20.1.0', 'bin')
    executable(bin, 'node')
    const run = vi.fn()
    expect(await new NodeVersionResolver(run).resolve(`/nowhere:${bin}`)).toBe('v20.1.0')
    expect(run).not.toHaveBeenCalled()
  })

  it('runs an unversioned node once per binary and caches the answer', async () => {
    const bin = join(root, 'bin')
    const node = executable(bin, 'node')
    const run = vi.fn().mockResolvedValue('v21.0.0')
    const resolver = new NodeVersionResolver(run)
    expect(await resolver.resolve(bin)).toBe('v21.0.0')
    expect(await resolver.resolve(bin)).toBe('v21.0.0')
    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith(node)
  })

  it('finds nothing when node is not on the PATH or not executable', async () => {
    const bin = join(root, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'node'), '')
    expect(await new NodeVersionResolver(vi.fn()).resolve(bin)).toBeNull()
  })

  it('runs the binary without a shell and accepts only a version line', async () => {
    const good = executable(join(root, 'a'), 'node', '#!/bin/sh\necho v19.9.0\n')
    const noisy = executable(join(root, 'b'), 'node', '#!/bin/sh\necho "$(id)"\n')
    expect(await runNodeVersion(good)).toBe('v19.9.0')
    expect(await runNodeVersion(noisy)).toBeNull()
  })
})

describe('hasPackageJson', () => {
  it('finds a package.json in the directory or above it', async () => {
    const deep = join(root, 'proj', 'src', 'lib')
    mkdirSync(deep, { recursive: true })
    expect(await hasPackageJson(deep)).toBe(false)
    writeFileSync(join(root, 'proj', 'package.json'), '{}')
    expect(await hasPackageJson(deep)).toBe(true)
  })
})

describe('promptContext', () => {
  const sources = (run = vi.fn().mockResolvedValue('v21.0.0')) => ({
    node: new NodeVersionResolver(run),
    kube: new KubeContextReader(),
    home: root,
    user: 'ada',
    host: 'box.lan',
  })

  it('combines the shell report with the user, host and home', async () => {
    const ctx = await promptContext(
      state({ virtualEnv: '/p/.venv', condaEnv: 'base' }),
      '',
      root,
      { node: false, kube: false },
      sources(),
    )
    expect(ctx).toEqual({
      user: 'ada',
      host: 'box',
      home: root,
      virtualEnv: '.venv',
      condaEnv: 'base',
      nodeVersion: null,
      kubeContext: null,
    })
  })

  it('resolves node only in a Node project and kube only when asked', async () => {
    const bin = join(root, 'bin')
    executable(bin, 'node')
    const kube = join(root, '.kube')
    mkdirSync(kube)
    writeFileSync(join(kube, 'config'), 'current-context: dev\n')
    const project = join(root, 'proj')
    mkdirSync(project)
    const run = vi.fn().mockResolvedValue('v21.0.0')
    const src = sources(run)
    const outside = await promptContext(
      state({ path: bin }),
      '',
      project,
      { node: true, kube: false },
      src,
    )
    expect(outside.nodeVersion).toBeNull()
    expect(outside.kubeContext).toBeNull()
    expect(run).not.toHaveBeenCalled()
    writeFileSync(join(project, 'package.json'), '{}')
    const inside = await promptContext(
      state({ path: bin }),
      '',
      project,
      { node: true, kube: true },
      src,
    )
    expect(inside.nodeVersion).toBe('v21.0.0')
    expect(inside.kubeContext).toBe('dev')
  })

  it('uses the KUBECONFIG the shell reported and the spawn PATH before any report', async () => {
    const custom = join(root, 'custom.yaml')
    writeFileSync(custom, 'current-context: from-env\n')
    const bin = join(root, '.nvm', 'versions', 'node', 'v16.0.0', 'bin')
    executable(bin, 'node')
    writeFileSync(join(root, 'package.json'), '{}')
    const ctx = await promptContext(
      state({ kubeconfig: custom, path: '' }),
      bin,
      root,
      { node: true, kube: true },
      sources(),
    )
    expect(ctx.kubeContext).toBe('from-env')
    expect(ctx.nodeVersion).toBeNull()
    const beforeReport = await promptContext(
      null,
      bin,
      root,
      { node: true, kube: false },
      sources(),
    )
    expect(beforeReport.nodeVersion).toBe('v16.0.0')
  })
})
