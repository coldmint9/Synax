import { useState, useRef, useEffect } from 'react'
import { cn } from '../lib/utils'
import { Send, Bot, User, Zap } from 'lucide-react'

interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: string
  agentName?: string
  events?: string[]
}

const INITIAL_MESSAGES: ChatMessage[] = [
  {
    id: 'sys1', role: 'system',
    content: 'Connected to PM Agent (Collaborator Level). Type a message to interact with the project agent.',
    timestamp: '14:00:00',
  },
  {
    id: 'a1', role: 'assistant',
    content: '你好！我是 PM Agent，负责监控项目进度和协调资源。当前 Sprint 进度 67%，有 2 个任务进行中，1 个在 Review。有什么我可以帮忙的？',
    timestamp: '14:00:02',
    agentName: 'PM Agent',
    events: ['agent.started', 'project.sprint.read'],
  },
]

const AGENT_OPTIONS = [
  { id: 'pm', name: 'PM Agent', level: 'Collaborator', color: 'text-primary' },
  { id: 'dev', name: 'Dev Agent', level: 'Executor', color: 'text-agent' },
  { id: 'qa', name: 'QA Agent', level: 'Executor', color: 'text-success' },
]

const MOCK_RESPONSES: Record<string, string> = {
  '进度': '当前 Sprint "Sprint 14" 进度：\n\n• 总任务：18 个\n• 已完成：12 个 (67%)\n• 进行中：2 个\n• Review 中：1 个\n• 测试中：1 个\n• 阻塞：1 个\n\n⚠️ 注意："DB migration" 任务被基础设施问题阻塞，建议优先处理。',
  '风险': '当前项目风险分析：\n\n🔴 **高风险**: 数据库迁移被阻塞，可能影响 Sprint 交付\n🟡 **中风险**: Sprint 仅剩 3 天，剩余 6 个任务需关注\n🟢 **低风险**: CI 管道稳定，代码质量良好\n\n建议行动：\n1. 安排 DevOps 处理基础设施问题\n2. 将低优先级任务移至下个 Sprint',
  '阻塞': '检测到 1 个阻塞项：\n\n📌 **DB Migration Script** (T4)\n• 阻塞原因：Staging 环境数据库连接配置缺失\n• 影响：后续 2 个依赖任务无法开始\n• 建议指派：DevOps Agent\n\n是否需要我自动创建一个任务并指派给 DevOps Agent？',
}

export function AgentChat() {
  const [messages, setMessages] = useState<ChatMessage[]>(INITIAL_MESSAGES)
  const [input, setInput] = useState('')
  const [selectedAgent, setSelectedAgent] = useState('pm')
  const [isTyping, setIsTyping] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const handleSend = () => {
    if (!input.trim()) return

    const userMsg: ChatMessage = {
      id: `u_${Date.now()}`,
      role: 'user',
      content: input,
      timestamp: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    }
    setMessages(prev => [...prev, userMsg])
    setInput('')
    setIsTyping(true)

    // Simulate agent response
    setTimeout(() => {
      const responseKey = Object.keys(MOCK_RESPONSES).find(k => input.includes(k)) ?? 'default'
      const agentConfig = AGENT_OPTIONS.find(a => a.id === selectedAgent)!
      const response = MOCK_RESPONSES[responseKey] ?? `收到你的消息。作为 ${agentConfig.name}，我正在处理中。让我检查一下当前项目状态...\n\n当前没有紧急事项需要处理。你可以询问我关于进度、风险、或阻塞项的信息。`

      const assistantMsg: ChatMessage = {
        id: `a_${Date.now()}`,
        role: 'assistant',
        content: response,
        timestamp: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        agentName: agentConfig.name,
        events: ['agent.tool_call', 'project.task.read', 'agent.completed'],
      }
      setMessages(prev => [...prev, assistantMsg])
      setIsTyping(false)
    }, 1200)
  }

  return (
    <div className="flex h-full">
      {/* Chat Area */}
      <div className="flex-1 flex flex-col">
        {/* Header */}
        <div className="h-14 flex items-center justify-between px-6 border-b border-border">
          <div className="flex items-center gap-2">
            <Bot size={16} className="text-primary" />
            <span className="text-sm font-medium">Agent Chat</span>
            <span className="text-[10px] font-mono text-muted-foreground">— Zero-Alignment Interface</span>
          </div>
          <div className="flex items-center gap-1.5">
            {AGENT_OPTIONS.map(agent => (
              <button
                key={agent.id}
                onClick={() => setSelectedAgent(agent.id)}
                className={cn(
                  'text-[10px] font-mono px-2.5 py-1 rounded-md transition-colors',
                  selectedAgent === agent.id
                    ? cn('bg-primary/10', agent.color, 'border border-primary/20')
                    : 'bg-secondary text-muted-foreground hover:text-foreground',
                )}
              >
                {agent.name}
              </button>
            ))}
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-auto px-6 py-4 space-y-4">
          {messages.map(msg => (
            <div key={msg.id} className={cn(
              'flex gap-3',
              msg.role === 'user' ? 'flex-row-reverse' : 'flex-row',
            )}>
              {/* Avatar */}
              {msg.role !== 'system' && (
                <div className={cn(
                  'w-7 h-7 rounded-md flex items-center justify-center flex-shrink-0 mt-0.5',
                  msg.role === 'assistant' ? 'bg-primary/10' : 'bg-human/10',
                )}>
                  {msg.role === 'assistant'
                    ? <Bot size={14} className="text-primary" />
                    : <User size={14} className="text-human" />
                  }
                </div>
              )}

              {/* Content */}
              <div className={cn(
                'max-w-[70%] rounded-lg px-4 py-3',
                msg.role === 'system' ? 'bg-secondary text-muted-foreground text-xs mx-auto' :
                msg.role === 'user' ? 'bg-primary/10 text-foreground' :
                'bg-card border border-border',
              )}>
                {msg.agentName && (
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <span className="text-[10px] font-mono text-primary">{msg.agentName}</span>
                    <span className="text-[9px] font-mono text-muted-foreground">{msg.timestamp}</span>
                  </div>
                )}
                <div className="text-sm whitespace-pre-wrap leading-relaxed">{msg.content}</div>
                {msg.events && msg.events.length > 0 && (
                  <div className="flex gap-1 mt-2 pt-2 border-t border-border/50">
                    {msg.events.map((evt, i) => (
                      <span key={i} className="text-[8px] font-mono px-1.5 py-0.5 rounded bg-secondary text-muted-foreground">
                        {evt}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}

          {isTyping && (
            <div className="flex gap-3">
              <div className="w-7 h-7 rounded-md flex items-center justify-center bg-primary/10">
                <Bot size={14} className="text-primary" />
              </div>
              <div className="bg-card border border-border rounded-lg px-4 py-3">
                <div className="flex gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-primary animate-bounce" style={{ animationDelay: '0ms' }} />
                  <span className="w-1.5 h-1.5 rounded-full bg-primary animate-bounce" style={{ animationDelay: '150ms' }} />
                  <span className="w-1.5 h-1.5 rounded-full bg-primary animate-bounce" style={{ animationDelay: '300ms' }} />
                </div>
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        {/* Input */}
        <div className="h-16 flex items-center gap-3 px-6 border-t border-border">
          <div className="flex-1 relative">
            <input
              type="text"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSend()}
              placeholder="Ask the agent about project status, risks, blockers..."
              className="w-full bg-secondary border border-border rounded-lg px-4 py-2.5 text-sm
                placeholder:text-muted-foreground focus:outline-none focus:border-primary/50 transition-colors"
            />
          </div>
          <button
            onClick={handleSend}
            disabled={!input.trim() || isTyping}
            className="w-10 h-10 rounded-lg bg-primary text-primary-foreground flex items-center justify-center
              hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <Send size={16} />
          </button>
        </div>
      </div>

      {/* Side Panel: Quick Actions */}
      <div className="w-56 border-l border-border p-4 space-y-3">
        <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Quick Prompts</h3>
        {[
          { label: 'Sprint 进度', icon: '📊' },
          { label: '风险分析', icon: '🔴' },
          { label: '阻塞项', icon: '🚨' },
          { label: '今日摘要', icon: '📋' },
          { label: '团队负载', icon: '⚡' },
        ].map(prompt => (
          <button
            key={prompt.label}
            onClick={() => { setInput(prompt.label); }}
            className="w-full text-left px-3 py-2 rounded-md bg-secondary hover:bg-primary/10 hover:text-primary
              text-xs transition-colors flex items-center gap-2"
          >
            <span>{prompt.icon}</span>
            {prompt.label}
          </button>
        ))}

        <div className="pt-3 mt-3 border-t border-border">
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">Agent Info</h3>
          <div className="space-y-1.5 text-xs">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Model</span>
              <span className="font-mono">claude-sonnet</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Level</span>
              <span className="font-mono text-primary">L3</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Tools</span>
              <span className="font-mono">7 available</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Context</span>
              <span className="font-mono">~12k tokens</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
