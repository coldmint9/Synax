import { useState } from 'react'
import { Tabs } from '@heroui/react'
import { Compass, Globe2, Plug, Puzzle } from 'lucide-react'
import { useLocale } from '../../../../hooks/useLocale'
import type { McpServerConfig } from '../../../../lib/contracts/config'
import { McpServersSection } from '../components/McpServersSection'
import { SkillMarketplacePanel } from '../../skills/SkillMarketplacePanel'
import { LocalDiscoveryPanel } from './LocalDiscoveryPanel'
import './integrations.css'

interface Props {
  projectId: string
  servers: McpServerConfig[]
  onSave: (servers: McpServerConfig[]) => Promise<void>
}
export function ProjectCapabilitiesSection(props: Props) {
  const { locale } = useLocale()
  const zh = locale === 'zh'
  const [tab, setTab] = useState('discover')
  return (
    <section className="project-capabilities">
      <header className="capabilities-heading">
        <div>
          <Puzzle size={16} />
          <h2>{zh ? '工具与技能' : 'Tools & skills'}</h2>
        </div>
        <span>{zh ? '为当前项目扩展能力' : 'Extend this project'}</span>
      </header>
      <div className="capabilities-surface">
        <Tabs
          selectedKey={tab}
          onSelectionChange={(key) => setTab(String(key))}
          className="capabilities-tabs"
        >
          <Tabs.ListContainer>
            <Tabs.List aria-label={zh ? '工具与技能' : 'Tools and skills'}>
              <Tabs.Tab id="discover">
                <Compass size={14} />
                {zh ? '本地发现' : 'Local discovery'}
                <Tabs.Indicator />
              </Tabs.Tab>
              <Tabs.Tab id="mcp">
                <Plug size={14} />
                {zh ? '已接入 MCP' : 'Connected MCP'}
                <span className="capabilities-count">
                  {props.servers.length}
                </span>
                <Tabs.Indicator />
              </Tabs.Tab>
              <Tabs.Tab id="market">
                <Globe2 size={14} />
                {zh ? 'Skill 市场' : 'Skill marketplace'}
                <Tabs.Indicator />
              </Tabs.Tab>
            </Tabs.List>
          </Tabs.ListContainer>
          <Tabs.Panel id="discover" shouldForceMount>
            <LocalDiscoveryPanel key={props.projectId} {...props} />
          </Tabs.Panel>
          <Tabs.Panel id="mcp">
            <div className="capabilities-managed">
              <McpServersSection
                {...props}
                title={zh ? '项目 MCP 服务' : 'Project MCP servers'}
              />
            </div>
          </Tabs.Panel>
          <Tabs.Panel id="market">
            <div className="capabilities-market">
              <SkillMarketplacePanel projectId={props.projectId} />
            </div>
          </Tabs.Panel>
        </Tabs>
      </div>
    </section>
  )
}
