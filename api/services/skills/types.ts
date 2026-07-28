import type { AgentProfileKind, InternalGate } from '../agent-runtime/contracts.js';

export type SkillSourceKind = 'builtin' | 'local' | 'project' | 'remote';
export type SkillSourceType = 'builtin' | 'local' | 'project' | 'well-known' | 'git-index' | 'skills-sh';
export type SkillStatus = 'available' | 'disabled' | 'invalid' | 'update_available';
export type SkillInstallStatus = 'installed' | 'disabled' | 'update_available';

export type SkillInjectionMode = 'on-demand' | 'deterministic';

export interface SkillSourceConfig {
  url?: string;
  repo?: string;
  ref?: string;
  indexPath?: string;
  /** Where SKILL.md paths in the index are resolved from. */
  contentBase?: 'repo-root' | 'index-dir';
  /** Scan a GitHub repo directory for SKILL.md files instead of fetching an index file. */
  scanRoot?: string;
  scanPaths?: string[];
  /** Default search query when browsing skills.sh without a user query (legacy fallback only). */
  defaultQuery?: string;
  /** Leaderboard view for skills.sh v1 list API. */
  view?: 'all-time' | 'trending' | 'hot';
  baseUrl?: string;
  authTokenRef?: string;
}

export interface SkillSourceRecord {
  id: string;
  label: string;
  type: SkillSourceType;
  enabled: boolean;
  priority: number;
  readOnly: boolean;
  config: SkillSourceConfig;
  lastSyncAt: string | null;
  lastSyncError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SkillCatalogEntry {
  id: string;
  sourceId: string;
  name: string;
  description: string;
  version?: string;
  remoteUrl: string;
  contentDigest?: string;
  installCount?: number;
  tags: string[];
  indexedAt: string;
}

export interface SkillInstallRecord {
  id: string;
  sourceId: string;
  name: string;
  version?: string;
  label?: string;
  description: string;
  installPath: string;
  contentDigest?: string;
  appliesTo: AgentProfileKind[];
  requiredCapabilities: string[];
  status: SkillInstallStatus;
  installedAt: string;
  updatedAt: string;
}

export interface SkillSummary {
  id: string;
  name: string;
  label: string;
  description: string;
  sourceId: string;
  sourceKind: SkillSourceKind;
  version: string;
  appliesTo: AgentProfileKind[];
  /** Exact profile ids this skill applies to. Takes precedence over appliesTo when non-empty. */
  profileIds?: string[];
  /** 'deterministic' skills are expanded into the prompt by their owner, not offered for skill.load. */
  injection?: SkillInjectionMode;
  requiredCapabilities: string[];
  permissionHints: InternalGate[];
  status: SkillStatus;
  installPath?: string;
  contentDigest?: string;
  remoteUrl?: string;
  tags?: string[];
  installCount?: number;
  installed?: boolean;
  updateAvailable?: boolean;
}

export interface SkillDetail extends SkillSummary {
  content: string;
}

export interface ParsedSkillFile {
  name: string;
  label: string;
  description: string;
  version: string;
  appliesTo: AgentProfileKind[];
  profileIds: string[];
  injection: SkillInjectionMode;
  requiredCapabilities: string[];
  permissionHints: InternalGate[];
  content: string;
  installPath: string;
}

export interface SkillListQuery {
  profileId?: string;
  projectId?: string;
  q?: string;
  sourceId?: string;
  installedOnly?: boolean;
  limit?: number;
  offset?: number;
}

export interface SkillListResult {
  items: SkillSummary[];
  total: number;
  hasMore: boolean;
  totalExact?: boolean;
}
