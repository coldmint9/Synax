import { render,fireEvent } from '@testing-library/react';
import { beforeEach,afterEach,describe,expect,it,vi } from 'vitest';
import { useConversationHistoryVisit } from '../useConversationHistoryVisit';
import { useAgentSessionStore } from '../state/agentSessionStore';
import { conversationHistoryApi } from '../../../../lib/api/conversationHistory';
vi.mock('../../../../lib/api/conversationHistory',()=>({conversationHistoryApi:{visit:vi.fn().mockResolvedValue({visited:true})}}));
function Probe({id,revision=0}:{id:string;revision?:number}){useConversationHistoryVisit(id);return <div>{revision}</div>;}
beforeEach(()=>{vi.clearAllMocks();vi.spyOn(document,'hasFocus').mockReturnValue(true);vi.spyOn(document,'visibilityState','get').mockReturnValue('visible');});
afterEach(()=>vi.restoreAllMocks());
describe('active history visits',()=>{
 it('visits on selection and actual input, not polling-driven rerenders',()=>{
   let now=100_000;vi.spyOn(Date,'now').mockImplementation(()=>now);useAgentSessionStore.setState({selectedSessionId:'visit-session'});
   const view=render(<Probe id="visit-session"/>);expect(conversationHistoryApi.visit).toHaveBeenCalledTimes(1);
   now+=60_000;view.rerender(<Probe id="visit-session" revision={1}/>);expect(conversationHistoryApi.visit).toHaveBeenCalledTimes(1);
   fireEvent.keyDown(document,{key:'a'});expect(conversationHistoryApi.visit).toHaveBeenCalledTimes(2);
   fireEvent.pointerDown(document);expect(conversationHistoryApi.visit).toHaveBeenCalledTimes(2);
 });
 it('does not renew hidden or unselected conversations',()=>{
   useAgentSessionStore.setState({selectedSessionId:'selected'});render(<Probe id="not-selected"/>);fireEvent.keyDown(document,{key:'a'});expect(conversationHistoryApi.visit).not.toHaveBeenCalled();
   vi.spyOn(document,'visibilityState','get').mockReturnValue('hidden');render(<Probe id="selected"/>);fireEvent(window,new Event('focus'));expect(conversationHistoryApi.visit).not.toHaveBeenCalled();
 });
});
