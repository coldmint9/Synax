import { useEffect } from 'react';
import { conversationHistoryApi } from '../../../lib/api/conversationHistory';
import { useAgentSessionStore } from './state/agentSessionStore';
const sent=new Map<string,number>();
/** Only selection/focus and actual user input count as visits, never polling/SSE. */
export function useConversationHistoryVisit(sessionId?:string):void {
  useEffect(()=> {
    if(!sessionId)return;
    const visit=()=> {
      if(document.visibilityState==='hidden'||!document.hasFocus()||useAgentSessionStore.getState().selectedSessionId!==sessionId)return;
      const now=Date.now();if(now-(sent.get(sessionId)??0)<30_000)return;
      sent.set(sessionId,now);
      void conversationHistoryApi.visit(sessionId).catch(()=>{if(sent.get(sessionId)===now)sent.delete(sessionId);});
    };
    visit();window.addEventListener('focus',visit);document.addEventListener('visibilitychange',visit);
    document.addEventListener('pointerdown',visit,{passive:true});document.addEventListener('keydown',visit);
    return ()=> {window.removeEventListener('focus',visit);document.removeEventListener('visibilitychange',visit);document.removeEventListener('pointerdown',visit);document.removeEventListener('keydown',visit);};
  },[sessionId]);
}
