import { describe, expect, it } from 'vitest'
import { createMcpDraft, readMcpDraft } from './mcp-draft'

function jsonDraft(value: unknown) {
  return { ...createMcpDraft(), json: JSON.stringify(value) }
}

describe('MCP configuration normalization', () => {
  it('initializes edits in manual mode and keeps internal identifiers out of JSON', () => {
    const draft = createMcpDraft({ id: 'existing', name: 'Example', transport: 'http', command: '', url: 'https://example.com/mcp' });
    expect(draft.method).toBe('manual');
    expect(JSON.parse(draft.json).mcpServers.Example.id).toBeUndefined();
    draft.method = 'json';
    expect(readMcpDraft(draft, 'existing').mcp).toMatchObject({ id: 'existing', name: 'Example', transport: 'http' });
  });
  it('reads a standard command config without manual name or description', () => {
    const draft = jsonDraft({ mcpServers: { demo: { command: 'npx', args: ['-y', 'demo'], env: { TOKEN: 'example' } } } })
    draft.manual.env = 'broken'
    expect(readMcpDraft(draft)).toEqual({ name: 'demo', description: '', mcp: { id: 'custom-preview', name: 'demo', transport: 'stdio', command: 'npx', args: ['-y', 'demo'], env: { TOKEN: 'example' } } })
  })
  it('requires an explicit choice for multiple servers and only validates the chosen one', () => {
    const draft = jsonDraft({ mcpServers: { broken: { args: 1 }, remote: { type: 'streamable-http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer example' } } } })
    expect(() => readMcpDraft(draft)).toThrow(/请选择/)
    draft.selectedServer = 'remote'
    expect(readMcpDraft(draft, 'existing-id').mcp).toMatchObject({ id: 'existing-id', transport: 'http', command: '', url: 'https://example.com/mcp' })
  })
  it('accepts a bare server config with a separate name', () => {
    const draft = jsonDraft({ command: 'node' })
    expect(() => readMcpDraft(draft)).toThrow(/名称/)
    draft.jsonName = 'Local'
    expect(readMcpDraft(draft).name).toBe('Local')
  })
  it.each([null, [], { mcpServers: [] }, { mcpServers: {} }, { command: 'node', args: 'bad' }, { command: 'node', env: { TOKEN: 1 } }, { command: 'node', url: 'https://example.com' }, { type: 'sse', url: 'https://example.com' }, { url: 'file:///tmp/x' }, { url: 'https://user:password@example.com' }])('rejects invalid JSON configuration %j', value => {
    const draft = jsonDraft(value)
    draft.jsonName = 'Example'
    expect(() => readMcpDraft(draft)).toThrow()
  })
  it('ignores JSON and inactive transport drafts when using manual configuration', () => {
    const draft = createMcpDraft()
    draft.method = 'manual'
    draft.json = '{invalid'
    Object.assign(draft.manual, { name: 'Local', command: 'node', headers: '{bad', url: 'bad-url' })
    expect(readMcpDraft(draft).mcp).toMatchObject({ transport: 'stdio', command: 'node' })
    Object.assign(draft.manual, { transport: 'http', url: 'https://example.com/mcp', headers: '{}', env: '{bad' })
    const result = readMcpDraft(draft).mcp
    expect(result).toMatchObject({ transport: 'http', url: 'https://example.com/mcp', command: '' })
    expect(result.env).toBeUndefined()
    draft.manual.headers = '{bad'
    expect(() => readMcpDraft(draft)).toThrow()
  })
})
