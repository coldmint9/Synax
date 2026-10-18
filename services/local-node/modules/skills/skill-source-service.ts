import { businessStore as store } from '../../infrastructure/persistence/business-store.js';
import type { SkillSourceConfig, SkillSourceRecord, SkillSourceType } from './types.js';

const CORE_SOURCES: Array<Omit<SkillSourceRecord, 'lastSyncAt' | 'lastSyncError' | 'createdAt' | 'updatedAt'>> = [
  {
    id: 'synax-builtin',
    label: 'Local Skills',
    type: 'builtin',
    enabled: true,
    priority: 100,
    readOnly: true,
    config: {},
  },
];

/** Default remote catalog seeded on first run. */
export const DEFAULT_REMOTE_SOURCE: Omit<SkillSourceRecord, 'lastSyncAt' | 'lastSyncError' | 'createdAt' | 'updatedAt'> = {
  id: 'default-remote',
  label: 'skills.sh',
  type: 'skills-sh',
  enabled: true,
  priority: 60,
  readOnly: true,
  config: {
    baseUrl: 'https://skills.sh',
    view: 'all-time',
  },
};

/** @deprecated Use DEFAULT_REMOTE_SOURCE. Kept for tests that import the array shape. */
export const PRESET_REMOTE_SOURCES = [DEFAULT_REMOTE_SOURCE];

export const PROTECTED_SOURCE_IDS = new Set([
  'synax-builtin',
  'default-remote',
]);

const DEFAULT_SOURCES = [...CORE_SOURCES, DEFAULT_REMOTE_SOURCE];

export class SkillSourceService {
  ensureDefaultSources(): void {
    for (const source of DEFAULT_SOURCES) {
      if (store.get('skill-sources',source.id)) continue;
      const now=new Date().toISOString();
      store.put('skill-sources',source.id,{...source,lastSyncAt:null,lastSyncError:null,createdAt:now,updatedAt:now});
    }
  }
  listSources():SkillSourceRecord[] {this.ensureDefaultSources();return store.list<SkillSourceRecord>('skill-sources').sort((a,b)=>b.priority-a.priority || a.label.localeCompare(b.label));}
  getSource(id:string):SkillSourceRecord|null {this.ensureDefaultSources();return store.get<SkillSourceRecord>('skill-sources',id) ?? null;}
  createSource(input:{id:string;label:string;type:SkillSourceType;enabled?:boolean;priority?:number;readOnly?:boolean;config?:SkillSourceConfig}):SkillSourceRecord {
    this.ensureDefaultSources();if(this.getSource(input.id)) throw new Error(`Skill source already exists: ${input.id}`);
    const now=new Date().toISOString(); const record:SkillSourceRecord={...input,enabled:input.enabled ?? true,priority:input.priority ?? 60,readOnly:input.readOnly ?? false,config:input.config ?? {},lastSyncAt:null,lastSyncError:null,createdAt:now,updatedAt:now};
    store.put('skill-sources',input.id,record);return record;
  }
  updateSource(id:string,patch:Partial<Pick<SkillSourceRecord,'label'|'enabled'|'priority'|'readOnly'|'config'>>):SkillSourceRecord {
    const existing=this.getSource(id);if(!existing) throw new Error(`Skill source not found: ${id}`);
    if(PROTECTED_SOURCE_IDS.has(id) && patch.config) throw new Error(`Cannot replace config for protected source: ${id}`);
    const next={...existing,...patch,updatedAt:new Date().toISOString()};store.put('skill-sources',id,next);return next;
  }
  deleteSource(id:string):void {
    if(PROTECTED_SOURCE_IDS.has(id)) throw new Error(`Cannot delete protected source: ${id}`);
    for(const item of store.list<{id:string;source_id:string}>('skill-catalog')) if(item.source_id===id) store.delete('skill-catalog',item.id);
    store.delete('skill-sources',id);
  }
  markSyncResult(id:string,result:{ok:boolean;error?:string}):void {
    const previous=this.getSource(id);if(!previous) throw new Error(`Skill source not found: ${id}`);
    const now=new Date().toISOString();store.put('skill-sources',id,{...previous,lastSyncAt:result.ok?now:null,lastSyncError:result.ok?null:result.error ?? 'Sync failed',updatedAt:now});
  }
}
export const skillSourceService=new SkillSourceService();
