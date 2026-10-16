import { countUsage } from '@/lib/app/usageCounts'

const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|software/i

export function isSoftwareRenderer(renderer: string | null): boolean {
  return renderer === null || SOFTWARE_RENDERER.test(renderer)
}

function probeRenderer(): string | null {
  const gl = document.createElement('canvas').getContext('webgl2')
  if (!gl) return null
  const info = gl.getExtension('WEBGL_debug_renderer_info')
  const renderer = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : ''
  gl.getExtension('WEBGL_lose_context')?.loseContext()
  return typeof renderer === 'string' ? renderer : ''
}

let software: boolean | undefined

export function drawOnGpu(
  requested: boolean,
  probe: () => string | null = probeRenderer,
  allowSoftware: boolean = window.ostia.softwareWebgl,
): boolean {
  if (!requested || allowSoftware) return requested
  software ??= isSoftwareRenderer(probe())
  if (software) countUsage('terminal', 'webgl_software')
  return !software
}

export function forgetProbe(): void {
  software = undefined
}
