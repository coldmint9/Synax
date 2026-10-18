import { businessStore as store, businessKey } from '../../infrastructure/persistence/business-store.js';
interface Preference {skillId:string;scope:string;enabled:boolean}
export const skillPreferences = {
  disabledIds(projectId?:string):Set<string> {return new Set(store.list<Preference>('skill-preferences').filter(r=>!r.enabled && (!r.scope || r.scope===projectId)).map(r=>r.skillId));},
  setEnabled(skillId:string,enabled:boolean,projectId?:string):void {
    const scope=skillId.startsWith('project/')?projectId:'';
    if(scope===undefined) throw new Error('Project skill requires a project id');
    store.put('skill-preferences',businessKey(skillId,scope),{skillId,scope,enabled});
  },
};
