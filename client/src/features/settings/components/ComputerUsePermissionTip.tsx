import { Button } from '../../../shared/ui/ui/Button'
import type { ComputerUsePermissionTarget } from '../useComputerUseStatus'

export function ComputerUsePermissionTip({ zh, onOpenPermission }: {
  zh: boolean
  onOpenPermission: (target: ComputerUsePermissionTarget) => void
}) {
  const steps = zh
    ? [
        '点击下方按钮打开 macOS 系统设置。',
        '在列表中找到 Synax，并开启对应的系统权限。',
        '授权后退出并重新打开 Synax，再确认状态为“已就绪”。',
      ]
    : [
        'Use the buttons below to open macOS System Settings.',
        'Find Synax in the list and enable the requested permission.',
        'After granting access, quit and reopen Synax, then check that the status is “Ready”.',
      ]

  return (
    <>
      <ol role="list" className="computer-use-alert__steps">
        {steps.map((step, index) => (
          <li key={step}>
            <span className="computer-use-alert__step-number" aria-hidden="true">{index + 1}</span>
            <span>{step}</span>
          </li>
        ))}
      </ol>
      <div className="computer-use-alert__actions">
        <Button size="sm" className="computer-use-link" onClick={() => onOpenPermission('accessibility')}>
          {zh ? '设备控制和数据访问（辅助功能）' : 'Device Control & Data Access (Accessibility)'}
        </Button>
        <Button size="sm" className="computer-use-link" onClick={() => onOpenPermission('screen-recording')}>
          {zh ? '打开屏幕录制' : 'Open Screen Recording'}
        </Button>
      </div>
    </>
  )
}
