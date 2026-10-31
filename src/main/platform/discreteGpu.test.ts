import { describe, expect, it } from 'vitest'
import {
  defaultGpuRenderNode,
  discreteGpu,
  GPU_RESTORE_ENV,
  gpuRelaunchEnv,
  gpuStartPlan,
  parseGpuEnvironment,
  parseSwitcherooGpus,
  renderNodeOf,
  restoreGpuLaunchEnv,
  type SwitcherooGpu,
  severalRenderNodes,
  withoutGpuLaunchEnv,
} from './discreteGpu'

const REPLY = JSON.stringify({
  type: 'aa{sv}',
  data: [
    {
      Name: { type: 's', data: 'Intel Corporation DG2 [Arc A370M]' },
      Environment: {
        type: 'as',
        data: ['DRI_PRIME', 'pci-0000_03_00_0', 'VK_LOADER_DRIVERS_SELECT', '*intel*'],
      },
      Default: { type: 'b', data: false },
      Discrete: { type: 'b', data: true },
    },
    {
      Name: { type: 's', data: 'Intel Corporation Raptor Lake-P [UHD Graphics]' },
      Environment: {
        type: 'as',
        data: ['DRI_PRIME', 'pci-0000_00_02_0', 'VK_LOADER_DRIVERS_SELECT', '*intel*'],
      },
      Default: { type: 'b', data: true },
      Discrete: { type: 'b', data: false },
    },
  ],
})

const ARC: SwitcherooGpu = {
  name: 'Intel Corporation DG2 [Arc A370M]',
  isDefault: false,
  discrete: true,
  environment: { DRI_PRIME: 'pci-0000_03_00_0', VK_LOADER_DRIVERS_SELECT: '*intel*' },
}

describe('parseSwitcherooGpus', () => {
  it('reads every GPU from busctl’s JSON reply', () => {
    const gpus = parseSwitcherooGpus(REPLY)
    expect(gpus).toHaveLength(2)
    expect(gpus?.[0]).toEqual(ARC)
    expect(gpus?.[1].isDefault).toBe(true)
    expect(discreteGpu(gpus)).toEqual(ARC)
  })

  it('returns null for a reply that is not JSON or not the GPUs property', () => {
    expect(parseSwitcherooGpus('not json')).toBeNull()
    expect(parseSwitcherooGpus(JSON.stringify({ type: 's', data: 'x' }))).toBeNull()
  })

  it('skips a GPU whose environment has a variable outside the allowlist', () => {
    const reply = JSON.parse(REPLY)
    reply.data[0].Environment.data.push('LD_PRELOAD', '/tmp/evil.so')
    const gpus = parseSwitcherooGpus(JSON.stringify(reply))
    expect(gpus?.map((g) => g.name)).toEqual(['Intel Corporation Raptor Lake-P [UHD Graphics]'])
    expect(discreteGpu(gpus)).toBeNull()
  })

  it('finds no discrete GPU when the only discrete one is the default', () => {
    expect(discreteGpu([{ ...ARC, isDefault: true }])).toBeNull()
    expect(discreteGpu(null)).toBeNull()
  })
})

describe('parseGpuEnvironment', () => {
  it('accepts the NVIDIA offload variables', () => {
    expect(
      parseGpuEnvironment([
        '__NV_PRIME_RENDER_OFFLOAD',
        '1',
        '__GLX_VENDOR_LIBRARY_NAME',
        'nvidia',
        '__VK_LAYER_NV_optimus',
        'NVIDIA_only',
      ]),
    ).toEqual({
      __NV_PRIME_RENDER_OFFLOAD: '1',
      __GLX_VENDOR_LIBRARY_NAME: 'nvidia',
      __VK_LAYER_NV_optimus: 'NVIDIA_only',
    })
  })

  it('rejects other keys, odd lists, non-strings and NUL bytes', () => {
    expect(parseGpuEnvironment(['PATH', '/tmp'])).toBeNull()
    expect(parseGpuEnvironment(['DRI_PRIME'])).toBeNull()
    expect(parseGpuEnvironment([])).toBeNull()
    expect(parseGpuEnvironment(['DRI_PRIME', 1])).toBeNull()
    expect(parseGpuEnvironment(['DRI_PRIME', 'a\0b'])).toBeNull()
    expect(parseGpuEnvironment('DRI_PRIME=1')).toBeNull()
  })
})

describe('gpuRelaunchEnv', () => {
  it('adds the GPU’s environment and remembers the values it replaced', () => {
    const patch = gpuRelaunchEnv({ VK_LOADER_DRIVERS_SELECT: '*amd*' }, ARC)
    expect(patch).toMatchObject(ARC.environment)
    expect(JSON.parse(patch?.[GPU_RESTORE_ENV] ?? '')).toEqual({
      DRI_PRIME: null,
      VK_LOADER_DRIVERS_SELECT: '*amd*',
    })
  })

  it('never relaunches a process that was already relaunched', () => {
    expect(gpuRelaunchEnv({ [GPU_RESTORE_ENV]: '{}' }, ARC)).toBeNull()
  })

  it('does not relaunch a process started with the GPU’s environment', () => {
    expect(gpuRelaunchEnv({ ...ARC.environment }, ARC)).toBeNull()
  })
})

describe('gpuStartPlan', () => {
  it('relaunches once, then stays', () => {
    expect(gpuStartPlan({}, ARC).kind).toBe('relaunch')
    const relaunched = { ...ARC.environment, ...gpuRelaunchEnv({}, ARC) }
    expect(gpuStartPlan(relaunched, ARC).kind).toBe('stay')
  })
})

describe('renderNodeOf', () => {
  it('maps a DRI_PRIME PCI tag to its render node', () => {
    expect(renderNodeOf('pci-0000_03_00_0', () => true)).toBe(
      '/dev/dri/by-path/pci-0000:03:00.0-render',
    )
  })

  it('ignores other DRI_PRIME forms and missing devices', () => {
    expect(renderNodeOf('1', () => true)).toBeNull()
    expect(renderNodeOf('pci-0000_03_00_0/../../x', () => true)).toBeNull()
    expect(renderNodeOf(undefined, () => true)).toBeNull()
    expect(renderNodeOf('pci-0000_03_00_0', () => false)).toBeNull()
  })
})

describe('the default GPU on a machine with several', () => {
  const gpu = (name: string, isDefault: boolean, discrete: boolean, busDevice: string) => ({
    name,
    isDefault,
    discrete,
    environment: { DRI_PRIME: `pci-0000_${busDevice}_0` },
  })
  const gpus = [gpu('Arc', false, true, '03_00'), gpu('UHD', true, false, '00_02')]

  it('GPU-U2 pins the default GPU, wherever the kernel numbered the discrete one', () => {
    expect(defaultGpuRenderNode({}, gpus, () => true)).toBe(
      '/dev/dri/by-path/pci-0000:00:02.0-render',
    )
  })

  it('GPU-U3 leaves a human who set DRI_PRIME alone', () => {
    expect(defaultGpuRenderNode({ DRI_PRIME: '1' }, gpus, () => true)).toBeNull()
  })

  it('GPU-U4 pins nothing without switcheroo, a default GPU or its node', () => {
    expect(defaultGpuRenderNode({}, null, () => true)).toBeNull()
    expect(defaultGpuRenderNode({}, [gpus[0] as never], () => true)).toBeNull()
    expect(defaultGpuRenderNode({}, gpus, () => false)).toBeNull()
  })

  it('GPU-U5 asks switcheroo only when more than one render node exists', () => {
    expect(severalRenderNodes(() => ['card0', 'renderD128'])).toBe(false)
    expect(severalRenderNodes(() => ['card0', 'card1', 'renderD128', 'renderD129'])).toBe(true)
    expect(
      severalRenderNodes(() => {
        throw new Error('no /dev/dri')
      }),
    ).toBe(false)
  })
})

describe('withoutGpuLaunchEnv', () => {
  it('gives panes back the environment from before the relaunch', () => {
    const env = {
      PATH: '/bin',
      ...ARC.environment,
      ...gpuRelaunchEnv({ VK_LOADER_DRIVERS_SELECT: '*amd*' }, ARC),
    }
    expect(withoutGpuLaunchEnv(env)).toEqual({ PATH: '/bin', VK_LOADER_DRIVERS_SELECT: '*amd*' })
  })

  it('leaves an environment the human set themselves alone', () => {
    const env = { PATH: '/bin', DRI_PRIME: '1' }
    expect(withoutGpuLaunchEnv(env)).toBe(env)
  })

  it('restores nothing outside the allowlist from a tampered marker', () => {
    const env = { PATH: '/bin', [GPU_RESTORE_ENV]: JSON.stringify({ PATH: '/tmp' }) }
    expect(withoutGpuLaunchEnv(env)).toEqual({ PATH: '/bin' })
  })
})

describe('restoreGpuLaunchEnv', () => {
  it('puts the process environment back before a restart', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/bin', ...ARC.environment, ...gpuRelaunchEnv({}, ARC) }
    restoreGpuLaunchEnv(env)
    expect(env).toEqual({ PATH: '/bin' })
  })
})
