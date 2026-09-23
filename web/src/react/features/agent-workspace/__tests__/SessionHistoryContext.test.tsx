import { render,fireEvent,screen,waitFor } from '@testing-library/react';
import { beforeEach,afterEach,describe,expect,it,vi } from 'vitest';
import { SessionHistoryProvider,useSessionHistory } from '../SessionHistoryContext';
import { UserMessageBlock } from '../UserMessageBlock';
import { conversationHistoryApi } from '../../../../lib/api/conversationHistory';
import { useShellStore } from '../../../state/shellStore';
import { useAgentSessionStore } from '../state/agentSessionStore';
import type { AgentSession } from '../../../../lib/api/agentRuntime';
vi.mock('../useConversationHistoryVisit',()=>({useConversationHistoryVisit:vi.fn()}));
vi.mock('../../../../lib/api/runtimeEventBus',()=>({subscribe:()=>()=>{}}));
vi.mock('../../../../lib/api/conversationHistory',()=>({conversationHistoryApi:{list:vi.fn(),preview:vi.fn(),apply:vi.fn()}}));
const cp={id:'cp',kind:'reply' as const,messageId:'msg',stepId:null,available:true,reason:null,hasLaterHistory:true,initialInput:false};
const session={id:'s',status:'completed',sessionMetadata:{backend:{id:'native'}}} as unknown as AgentSession;
function Trigger({action='rollback'}: {action?: 'rollback' | 'edit' | 'fork'}){const history=useSessionHistory();return <button onClick={()=>void history?.request(action,cp,'Edited')}>Open</button>;}
beforeEach(()=>{
 vi.clearAllMocks();useShellStore.setState(s=>({preferences:{...s.preferences,locale:'zh'}}));
 vi.mocked(conversationHistoryApi.list).mockResolvedValue({sessionId:'s',revision:0,reason:null,checkpoints:[cp]});
 vi.mocked(conversationHistoryApi.preview).mockImplementation(async(_session,_checkpoint,_action,files=true)=>({checkpointId:'cp',revision:0,removedMessages:2,files:[],exclusions:'',warnings:[],preservedFiles:[{root:'/project',path:'committed.ts',kind:'committed',reason:'Committed'}],conflicts:files?[{root:'/project',path:'manual.ts',reason:'Human edit'}]:[],canApply:!files}));
 vi.mocked(conversationHistoryApi.apply).mockResolvedValue({sessionId:'s',revision:1});
 vi.spyOn(useAgentSessionStore.getState(),'cancelSessionRun').mockResolvedValue();
 vi.spyOn(useAgentSessionStore.getState(),'openPanel').mockImplementation(()=>{});
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
 it.each([['reuse_worktree', '维持原工作树'], ['new_worktree', '新建工作树']] as const)('requires an explicit %s choice and submits a conversation-only fork', async (mode, label) => {
   render(<SessionHistoryProvider session={session} messages={[]}><Trigger action="fork"/></SessionHistoryProvider>);
   fireEvent.click(screen.getByRole('button',{name:'Open'}));
   const confirm=await screen.findByRole('button',{name:'从此处创建分支会话'});
   expect(confirm).toBeDisabled();
   expect(conversationHistoryApi.preview).not.toHaveBeenCalled();
   expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
   fireEvent.click(screen.getByRole('radio',{name:new RegExp(label)}));
   await waitFor(()=>expect(conversationHistoryApi.preview).toHaveBeenCalledWith('s','cp','fork',false,mode));
   await waitFor(()=>expect(confirm).not.toBeDisabled());
   fireEvent.click(confirm);
   await waitFor(()=>expect(conversationHistoryApi.apply).toHaveBeenCalledWith('s','fork',expect.objectContaining({workspaceMode:mode,includeFiles:false})));
 });
 it('keeps a running session alive while editing and stops only on Send', async () => {
   const running={...session,status:'running' as const};
   const input={...cp,kind:'input' as const};
   vi.mocked(conversationHistoryApi.list).mockResolvedValue({
     sessionId:'s',revision:0,reason:'Stop the session and its agents before changing history.',
     stopRequired:true,forkReason:null,checkpoints:[input],
   });
   vi.mocked(conversationHistoryApi.preview).mockResolvedValue({
     checkpointId:'cp',revision:0,removedMessages:1,files:[],conflicts:[],
     exclusions:'',canApply:true,
   });
   const stop=vi.spyOn(useAgentSessionStore.getState(),'cancelSessionRun').mockResolvedValue();
   render(<SessionHistoryProvider session={running} messages={[]}><UserMessageBlock messageId="msg" content="Original"/></SessionHistoryProvider>);
   fireEvent.click(await screen.findByRole('button',{name:'编辑消息'}));
   expect(stop).not.toHaveBeenCalled();
   fireEvent.change(screen.getByRole('textbox',{name:'编辑已发送消息'}),{target:{value:'Updated'}});
   fireEvent.click(screen.getByRole('button',{name:'发送'}));
   await waitFor(()=>expect(stop).toHaveBeenCalledWith('s'));
   await waitFor(()=>expect(conversationHistoryApi.apply).toHaveBeenCalledWith('s','edit',expect.objectContaining({message:'Updated'})));
 });
 it('stops a running session before rollback preview, then applies only after confirmation', async () => {
   const running={...session,status:'running' as const};
   const calls:string[]=[];
   vi.mocked(conversationHistoryApi.list).mockResolvedValue({
     sessionId:'s',revision:0,reason:'Stop the session and its agents before changing history.',
     stopRequired:true,forkReason:null,checkpoints:[cp],
   });
   vi.spyOn(useAgentSessionStore.getState(),'cancelSessionRun').mockImplementation(async()=>{calls.push('stop');});
   vi.mocked(conversationHistoryApi.preview).mockImplementation(async()=>{
     calls.push('preview');
     return {checkpointId:'cp',revision:0,removedMessages:1,files:[],conflicts:[],
       exclusions:'',canApply:true};
   });
   render(<SessionHistoryProvider session={running} messages={[]}><Trigger/></SessionHistoryProvider>);
   fireEvent.click(screen.getByRole('button',{name:'Open'}));
   await waitFor(()=>expect(calls).toContain('preview'));
   expect(calls).toEqual(['stop','preview']);
   expect(conversationHistoryApi.apply).not.toHaveBeenCalled();
   fireEvent.click(screen.getByRole('button',{name:'回滚到此处'}));
   await waitFor(()=>expect(conversationHistoryApi.apply).toHaveBeenCalledWith('s','rollback',expect.anything()));
 });
 it('stops a running session before previewing and sending an edit', async () => {
   const running={...session,status:'running' as const};
   const calls:string[]=[];
   vi.spyOn(useAgentSessionStore.getState(),'cancelSessionRun').mockImplementation(async()=>{calls.push('stop');});
   vi.mocked(conversationHistoryApi.preview).mockImplementation(async()=>{
     calls.push('preview');
     return {checkpointId:'cp',revision:0,removedMessages:1,files:[],conflicts:[],
       exclusions:'',canApply:true};
   });
   vi.mocked(conversationHistoryApi.apply).mockImplementation(async()=>{
     calls.push('apply');
     return {sessionId:'s',revision:1};
   });
   render(<SessionHistoryProvider session={running} messages={[]}><Trigger action="edit"/></SessionHistoryProvider>);
   expect(calls).toEqual([]);
   fireEvent.click(screen.getByRole('button',{name:'Open'}));
   await waitFor(()=>expect(calls).toEqual(['stop','preview','apply']));
 });
 it('allows forking a running source without stopping it', async () => {
   const running={...session,status:'running' as const};
   vi.mocked(conversationHistoryApi.list).mockResolvedValue({
     sessionId:'s',revision:0,reason:'Stop the session and its agents before changing history.',
     stopRequired:true,forkReason:null,checkpoints:[cp],
   });
   function Availability(){const value=useSessionHistory();return <output>{JSON.stringify({reason:value?.reason,forkReason:value?.forkReason})}</output>;}
   render(<SessionHistoryProvider session={running} messages={[]}><Availability/><Trigger action="fork"/></SessionHistoryProvider>);
   await waitFor(()=>expect(screen.getByRole('status')).toHaveTextContent('"forkReason":null'));
   expect(screen.getByRole('status')).toHaveTextContent('"reason":null');
   fireEvent.click(screen.getByRole('button',{name:'Open'}));
   fireEvent.click(await screen.findByRole('radio',{name:/维持原工作树/}));
   await waitFor(()=>expect(conversationHistoryApi.preview).toHaveBeenCalledWith('s','cp','fork',false,'reuse_worktree'));
   expect(useAgentSessionStore.getState().cancelSessionRun).not.toHaveBeenCalled();
 });
 it('stops before editing and never applies when stopping fails', async () => {
   const running={...session,status:'running' as const};
   const stop=vi.spyOn(useAgentSessionStore.getState(),'cancelSessionRun').mockRejectedValueOnce(new Error('Stop failed'));
   render(<SessionHistoryProvider session={running} messages={[]}><Trigger action="edit"/></SessionHistoryProvider>);
   fireEvent.click(screen.getByRole('button',{name:'Open'}));
   await waitFor(()=>expect(stop).toHaveBeenCalledWith('s'));
   expect(conversationHistoryApi.preview).not.toHaveBeenCalled();
   expect(conversationHistoryApi.apply).not.toHaveBeenCalled();
 });
 it('blocks edit/resend for an append-only fork before requesting any history mutation', async () => {
   const forked={...session,sessionMetadata:{...session.sessionMetadata,historyRollbackEnabled:false}};
   render(<SessionHistoryProvider session={forked} messages={[]}><Trigger action="edit"/></SessionHistoryProvider>);
   fireEvent.click(screen.getByRole('button',{name:'Open'}));
   expect(conversationHistoryApi.preview).not.toHaveBeenCalled();
   expect(conversationHistoryApi.apply).not.toHaveBeenCalled();
   expect(screen.getByRole('note')).toHaveTextContent('只追加历史');
 });

});
