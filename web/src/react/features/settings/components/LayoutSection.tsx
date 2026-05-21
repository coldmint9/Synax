import { Monitor, Palette } from 'lucide-react'
import { useShellStore } from '../../../state/shellStore'
import { CapsuleSwitch } from './CapsuleSwitch'
import { SettingsSection } from './SettingsSection'

export function LayoutSection() {
  const theme = useShellStore(s => s.preferences.theme)
  const locale = useShellStore(s => s.preferences.locale)
  const defaultHome = useShellStore(s => s.preferences.defaultHome)
  const notifications = useShellStore(s => s.preferences.notifications)
  const editor = useShellStore(s => s.preferences.editor)
  const setTheme = useShellStore(s => s.setTheme)
  const setLocale = useShellStore(s => s.setLocale)
  const setDefaultHome = useShellStore(s => s.setDefaultHome)
  const setNotifications = useShellStore(s => s.setNotifications)
  const setEditor = useShellStore(s => s.setEditor)

  return (
    <SettingsSection title="布局与外观" icon={Palette}>
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs font-medium text-foreground">深色模式</div>
            <div className="text-[11px] text-muted-foreground">切换界面主题</div>
          </div>
          <CapsuleSwitch
            checked={theme === 'dark'}
            onChange={v => setTheme(v ? 'dark' : 'light')}
          />
        </div>

        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs font-medium text-foreground">语言</div>
            <div className="text-[11px] text-muted-foreground">界面显示语言</div>
          </div>
          <select
            className="settings-select"
            value={locale}
            onChange={e => setLocale(e.target.value as 'zh' | 'en')}
          >
            <option value="zh">中文</option>
            <option value="en">English</option>
          </select>
        </div>

        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs font-medium text-foreground">启动页</div>
            <div className="text-[11px] text-muted-foreground">打开应用时显示的内容</div>
          </div>
          <select
            className="settings-select"
            value={defaultHome}
            onChange={e => setDefaultHome(e.target.value as 'global-home' | 'last-project')}
          >
            <option value="global-home">首页</option>
            <option value="last-project">上次项目</option>
          </select>
        </div>

        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs font-medium text-foreground">通知</div>
            <div className="text-[11px] text-muted-foreground">启用系统通知</div>
          </div>
          <CapsuleSwitch
            checked={notifications}
            onChange={setNotifications}
          />
        </div>

        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs font-medium text-foreground">文件查看器</div>
            <div className="text-[11px] text-muted-foreground">点击源码链接时使用的编辑器</div>
          </div>
          <select
            className="settings-select"
            value={editor}
            onChange={e => setEditor(e.target.value as typeof editor)}
          >
            <option value="system">系统默认</option>
            <option value="vscode">VS Code</option>
            <option value="cursor">Cursor</option>
            <option value="windsurf">Windsurf</option>
            <option value="webstorm">WebStorm</option>
          </select>
        </div>
      </div>
    </SettingsSection>
  )
}
