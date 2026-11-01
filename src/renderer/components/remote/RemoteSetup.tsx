import { CheckCircleIcon, CircleIcon, ClockIcon, WarningCircleIcon } from '@phosphor-icons/react'
import type { SetupStep } from '@shared/remote/remoteSetup'
import type { JSX } from 'react'
import { SettingsList } from '@/components/settingsKit/SettingsList'
import { SettingsListRow } from '@/components/settingsKit/SettingsListRow'
import { Button } from '@/components/ui/button'
import { fmt, useDict } from '@/lib/app/useDict'

const LEADS = {
  todo: CircleIcon,
  running: ClockIcon,
  waiting: ClockIcon,
  done: CheckCircleIcon,
  failed: WarningCircleIcon,
} as const

export function RemoteSetup({
  steps,
  onRetry,
  onCheck,
}: {
  steps: readonly SetupStep[]
  onRetry: () => void
  onCheck: () => void
}): JSX.Element {
  const d = useDict()
  const stateText: Record<SetupStep['state'], string> = {
    todo: d.remote.stepTodo,
    running: d.remote.stepRunning,
    waiting: d.remote.stepWaiting,
    done: d.remote.stepDone,
    failed: '',
  }
  return (
    <SettingsList ordered label={d.remote.stepsLabel} empty="">
      {steps.map((step) => {
        const Lead = LEADS[step.state]
        const failed = step.state === 'failed' && step.error
        return (
          <SettingsListRow
            key={step.id}
            lead={
              <Lead
                size={16}
                aria-hidden
                className={step.state === 'failed' ? 'text-attn-fg' : undefined}
              />
            }
            title={d.remote.steps[step.id]}
            meta={failed ? undefined : stateText[step.state]}
            detail={
              failed ? (
                <span className="text-attn-fg">
                  {fmt(d.remote.errors[step.error as keyof typeof d.remote.errors], {
                    detail: step.detail ?? '',
                  })}
                </span>
              ) : undefined
            }
            actions={
              step.state === 'waiting' ? (
                <Button variant="outline" size="sm" onClick={onCheck}>
                  {d.remote.checkAgain}
                </Button>
              ) : failed ? (
                <Button variant="outline" size="sm" onClick={onRetry}>
                  {d.remote.retry}
                </Button>
              ) : undefined
            }
          />
        )
      })}
    </SettingsList>
  )
}
