import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSession, AgentRun } from '../../../../lib/api/agentRuntime'
import { useAgentSessionStore } from '../agentSessionStore'
import { useWikiStore } from '../../../state/wikiStore'
import { useSessionComposerSelection, useSessionComposerSelections } from '../useSessionComposerSelection'
import { sessionRuntimeSelection } from '../sessionRuntimeSelection'

vi.mock('../../../../lib/api/runtimeEventBus', () => ({ subscribe: () => vi.fn() }))
vi.mock('../../../../lib/api/sessionLiveClient', () => ({ ensureSessionLiveSubscription: vi.fn(), releaseSessionLiveSubscription: vi.fn() }))
const a = { id: 'a', projectId: 'p', model: 'model-a', reasoningEffort: 'low', sessionMetadata: {} } as AgentSession
const b = { ...a, id: 'b', model: 'model-b', reasoningEffort: 'high' } as AgentSession

beforeEach(() => {
  useSessionComposerSelections.setState({ selections: {} })
  useAgentSessionStore.setState({ ...useAgentSessionStore.getInitialState() })
  useWikiStore.setState({ goalComposerProviderId: 'api', goalComposerModelId: 'draft', goalComposerReasoningEffort: 'high' })
})

describe('session composer selection', () => {
  it.each(['native', 'codex', 'codex-acp'] as const)('restores independent unsent choices after switching and remounting: %s', backend => {
    const hook = renderHook(({ session }) => useSessionComposerSelection('p', session, backend, null, [], null), { initialProps: { session: a } })
    expect(hook.result.current.modelId).toBe('model-a')
    act(() => hook.result.current.setSelection({ providerId: 'chosen', modelId: 'next-a', cliModel: 'cli-a', reasoningEffort: 'xhigh' }))
    hook.rerender({ session: b })
    expect(hook.result.current.modelId).toBe('model-b')
    expect(hook.result.current.reasoningEffort).toBe('high')
    act(() => hook.result.current.setSelection({ modelId: 'next-b', cliModel: 'cli-b', reasoningEffort: 'medium' }))
    hook.rerender({ session: a })
    expect(hook.result.current).toMatchObject({ providerId: 'chosen', modelId: 'next-a', cliModel: 'cli-a', reasoningEffort: 'xhigh' })
    hook.unmount()
    const restored = renderHook(() => useSessionComposerSelection('p', a, backend, null, [], null))
    expect(restored.result.current).toMatchObject({ modelId: 'next-a', cliModel: 'cli-a', reasoningEffort: 'xhigh' })
  })

  it('keeps live execution independent from edits and retains choices when runtime refreshes', () => {
    const run = { id: 'run', sessionId: 'a', model: 'running-model', startedAt: '2026-01-01', metadata: { reasoningEffort: 'medium' } } as AgentRun
    useAgentSessionStore.setState({ selectedSessionId: 'a', runs: [run] })
    const hook = renderHook(() => useSessionComposerSelection('p', a, 'native', null, [], null))
    expect(hook.result.current).toMatchObject({ modelId: 'running-model', reasoningEffort: 'medium' })
    act(() => hook.result.current.setSelection({ modelId: 'future-model', reasoningEffort: 'xhigh' }))
    expect(sessionRuntimeSelection(a, [run], [])).toEqual({ model: 'running-model', reasoningEffort: 'medium' })
    act(() => useAgentSessionStore.setState({ runs: [{ ...run, model: 'updated-runtime' }] }))
    expect(hook.result.current).toMatchObject({ modelId: 'future-model', reasoningEffort: 'xhigh' })
    expect(useWikiStore.getState().goalComposerModelId).toBe('draft')
  })

  it('preserves unknown runtime effort and ignores other sessions', () => {
    const run = { id: 'run', sessionId: 'a', model: 'actual', startedAt: '2026-01-01', metadata: { reasoningEffort: null } } as AgentRun
    expect(sessionRuntimeSelection(a, [run, { ...run, sessionId: 'b', model: 'wrong', startedAt: '2027' }], []))
      .toEqual({ model: 'actual', reasoningEffort: null })
  })
})
