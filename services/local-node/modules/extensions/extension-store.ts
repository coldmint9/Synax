import { businessStore as store, businessKey as key } from '../../infrastructure/persistence/business-store.js';
import type { ExtensionDefinition, ExtensionKind, ExtensionState } from './types.js';
interface DefinitionRecord { projectId: string; definition: ExtensionDefinition }
export const extensionStore = {
  state(projectId: string | undefined, kind: ExtensionKind, id: string, fallback: ExtensionState = {installed:true,enabled:true}): ExtensionState {
    if (!projectId) return fallback;
    const value=store.get<ExtensionState>('extension-state',key(projectId,kind,id));
    return value ? {installed:value.installed,enabled:value.installed && value.enabled}:fallback;
  },
  active(projectId: string | undefined, kind: ExtensionKind, id:string):boolean {const state=this.state(projectId,kind,id);return state.installed && state.enabled;},
  setState(projectId:string,kind:ExtensionKind,id:string,state:ExtensionState):void {
    store.put('extension-state',key(projectId,kind,id),{projectId,kind,id,installed:state.installed,enabled:state.installed && state.enabled});
  },
  definitions(projectId:string,kind?:ExtensionKind):ExtensionDefinition[] {return store.list<DefinitionRecord>('extension-definitions').filter(r=>r.projectId===projectId && (!kind || r.definition.kind===kind)).map(r=>r.definition);},
  definition(projectId:string,kind:ExtensionKind,id:string):ExtensionDefinition|undefined {return store.get<DefinitionRecord>('extension-definitions',key(projectId,kind,id))?.definition;},
  save(projectId:string,definition:ExtensionDefinition):void {store.put('extension-definitions',key(projectId,definition.kind,definition.id),{projectId,definition});},
  registerSkillPackage(installId:string):void {store.put('extension-packages',installId,{installId});},
  isSkillPackage(installId:string):boolean {return Boolean(store.get('extension-packages',installId));},
  directories(projectId:string):string[] {return store.get<{directories:string[]}>('extension-directories',projectId)?.directories ?? [];},
  setDirectories(projectId:string,directories:string[]):void {store.put('extension-directories',projectId,{projectId,directories});},
};
