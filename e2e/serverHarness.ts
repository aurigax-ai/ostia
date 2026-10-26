import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const API_HOST = 'localhost'
export const RELAY_DOMAIN = 'r.localhost'

export interface RunningServer {
  port: number
  caPath: string
  log: () => string
  invite: (accountId?: string) => string
  stop: () => Promise<void>
}

export interface PushConfig {
  serviceAccountFile: string
  endpoint: string
}

function configToml(
  dir: string,
  certPath: string,
  keyPath: string,
  options: { push?: PushConfig },
): string {
  return [
    `data_dir = "${join(dir, 'data')}"`,
    'log_level = "debug"',
    '[domains]',
    `api = "${API_HOST}"`,
    `relay = "${RELAY_DOMAIN}"`,
    '[listen]',
    'https = "127.0.0.1:0"',
    '[tls]',
    'mode = "files"',
    '[[tls.certs]]',
    `cert = "${certPath}"`,
    `key = "${keyPath}"`,
    '[modules]',
    'relay = true',
    'publish = true',
    'sync = true',
    `push = ${options.push ? 'true' : 'false'}`,
    ...(options.push
      ? [
          '[push.fcm]',
          `service_account_file = "${options.push.serviceAccountFile}"`,
          `endpoint = "${options.push.endpoint}"`,
        ]
      : []),
    '',
  ].join('\n')
}

function selfSignedCertificate(dir: string): { certPath: string; keyPath: string } {
  const certPath = join(dir, 'server.pem')
  const keyPath = join(dir, 'server.key.pem')
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '2',
      '-subj',
      `/CN=${API_HOST}`,
      '-addext',
      `subjectAltName=DNS:${API_HOST}`,
    ],
    { stdio: 'ignore' },
  )
  return { certPath, keyPath }
}

export async function startServer(
  binary: string,
  options: { push?: PushConfig } = {},
): Promise<RunningServer> {
  const dir = mkdtempSync(join(tmpdir(), 'ostia-server-e2e-'))
  const { certPath, keyPath } = selfSignedCertificate(dir)
  const configPath = join(dir, 'ostia-server.toml')
  writeFileSync(configPath, configToml(dir, certPath, keyPath, options), {
    mode: 0o600,
  })
  const child: ChildProcess = spawn(binary, ['-config', configPath], {
    env: { PATH: process.env.PATH ?? '' },
  })
  let log = ''
  const port = await new Promise<number>((resolve, reject) => {
    const onData = (chunk: Buffer): void => {
      log += chunk.toString()
      const match = /listening https=\S+:(\d+)/.exec(log)
      if (match) resolve(Number(match[1]))
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.once('exit', () => reject(new Error(`ostia-server exited early\n${log}`)))
  })
  return {
    port,
    caPath: certPath,
    log: () => log,
    invite: (accountId) =>
      execFileSync(
        binary,
        ['admin', '-config', configPath, 'invite', ...(accountId ? ['-account', accountId] : [])],
        { encoding: 'utf8' },
      )
        .split('\n')[0]
        ?.trim() ?? '',
    stop: async () => {
      child.kill('SIGTERM')
      await new Promise<void>((resolve) => child.once('exit', () => resolve()))
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
