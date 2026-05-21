import { Plug } from 'lucide-react'
import { SettingsSection } from './SettingsSection'

export function McpSection() {
  return (
    <SettingsSection
      title="MCP 配置"
      icon={Plug}
      badge={<span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">即将推出</span>}
    >
      <p className="text-xs text-muted-foreground">
        MCP (Model Context Protocol) 服务器配置将在后续版本中支持，届时可在此管理外部工具连接。
      </p>
    </SettingsSection>
  )
}
