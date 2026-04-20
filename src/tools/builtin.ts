/**
 * Synapse Built-in Tools
 *
 * Core tool implementations for the project management agent system.
 * Inherits the tool pattern from clawspring but adds PM-specific tools.
 */

import { z } from 'zod'
import { registerTool, type ToolContext } from './registry.js'
import { AgentCapabilityLevel, TaskStatus } from '../models/types.js'

// ─── File Tools ───────────────────────────────────────────────────────────

registerTool({
  name: 'Read',
  description: 'Read file contents with line numbers. Use limit/offset for large files.',
  inputSchema: z.object({
    file_path: z.string().describe('Absolute file path'),
    limit: z.number().optional().describe('Max lines to read'),
    offset: z.number().optional().describe('Start line (0-indexed)'),
  }),
  readOnly: true,
  concurrentSafe: true,
  minAutoLevel: AgentCapabilityLevel.Observer,
  execute: async (params) => {
    const { readFileSync } = await import('fs')
    const { existsSync } = await import('fs')
    if (!existsSync(params.file_path)) return `Error: file not found: ${params.file_path}`
    try {
      const content = readFileSync(params.file_path, 'utf-8')
      const lines = content.split('\n')
      const start = params.offset ?? 0
      const chunk = params.limit ? lines.slice(start, start + params.limit) : lines.slice(start)
      return chunk.map((line, i) => `${start + i + 1}\t${line}`).join('\n')
    } catch (e) {
      return `Error: ${e}`
    }
  },
})

registerTool({
  name: 'Write',
  description: 'Write content to a file, creating parent directories as needed.',
  inputSchema: z.object({
    file_path: z.string(),
    content: z.string(),
  }),
  readOnly: false,
  concurrentSafe: false,
  minAutoLevel: AgentCapabilityLevel.Collaborator,
  execute: async (params) => {
    const { writeFileSync, mkdirSync } = await import('fs')
    const { dirname } = await import('path')
    try {
      mkdirSync(dirname(params.file_path), { recursive: true })
      writeFileSync(params.file_path, params.content, 'utf-8')
      const lines = params.content.split('\n').length
      return `Created ${params.file_path} (${lines} lines)`
    } catch (e) {
      return `Error: ${e}`
    }
  },
})

registerTool({
  name: 'Edit',
  description: 'Replace exact text in a file. old_string must match exactly.',
  inputSchema: z.object({
    file_path: z.string(),
    old_string: z.string().describe('Exact text to replace'),
    new_string: z.string().describe('Replacement text'),
    replace_all: z.boolean().optional().describe('Replace all occurrences'),
  }),
  readOnly: false,
  concurrentSafe: false,
  minAutoLevel: AgentCapabilityLevel.Collaborator,
  execute: async (params) => {
    const { readFileSync, writeFileSync } = await import('fs')
    try {
      const content = readFileSync(params.file_path, 'utf-8')
      const count = content.split(params.old_string).length - 1
      if (count === 0) return 'Error: old_string not found in file.'
      if (count > 1 && !params.replace_all) {
        return `Error: old_string appears ${count} times. Use replace_all=true or add more context.`
      }
      const newContent = params.replace_all
        ? content.replaceAll(params.old_string, params.new_string)
        : content.replace(params.old_string, params.new_string)
      writeFileSync(params.file_path, newContent, 'utf-8')
      return `Changes applied to ${params.file_path}`
    } catch (e) {
      return `Error: ${e}`
    }
  },
})

registerTool({
  name: 'Bash',
  description: 'Execute a shell command. Returns stdout+stderr.',
  inputSchema: z.object({
    command: z.string(),
    timeout: z.number().optional().describe('Seconds before timeout (default 30)'),
  }),
  readOnly: false,
  concurrentSafe: false,
  minAutoLevel: AgentCapabilityLevel.Executor,
  execute: async (params) => {
    const { execSync } = await import('child_process')
    try {
      const result = execSync(params.command, {
        timeout: (params.timeout ?? 30) * 1000,
        encoding: 'utf-8',
        cwd: process.cwd(),
      })
      return result.trim() || '(no output)'
    } catch (e: any) {
      const out = (e.stdout ?? '') + (e.stderr ? `\n[stderr]\n${e.stderr}` : '')
      return out.trim() || `Error: ${e.message}`
    }
  },
})

registerTool({
  name: 'Glob',
  description: 'Find files matching a glob pattern.',
  inputSchema: z.object({
    pattern: z.string().describe('Glob pattern e.g. **/*.ts'),
    path: z.string().optional().describe('Base directory'),
  }),
  readOnly: true,
  concurrentSafe: true,
  minAutoLevel: AgentCapabilityLevel.Observer,
  execute: async (params) => {
    const { globSync } = await import('fs')
    const { sync: globSyncFn } = await import('glob')
    try {
      const files = globSyncFn(params.pattern, { cwd: params.path ?? process.cwd() })
      return files.join('\n') || '(no matches)'
    } catch {
      // Fallback to simple directory listing
      const { readdirSync, statSync } = await import('fs')
      const { join } = await import('path')
      const base = params.path ?? process.cwd()
      try {
        const entries = readdirSync(base, { recursive: true }) as string[]
        const filtered = entries.filter(f => {
          if (params.pattern === '**/*') return true
          const ext = params.pattern.replace('**/*', '.')
          return f.endsWith(ext)
        })
        return filtered.slice(0, 100).join('\n') || '(no matches)'
      } catch (e) {
        return `Error: ${e}`
      }
    }
  },
})

registerTool({
  name: 'Grep',
  description: 'Search file contents with regex.',
  inputSchema: z.object({
    pattern: z.string().describe('Regex pattern'),
    path: z.string().optional().describe('File or directory to search'),
    output_mode: z.enum(['content', 'files_with_matches', 'count']).optional(),
  }),
  readOnly: true,
  concurrentSafe: true,
  minAutoLevel: AgentCapabilityLevel.Observer,
  execute: async (params) => {
    // Simplified grep implementation
    const { execSync } = await import('child_process')
    try {
      const cmd = params.output_mode === 'count'
        ? `grep -rc "${params.pattern}" ${params.path ?? '.'} 2>/dev/null | head -50`
        : params.output_mode === 'files_with_matches'
          ? `grep -rl "${params.pattern}" ${params.path ?? '.'} 2>/dev/null | head -50`
          : `grep -rn "${params.pattern}" ${params.path ?? '.'} 2>/dev/null | head -50`
      const result = execSync(cmd, { encoding: 'utf-8', timeout: 10000 })
      return result.trim() || '(no matches)'
    } catch {
      return '(no matches)'
    }
  },
})

// ─── Project Management Tools ─────────────────────────────────────────────

registerTool({
  name: 'TaskCreate',
  description: 'Create a new task in the project.',
  inputSchema: z.object({
    title: z.string().describe('Task title'),
    description: z.string().describe('What needs to be done'),
    priority: z.enum(['critical', 'high', 'medium', 'low']).optional(),
    assignee: z.string().optional().describe('RoleSlot ID to assign to'),
    milestone: z.string().optional().describe('Milestone ID'),
    labels: z.array(z.string()).optional(),
  }),
  readOnly: false,
  concurrentSafe: false,
  minAutoLevel: AgentCapabilityLevel.Executor,
  execute: async (params, context) => {
    // In real implementation, this writes to the database
    const taskId = `task_${Date.now()}`
    return JSON.stringify({ taskId, ...params, status: 'backlog' })
  },
})

registerTool({
  name: 'TaskRead',
  description: 'Read task details or list tasks.',
  inputSchema: z.object({
    task_id: z.string().optional().describe('Specific task ID, or omit for all tasks'),
    status: z.enum(['backlog', 'ready', 'in_progress', 'in_review', 'testing', 'done', 'cancelled']).optional(),
    assignee: z.string().optional().describe('Filter by assignee RoleSlot ID'),
  }),
  readOnly: true,
  concurrentSafe: true,
  minAutoLevel: AgentCapabilityLevel.Observer,
  execute: async (params) => {
    // In real implementation, this queries the database
    return `Tasks query: ${JSON.stringify(params)} (results would come from DB)`
  },
})

registerTool({
  name: 'TaskUpdate',
  description: 'Update task status, assignment, or other fields.',
  inputSchema: z.object({
    task_id: z.string(),
    status: z.enum(['backlog', 'ready', 'in_progress', 'in_review', 'testing', 'done', 'cancelled']).optional(),
    assignee: z.string().optional(),
    description: z.string().optional(),
    title: z.string().optional(),
  }),
  readOnly: false,
  concurrentSafe: false,
  minAutoLevel: AgentCapabilityLevel.Executor,
  execute: async (params) => {
    return `Task ${params.task_id} updated: ${JSON.stringify(params)}`
  },
})

registerTool({
  name: 'MilestoneRead',
  description: 'Read milestone details and progress.',
  inputSchema: z.object({
    milestone_id: z.string().optional(),
  }),
  readOnly: true,
  concurrentSafe: true,
  minAutoLevel: AgentCapabilityLevel.Observer,
  execute: async (params) => {
    return `Milestones query: ${JSON.stringify(params)}`
  },
})

registerTool({
  name: 'SprintRead',
  description: 'Read current sprint state and velocity.',
  inputSchema: z.object({}),
  readOnly: true,
  concurrentSafe: true,
  minAutoLevel: AgentCapabilityLevel.Observer,
  execute: async (_params, context) => {
    return `Sprint state for project ${context.projectId}`
  },
})

registerTool({
  name: 'WikiRead',
  description: 'Read project wiki page.',
  inputSchema: z.object({
    page: z.string().optional().describe('Page name, or omit for index'),
  }),
  readOnly: true,
  concurrentSafe: true,
  minAutoLevel: AgentCapabilityLevel.Observer,
  execute: async (params) => {
    return `Wiki page: ${params.page ?? 'index'}`
  },
})

registerTool({
  name: 'WikiUpdate',
  description: 'Update or create a project wiki page.',
  inputSchema: z.object({
    page: z.string().describe('Page name'),
    content: z.string().describe('Markdown content'),
  }),
  readOnly: false,
  concurrentSafe: false,
  minAutoLevel: AgentCapabilityLevel.Collaborator,
  execute: async (params) => {
    return `Wiki page "${params.page}" updated (${params.content.length} chars)`
  },
})

registerTool({
  name: 'Notify',
  description: 'Send a notification to a specific role or all roles.',
  inputSchema: z.object({
    target_role: z.string().optional().describe('Role type to notify, or omit for all'),
    message: z.string().describe('Notification content'),
    urgency: z.enum(['low', 'medium', 'high']).optional(),
  }),
  readOnly: false,
  concurrentSafe: true,
  minAutoLevel: AgentCapabilityLevel.Executor,
  execute: async (params, context) => {
    return `Notification sent to ${params.target_role ?? 'all'}: ${params.message}`
  },
})

registerTool({
  name: 'MemorySave',
  description: 'Save a persistent memory entry (user or project scope).',
  inputSchema: z.object({
    name: z.string().describe('Memory name'),
    content: z.string().describe('Memory content'),
    description: z.string().describe('One-line description'),
    type: z.enum(['user', 'feedback', 'project', 'reference']).optional(),
    scope: z.enum(['user', 'project']).optional(),
  }),
  readOnly: false,
  concurrentSafe: false,
  minAutoLevel: AgentCapabilityLevel.Collaborator,
  execute: async (params, context) => {
    return `Memory saved: "${params.name}" (${params.scope ?? 'project'} scope)`
  },
})

registerTool({
  name: 'MemorySearch',
  description: 'Search memories by keyword.',
  inputSchema: z.object({
    query: z.string().describe('Search query'),
    scope: z.enum(['user', 'project', 'all']).optional(),
  }),
  readOnly: true,
  concurrentSafe: true,
  minAutoLevel: AgentCapabilityLevel.Observer,
  execute: async (params) => {
    return `Memory search for "${params.query}" in ${params.scope ?? 'all'} scope`
  },
})

registerTool({
  name: 'GitStatus',
  description: 'Get current git repository status, branch, and recent commits.',
  inputSchema: z.object({}),
  readOnly: true,
  concurrentSafe: true,
  minAutoLevel: AgentCapabilityLevel.Observer,
  execute: async (_params, context) => {
    const { execSync } = await import('child_process')
    try {
      const branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf-8' }).trim()
      const status = execSync('git status --short', { encoding: 'utf-8' }).trim()
      const log = execSync('git log --oneline -5', { encoding: 'utf-8' }).trim()
      let result = `Branch: ${branch}\n`
      if (status) result += `Status:\n${status.split('\n').map(l => `  ${l}`).join('\n')}\n`
      result += `Recent commits:\n${log.split('\n').map(l => `  ${l}`).join('\n')}`
      return result
    } catch {
      return 'Not in a git repository'
    }
  },
})

// ─── Safe Bash Check (mirrors clawspring) ─────────────────────────────────

const SAFE_BASH_PREFIXES = [
  'ls', 'cat', 'head', 'tail', 'wc', 'pwd', 'echo', 'which', 'env',
  'git log', 'git status', 'git diff', 'git show', 'git branch',
  'find ', 'grep ', 'rg ', 'fd ',
  'python ', 'node ',
  'df ', 'du ', 'ps ',
]

export function isSafeBash(command: string): boolean {
  const c = command.trim()
  return SAFE_BASH_PREFIXES.some(p => c.startsWith(p))
}
