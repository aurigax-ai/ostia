import { InfoIcon } from '@phosphor-icons/react'
import { DISCRETE_GPU_FEATURE, type DiscreteGpuInfo, rendererDeviceName } from '@shared/discreteGpu'
import { PRODUCT_DISPLAY_NAME } from '@shared/productDisplay'
import { useEffect, useState } from 'react'
import { fmt, useDict } from '../i18n/useDict'
import { useSettingsStore } from '../stores/settingsStore'
import { RequirementsNoteView, useRequirements } from './RequirementsNote'
import { ExperimentalBadge, ToggleRow } from './SettingsPanel'
import { Button } from './ui/button'

export function drawingGpu(): string | null {
  const gl = document.createElement('canvas').getContext('webgl')
  if (!gl) return null
  const info = gl.getExtension('WEBGL_debug_renderer_info')
  const renderer = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : null
  gl.getExtension('WEBGL_lose_context')?.loseContext()
  return typeof renderer === 'string' && renderer ? rendererDeviceName(renderer) : null
}

export function DiscreteGpuRow(): JSX.Element {
  const d = useDict()
  const enabled = useSettingsStore((s) => s.behavior.discreteGpu)
  const setBehavior = useSettingsStore((s) => s.setBehavior)
  const requirements = useRequirements(DISCRETE_GPU_FEATURE)
  const report = requirements.report
  const [gpu, setGpu] = useState<DiscreteGpuInfo | null | undefined>(undefined)
  const [drawing] = useState(drawingGpu)
  useEffect(() => {
    let live = true
    void window.ostia.system.discreteGpu().then((next) => {
      if (live) setGpu(next)
    })
    return () => {
      live = false
    }
  }, [])
  const ready = report !== null && report.missing.length === 0
  const pending = gpu ? enabled !== gpu.inUse : false
  return (
    <>
      <ToggleRow
        label={d.settings.discreteGpu}
        desc={fmt(d.settings.discreteGpuDesc, { product: PRODUCT_DISPLAY_NAME })}
        checked={enabled}
        labelHint={<ExperimentalBadge />}
        disabled={!enabled && (!ready || !gpu)}
        onChange={(v) => setBehavior({ discreteGpu: v })}
      />
      <RequirementsNoteView
        body={d.settings.discreteGpuRequirementsBody}
        requirements={requirements}
      />
      <div role="note" className="mt-1 flex items-start gap-2 text-fg-muted text-ui-sm">
        <InfoIcon className="mt-0.5 size-3.5 shrink-0" />
        <div className="min-w-0 flex-1">
          {ready && gpu === null ? <p>{d.settings.discreteGpuNone}</p> : null}
          {gpu ? <p>{fmt(d.settings.discreteGpuFound, { name: gpu.name })}</p> : null}
          <p>
            {fmt(d.settings.discreteGpuDrawing, { name: drawing ?? d.settings.discreteGpuUnknown })}
          </p>
          {pending ? <p>{d.settings.discreteGpuNextStart}</p> : null}
        </div>
        {pending ? (
          <Button
            variant="secondary"
            size="xs"
            className="shrink-0"
            onClick={() => void window.ostia.update.restart()}
          >
            {d.settings.discreteGpuRestart}
          </Button>
        ) : null}
      </div>
    </>
  )
}
