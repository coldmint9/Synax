import {afterEach, expect, it, vi} from 'vitest';
import {agentRuntimeRoutes} from '../agent-runtime.js';
import {agentRuntimeStore} from '../../../modules/agent-runtime/session-store.js';
import {runtimeFacade} from '../../../modules/agent-runtime/sidecar/runtime-facade.js';

afterEach(()=>vi.restoreAllMocks());
it('serves a history page without first loading the execution working set', async()=>{
  const sessions=vi.spyOn(agentRuntimeStore,'hydrateSessions').mockRejectedValue(new Error('must not load all sessions'));
  const hydrate=vi.spyOn(agentRuntimeStore,'hydrateSession').mockRejectedValue(new Error('must not drain all history'));
  vi.spyOn(runtimeFacade,'uiSnapshotAuthoritative').mockResolvedValue({session:{id:'s',profileId:'executor',status:'completed'},run:null} as never);
  const page={messages:[{id:'m'}],historyWindow:{syncCursor:'next',hasMoreChanges:true}};
  const history=vi.spyOn(runtimeFacade,'historyWindowAuthoritative').mockResolvedValue(page as never);
  const response=await agentRuntimeRoutes.request('http://localhost/sessions/s/history-window?since=previous');
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(page);
  expect(history).toHaveBeenCalledWith('s',undefined,'previous',false);
  expect(sessions).not.toHaveBeenCalled();
  expect(hydrate).not.toHaveBeenCalled();
});
it('retains archived-session access checks on the paged read path',async()=>{
  vi.spyOn(runtimeFacade,'uiSnapshotAuthoritative').mockResolvedValue({session:{id:'s',status:'completed',sessionMetadata:{archivedAt:'now'}}} as never);
  const history=vi.spyOn(runtimeFacade,'historyWindowAuthoritative');
  const response=await agentRuntimeRoutes.request('http://localhost/sessions/s/history-window');
  expect(response.status).toBe(404);
  expect(history).not.toHaveBeenCalled();
});
