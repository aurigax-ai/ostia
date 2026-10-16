import { app } from 'electron'
import type { ProcessUse } from './htmlPreview'

export function appProcessUse(): ProcessUse[] {
  return app.getAppMetrics().map((metric) => ({
    pid: metric.pid,
    memoryBytes: metric.memory.workingSetSize * 1024,
    cpuPercent: metric.cpu.percentCPUUsage,
  }))
}
