import { render,fireEvent,screen,waitFor } from '@testing-library/react';
import { beforeEach,afterEach,describe,expect,it,vi } from 'vitest';
import { SessionHistoryProvider,useSessionHistory } from '../SessionHistoryContext';
import { conversationHistoryApi } from '../../../../lib/api/conversationHistory';
import { useShellStore } from '../../../state/shellStore';
import { useAgentSessionStore } from '../state/agentSessionStore';
import type { AgentSession } from '../../../../lib/api/agentRuntime';
vi.mock('../useConversationHistoryVisit',()=>({useConversationHistoryVisit:vi.fn()}));
vi.mock('../../../../lib/api/runtimeEventBus',()=>({subscribe:()=>()=>{}}));
vi.mock('../../../../lib/api/conversationHistory',()=>({conversationHistoryApi:{list:vi.fn(),preview:vi.fn(),apply:vi.fn()}}));
const cp={id:'cp',kind:'reply' as const,messageId:'msg',stepId:null,available:true,reason:null,hasLaterHistory:true,initialInput:false};
const session={id:'s',status:'completed',sessionMetadata:{backend:{id:'native'}}} as unknown as AgentSession;
function Trigger({action='rollback' as const}){const history=useSessionHistory();return <button onClick={()=>void history?.request(action,cp,'Edited')}>Open</button>;}
beforeEach(()=>{
 vi.clearAllMocks();useShellStore.setState(s=>({preferences:{...s.preferences,locale:'zh'}}));
 vi.mocked(conversationHistoryApi.list).mockResolvedValue({sessionId:'s',revision:0,reason:null,checkpoints:[cp]});
 vi.mocked(conversationHistoryApi.preview).mockImplementation(async(_session,_checkpoint,_action,files=true)=>({checkpointId:'cp',revision:0,removedMessages:2,files:[],exclusions:'',warnings:[],preservedFiles:[{root:'/project',path:'committed.ts',kind:'committed',reason:'Committed'}],conflicts:files?[{root:'/project',path:'manual.ts',reason:'Human edit'}]:[],canApply:!files}));
 vi.mocked(conversationHistoryApi.apply).mockResolvedValue({sessionId:'s',revision:1});
 vi.spyOn(useAgentSessionStore.getState(),'resetConversationHistory').mockImplementation(()=>{});
 vi.spyOn(useAgentSessionStore.getState(),'refreshSessions').mockResolvedValue();vi.spyOn(useAgentSessionStore.getState(),'refreshDetail').mockResolvedValue();
});
afterEach(()=>vi.restoreAllMocks());
describe('history impact confirmation',()=>{
 it('shows committed-file preservation and allows conversation-only trimming through a conflict',async()=>{
   render(<SessionHistoryProvider session={session} messages={[]}><Trigger/></SessionHistoryProvider>);
   fireEvent.click(screen.getByRole('button',{name:'Open'}));
   expect(await screen.findByText(/committed.ts.*已被 Git 提交/)).toBeInTheDocument();
   expect(screen.getByRole('button',{name:'回滚到此处'})).toBeDisabled();
   fireEvent.click(screen.getByRole('checkbox',{name:'同时撤销本会话记录的未提交文件变更'}));
   await waitFor(()=>expect(screen.getByRole('button',{name:'回滚到此处'})).not.toBeDisabled());
   fireEvent.click(screen.getByRole('button',{name:'回滚到此处'}));
   await waitFor(()=>expect(conversationHistoryApi.apply).toHaveBeenCalledWith('s','rollback',expect.objectContaining({includeFiles:false})));
 });
 it('submits edits without opening a confirmation modal',async()=>{
   render(<SessionHistoryProvider session={session} messages={[]}><Trigger action="edit"/></SessionHistoryProvider>);
   fireEvent.click(screen.getByRole('button',{name:'Open'}));
   await waitFor(()=>expect(conversationHistoryApi.apply).toHaveBeenCalledWith('s','edit',expect.objectContaining({includeFiles:false})));
   expect(screen.queryByText('编辑并重新发送')).not.toBeInTheDocument();
 });
 it('states the expiry rule and distinguishes expired file history from missing chat history',async()=>{
   vi.mocked(conversationHistoryApi.preview).mockResolvedValue({checkpointId:'cp',revision:0,removedMessages:2,files:[],conflicts:[],exclusions:'',warnings:[],preservedFiles:[{root:'/project',path:'expired.ts',kind:'expired',reason:'Expired'}],canApply:true});
   render(<SessionHistoryProvider session={session} messages={[]}><Trigger/></SessionHistoryProvider>);fireEvent.click(screen.getByRole('button',{name:'Open'}));
   expect(await screen.findByText(/expired.ts.*超过 24 小时未访问/)).toBeInTheDocument();expect(screen.getByRole('button',{name:'回滚到此处'})).not.toBeDisabled();
 });
});
