import { app, type GPUFeatureStatus } from 'electron'
import type { AppLog } from './appLog'

interface GpuDevice {
  active?: boolean
  vendorId?: number
  deviceId?: number
  driverVendor?: string
  driverVersion?: string
}

interface GpuInfo {
  gpuDevice?: GpuDevice[]
  auxAttributes?: { glRenderer?: string; glVersion?: string; glVendor?: string }
}

export function gpuFacts(
  status: Partial<GPUFeatureStatus>,
  info: GpuInfo,
): Record<string, string | number | boolean> {
  const devices = info.gpuDevice ?? []
  const hex = (n: number | undefined): string => (n === undefined ? '?' : n.toString(16))
  return {
    glRenderer: info.auxAttributes?.glRenderer ?? '',
    glVersion: info.auxAttributes?.glVersion ?? '',
    devices: devices
      .map((d) => `${d.active ? '*' : ''}${hex(d.vendorId)}:${hex(d.deviceId)}`)
      .join(' '),
    webgl: status.webgl ?? '',
    webgl2: status.webgl2 ?? '',
    gpuCompositing: status.gpu_compositing ?? '',
    rasterization: status.rasterization ?? '',
  }
}

export function registerGpuReport(log: AppLog): void {
  const report = async (event: string): Promise<void> => {
    try {
      const info = (await app.getGPUInfo('complete')) as GpuInfo
      log.info(event, gpuFacts(app.getGPUFeatureStatus(), info))
    } catch (err) {
      log.warn(event, { error: err instanceof Error ? err.message : String(err) })
    }
  }
  app.once('gpu-info-update', () => void report('gpu-info'))
  app.on('child-process-gone', (_e, details) => {
    if (details.type === 'GPU') void report('gpu-info-after-gone')
  })
}
