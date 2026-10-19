import { useEffect } from 'react';
import { conversationHistoryApi } from '../../adapters/transport/conversationHistory';
import { useAgentSessionStore } from './state/agentSessionStore';
const sent=new Map<string,number>();
/**
 * Only selecting a session, returning focus to it and actual user input count as
 * visits, never polling/SSE. A visit is reported at most once per session per
 * 30s so ordinary reading does not turn into a steady stream of requests.
 */
export function useConversationHistoryVisit(sessionId?:string):void {
  useEffect(()=> {
    if(!sessionId)return;
    const visit=()=> {
      if(document.visibilityState==='hidden'||!document.hasFocus()||useAgentSessionStore.getState().selectedSessionId!==sessionId)return;
      const now=Date.now();if(now-(sent.get(sessionId)??0)<30_000)return;
      sent.set(sessionId,now);
      void conversationHistoryApi.visit(sessionId).catch(()=>{if(sent.get(sessionId)===now)sent.delete(sessionId);});
    };
    const onVisibility=()=>{if(document.visibilityState==='visible')visit();};
    visit();window.addEventListener('focus',visit);document.addEventListener('visibilitychange',onVisibility);
    document.addEventListener('pointerdown',visit,{passive:true});document.addEventListener('keydown',visit);
    return ()=> {window.removeEventListener('focus',visit);document.removeEventListener('visibilitychange',onVisibility);document.removeEventListener('pointerdown',visit);document.removeEventListener('keydown',visit);};
  },[sessionId]);
}
