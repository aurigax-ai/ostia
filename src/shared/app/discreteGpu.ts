export const DISCRETE_GPU_FEATURE = 'discrete-gpu'

export interface DiscreteGpuInfo {
  name: string
  inUse: boolean
}

export function parseDiscreteGpu(raw: unknown): boolean {
  return raw === true
}

export function rendererDeviceName(renderer: string): string {
  return /^ANGLE \([^,]+, (.+), [^,]+\)$/.exec(renderer)?.[1] ?? renderer
}

export const SOFTWARE_WEBGL_ARG = '--ostia-software-webgl'
