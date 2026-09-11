import { useState } from 'react'
import { ListBox, Popover, Tooltip } from '@heroui/react'
import { ChevronDown } from 'lucide-react'
import type { AgentSessionMode } from '../../../lib/api/agentRuntime'
import { useLocale } from '../../../hooks/useLocale'
import './agentControls.css'

interface Props {
  mode: AgentSessionMode | 'plan_node'
  disabled: boolean
  description: string
  onChange: (mode: AgentSessionMode) => void
}

export function SessionModePicker({ mode, disabled, description, onChange }: Props) {
  const { locale } = useLocale()
  const zh = locale === 'zh'
  const [open, setOpen] = useState(false)
  const options = [
    { id: 'chat', label: zh ? '对话' : 'Chat' },
    { id: 'plan', label: zh ? '计划' : 'Plan' },
    { id: 'goal', label: zh ? '目标' : 'Goal' },
  ] as const
  const label = options.find(option => option.id === mode)?.label ?? (zh ? '计划节点' : 'Plan node')
  return (
    <Popover isOpen={!disabled && open} onOpenChange={value => setOpen(!disabled && value)}>
      <Tooltip delay={400}>
        <Popover.Trigger<'button'>
          render={props => <button {...props} type="button" />}
          aria-label={zh ? '会话模式' : 'Session mode'}
          aria-description={description}
          disabled={disabled}
          data-mode={mode}
          className="goal-dock-composer-chip agent-mode-trigger"
        >
          <span>{label}</span><ChevronDown size={10} aria-hidden />
        </Popover.Trigger>
        <Tooltip.Content>{description}</Tooltip.Content>
      </Tooltip>
      <Popover.Content placement="top end" offset={8} className="agent-mode-popover">
        <ListBox
          autoFocus
          aria-label={zh ? '会话模式' : 'Session mode'}
          selectionMode="single"
          disallowEmptySelection
          selectedKeys={new Set([mode])}
          onSelectionChange={keys => {
            if (disabled || keys === 'all') return
            const selected = [...keys][0]
            const option = options.find(item => item.id === selected)
            if (option) { setOpen(false); if (option.id !== mode) onChange(option.id) }
          }}
        >
          {options.map(option => <ListBox.Item key={option.id} id={option.id} textValue={option.label} className="agent-mode-option">
            {option.label}<ListBox.ItemIndicator />
          </ListBox.Item>)}
        </ListBox>
      </Popover.Content>
    </Popover>
  )
}
