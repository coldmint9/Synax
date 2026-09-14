import React,{useState} from 'react'
import {createRoot} from 'react-dom/client'
import './src/index.css'
import './src/react/features/sessions/agentControls.css'
import {GoalComposerPill} from './src/react/features/wiki/goal/GoalComposerPill'
import {useComposerCommands} from './src/react/features/sessions/useComposerCommands'
import {SessionBackendPicker} from './src/react/features/sessions/SessionBackendPicker'
import {useShellStore} from './src/react/state/shellStore'
useShellStore.setState(s=>({preferences:{...s.preferences,locale:'zh'}}))
function Preview(){
 const [content,setContent]=useState(''),[references,setReferences]=useState([]),[mode,setMode]=useState('chat'),[backendId,setBackendId]=useState('native'),[dark,setDark]=useState(true),[locked,setLocked]=useState(false),[failure,setFailure]=useState(false),[sent,setSent]=useState(0),[error,setError]=useState('')
 document.documentElement.classList.toggle('dark',dark)
 const commands=useComposerCommands({projectId:'slash-preview',backendId,content,setContent,references,setReferences,mode,modeEnabled:!locked&&backendId==='native',onModeChange:async value=>setMode(value),disabled:false})
 const submit=()=>{if(failure){setError('模拟发送失败：保留正文与标签');return}setSent(sent+1);setContent('');setReferences([]);setError('')}
 return <main style={{maxWidth:900,margin:'300px auto 30px',padding:20}}>
  <div style={{display:'flex',gap:16,marginBottom:24}}><button onClick={()=>setDark(!dark)}>切换主题</button><button onClick={()=>setLocked(!locked)}>切换模式锁定</button><button onClick={()=>setFailure(!failure)}>切换失败状态</button><output>发送 {sent}</output></div>
  <div className="agent-session-controls">{commands.menu}{error&&<p role="alert">{error}</p>}<div className="goal-session-composer-shell goal-dock-shell" data-multiline="true"><div className="goal-dock-shell-content">
   <GoalComposerPill commands={commands} content={content} onContentChange={setContent} onSubmit={submit} projectId="slash-preview" backendId={backendId} providerId="preview" modelId="deepseek-v4-flash" providers={[]} globalConfig={null} onModelSelect={()=>{}} documentId={null} onDocumentChange={()=>{}} wikiAttachMode="manual" onWikiAttachModeChange={()=>{}} documents={[]} skillIds={[]} onSkillIdsChange={()=>{}} reasoningEffort="high" onReasoningEffortChange={()=>{}} permissionTier="unrestricted" onPermissionTierChange={()=>{}} modeControl={<SessionBackendPicker value={backendId} onChange={setBackendId} disabled={false} options={[{id:'native',label:'Synax'},{id:'codex',label:'Codex'}]}/>}/>
  </div></div></div>
 </main>
}
createRoot(document.getElementById('app')!).render(<Preview/> )
