import { describe, expect, it } from 'vitest'
import { type SystemdLaunchInput, systemdLaunchPlan } from './systemdLaunch'

const base: SystemdLaunchInput = {
  platform: 'linux',
  noNewPrivs: true,
  systemdRun: '/usr/bin/systemd-run',
  tail: '/usr/bin/tail',
  exe: '/opt/ostia/ostia',
  args: ['--hidden'],
  env: { PATH: '/usr/bin', DISPLAY: ':0' },
  cwd: '/home/u',
  unit: 'ostia-abc',
}

describe('systemdLaunchPlan', () => {
  it('starts the app through the user manager with its argv and env', () => {
    expect(systemdLaunchPlan(base)).toEqual({
      file: '/usr/bin/systemd-run',
      args: [
        '--user',
        '--quiet',
        '--collect',
        '--no-block',
        '--unit=ostia-abc',
        '--working-directory=/home/u',
        '--property=KillMode=process',
        '--setenv=PATH=/usr/bin',
        '--setenv=DISPLAY=:0',
        '--',
        '/opt/ostia/ostia',
        '--hidden',
      ],
    })
  })

  it('keeps app.relaunch when the flag is already clear', () => {
    expect(systemdLaunchPlan({ ...base, noNewPrivs: false })).toBeNull()
  })

  it('keeps app.relaunch when systemd-run is missing', () => {
    expect(systemdLaunchPlan({ ...base, systemdRun: null })).toBeNull()
  })

  it('does nothing off Linux', () => {
    expect(systemdLaunchPlan({ ...base, platform: 'darwin' })).toBeNull()
    expect(systemdLaunchPlan({ ...base, platform: 'win32' })).toBeNull()
  })

  it('waits for the old process to exit before starting', () => {
    const plan = systemdLaunchPlan({ ...base, waitForPid: 42 })
    expect(plan?.args).toContain('--property=ExecStartPre=/usr/bin/tail --pid=42 -f /dev/null')
  })

  it('keeps app.relaunch when it must wait and tail is missing', () => {
    expect(systemdLaunchPlan({ ...base, waitForPid: 42, tail: null })).toBeNull()
  })

  it('passes the discrete GPU env and drops service variables and bad names', () => {
    const plan = systemdLaunchPlan({
      ...base,
      env: {
        DRI_PRIME: 'pci-0000_01_00_0',
        OSTIA_GPU_RESTORE: '{}',
        INVOCATION_ID: 'x',
        NOTIFY_SOCKET: '/run/notify',
        'BAD NAME': '1',
        UNSET: undefined,
      },
    })
    const setenv = plan?.args.filter((a) => a.startsWith('--setenv='))
    expect(setenv).toEqual(['--setenv=DRI_PRIME=pci-0000_01_00_0', '--setenv=OSTIA_GPU_RESTORE={}'])
  })

  it('puts an argument that looks like an option after the separator', () => {
    const plan = systemdLaunchPlan({ ...base, args: ['--user-data-dir=/tmp/x'] })
    const sep = plan?.args.indexOf('--') ?? -1
    expect(plan?.args.slice(sep)).toEqual(['--', '/opt/ostia/ostia', '--user-data-dir=/tmp/x'])
  })
})
