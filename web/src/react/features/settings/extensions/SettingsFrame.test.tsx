import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SettingsFrame } from './SettingsFrame'

describe('settings navigation', () => {
  it('exposes dedicated MCP and Computer Use menus in global settings', () => {
    render(
      <SettingsFrame section="general" onSelect={vi.fn()}>
        <div />
      </SettingsFrame>,
    )
    expect(screen.getByRole('button', { name: /MCP 服务器|MCP servers/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /电脑操作|Computer Use/ })).toBeInTheDocument()
    // The extension centre MCP entry stays intact next to the new menu.
    expect(screen.getByRole('button', { name: 'MCP' })).toBeInTheDocument()
  })

  it('hides the global MCP and Computer Use menus in project settings', () => {
    render(
      <SettingsFrame section="general" onSelect={vi.fn()} projectMode projectId="p1">
        <div />
      </SettingsFrame>,
    )
    expect(screen.queryByRole('button', { name: /MCP 服务器|MCP servers/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /电脑操作|Computer Use/ })).toBeNull()
  })

  it('reports the selected section through onSelect', async () => {
    const onSelect = vi.fn()
    render(
      <SettingsFrame section="general" onSelect={onSelect}>
        <div />
      </SettingsFrame>,
    )
    screen.getByRole('button', { name: /MCP 服务器|MCP servers/ }).click()
    expect(onSelect).toHaveBeenCalledWith('mcpServers')
  })

  it('pins the LLM provider menu in the frequently used group', async () => {
    const onSelect = vi.fn()
    render(
      <SettingsFrame section="general" onSelect={onSelect}>
        <div />
      </SettingsFrame>,
    )
    const entry = screen.getByRole('button', { name: /LLM 供应商|LLM Providers/ })
    entry.click()
    expect(onSelect).toHaveBeenCalledWith('llmProviders')
  })

  it('hides the pinned LLM provider menu in project settings', () => {
    render(
      <SettingsFrame section="general" onSelect={vi.fn()} projectMode projectId="p1">
        <div />
      </SettingsFrame>,
    )
    expect(screen.queryByRole('button', { name: /LLM 供应商|LLM Providers/ })).toBeNull()
  })
})
