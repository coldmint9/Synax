import { businessStore as store, businessKey as key } from '../../infrastructure/persistence/business-store.js';
import { agentRuntimeStore } from './session-store.js';
export interface ProjectToolGrant {projectId:string;toolId:string;permissionId:string;createdAt:string}
export function listProjectToolGrants(projectId:string):ProjectToolGrant[] {return store.list<ProjectToolGrant>('tool-grants').filter(g=>g.projectId===projectId).sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.toolId.localeCompare(b.toolId));}
export function hasProjectToolGrant(sessionId:string,toolId:string):boolean {const session=agentRuntimeStore.tryGetSession(sessionId);return Boolean(session && toolId && store.get('tool-grants',key(session.projectId,toolId)));}
export function grantedToolId(input:{sessionId:string;metadata?:Record<string,unknown>}):string|null {const id=input.metadata?.toolId;return !input.metadata?.source && typeof id==='string' && hasProjectToolGrant(input.sessionId,id)?id:null;}
export function grantProjectTool(sessionId:string,toolId:string,permissionId:string):void {
  const projectId=agentRuntimeStore.getSession(sessionId).projectId;
  store.put('tool-grants',key(projectId,toolId),{projectId,toolId,permissionId,createdAt:new Date().toISOString()});
}
export function revokeProjectToolGrant(projectId:string,toolId:string):boolean {return store.delete('tool-grants',key(projectId,toolId));}
export function revokeAllProjectToolGrants(projectId:string):void {for(const g of listProjectToolGrants(projectId)) store.delete('tool-grants',key(projectId,g.toolId));}
