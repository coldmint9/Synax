import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockTryGetSession = vi.fn();

vi.mock('../../agent-runtime/session-store.js', () => ({
  agentRuntimeStore: {
    tryGetSession: (...args: unknown[]) => mockTryGetSession(...args),
  },
}));

vi.mock('../../agent-runtime/profile-service.js', () => ({
  profileService: {
    maybeGet: vi.fn(),
  },
}));

import { profileService } from '../../agent-runtime/profile-service.js';
import {
  profileHasWikiAgentReadTools,
  wikiAgentToolProvider,
} from '../wiki-agent-tool-provider.js';

describe('wikiAgentToolProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wikiAgentToolProvider.resetForTests();
  });

  it('profileHasWikiAgentReadTools detects wiki read capabilities', () => {
    expect(
      profileHasWikiAgentReadTools({
        allowedCapabilities: ['bash', 'wiki.search_content'],
      } as never),
    ).toBe(true);
    expect(
      profileHasWikiAgentReadTools({
        allowedCapabilities: ['bash', 'grep.search'],
      } as never),
    ).toBe(false);
  });

  it('returns wiki tools lazily per project for wiki-capable profiles', () => {
    mockTryGetSession.mockReturnValue({ projectId: 'proj-a', profileId: 'explorer' });
    vi.mocked(profileService.maybeGet).mockReturnValue({
      id: 'explorer',
      allowedCapabilities: ['wiki.search_content', 'wiki.read_section'],
    } as never);

    const first = wikiAgentToolProvider.getTools('ars_1');
    const second = wikiAgentToolProvider.getTools('ars_2');

    expect(first.map((t) => t.id)).toEqual([
      'wiki.get_snapshot',
      'wiki.get_tree',
      'wiki.list_documents',
      'wiki.read_document',
      'wiki.read_section',
      'wiki.get_references',
      'wiki.search_content',
      'wiki.search_batch',
    ]);
    expect(second).toBe(first);
  });

  it('returns empty when profile has no wiki read tools', () => {
    mockTryGetSession.mockReturnValue({ projectId: 'proj-a', profileId: 'reviewer' });
    vi.mocked(profileService.maybeGet).mockReturnValue({
      id: 'reviewer',
      allowedCapabilities: ['bash', 'grep.search'],
    } as never);

    expect(wikiAgentToolProvider.getTools('ars_3')).toEqual([]);
  });

  it('caches separately per project', () => {
    mockTryGetSession
      .mockReturnValueOnce({ projectId: 'proj-a', profileId: 'explorer' })
      .mockReturnValueOnce({ projectId: 'proj-b', profileId: 'explorer' });
    vi.mocked(profileService.maybeGet).mockReturnValue({
      id: 'explorer',
      allowedCapabilities: ['wiki.search_content'],
    } as never);

    const projA = wikiAgentToolProvider.getTools('ars_a');
    const projB = wikiAgentToolProvider.getTools('ars_b');
    expect(projA).not.toBe(projB);
  });
});
