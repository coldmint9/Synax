import React, {useState} from 'react'
import {createRoot} from 'react-dom/client'
import './index.css'
import {InteractionCard} from './react/features/sessions/AgentInteractionPanel'
import {useAgentSessionStore} from './react/features/sessions/agentSessionStore'
import {useShellStore} from './react/state/shellStore'
import {useComposerCommands} from './react/features/sessions/useComposerCommands'
import {GoalComposerPill} from './react/features/wiki/goal/GoalComposerPill'
useShellStore.setState(s=>({preferences:{...s.preferences,locale:'zh'}}))
const plan:any={id:'preview-plan',sessionId:'preview',runId:'r',stepId:'s',toolCallId:'t',kind:'plan_approval',revision:1,status:'pending',response:null,createdAt:'',resolvedAt:null,request:{title:'重新设计会话交互',plan:{title:'重新设计会话交互',objective:'让讨论、计划与执行自然衔接。把输入区还给消息，把每一次提问和回答留在对话里。',steps:[{id:'one',title:'重构输入区与模式选择',description:'使用 Synax 现有的 HeroUI 控件和中性色，让模式选择常驻工具栏，保留清晰的输入空间。',expectedFiles:['SessionComposer.tsx'],dependsOn:[]},{id:'two',title:'将提问与计划放回对话流',description:'回答与原始提问保持关联，历史交互不会挤占输入框。',expectedFiles:[],dependsOn:['one']},{id:'three',title:'验证执行流程与响应式布局',description:'确认计划执行不再自动升级为目标模式，并检查窄屏和键盘操作。',expectedFiles:[],dependsOn:['two']}],acceptanceCriteria:['输入区不出现历史面板','计划执行进入对话模式','菜单不被裁剪或遮挡'],risks:['兼容已有会话'],assumptions:[]}}}
const ask:any={...plan,id:'preview-ask',kind:'clarification',request:{title:'这次先覆盖哪些场景？',questions:[{id:'scope',label:'选择本次改造范围',type:'single_select',required:true,allowOther:true,options:[{value:'all',label:'输入框、计划与目标，完整重构'},{value:'input',label:'先优化输入框与斜杠菜单'}]}]}}
function Demo(){
 const [mode,setMode]=useState<any>('plan'),[content,setContent]=useState(''),[refs,setRefs]=useState<any[]>([]),[interaction,setInteraction]=useState(plan),[dark,setDark]=useState(true)
 useAgentSessionStore.setState({replyInteraction:async(_s,_i,reply)=>setInteraction((i:any)=>({...i,status:reply.action==='cancel'?'cancelled':'answered',response:reply}))})
 const commands=useComposerCommands({projectId:'preview',backendId:'native',content,setContent,references:refs,setReferences:setRefs,mode,modeEnabled:true,onModeChange:async m=>setMode(m),disabled:false})
 return <main style={{maxWidth:760,margin:'0 auto',padding:'28px 20px 180px'}}>
 <nav style={{display:'flex',justifyContent:'space-between',marginBottom:36,fontSize:12,color:'hsl(var(--muted-foreground))'}}><b>Synax · 交互预览</b><div style={{display:'flex',gap:20}}><button onClick={()=>setInteraction(plan)}>计划</button><button onClick={()=>setInteraction(ask)}>提问</button><button onClick={()=>{setDark(!dark);document.documentElement.classList.toggle('dark',!dark)}}>切换主题</button></div></nav>
 <div style={{display:'flex',justifyContent:'flex-end',marginBottom:28}}><p style={{borderRadius:16,background:'hsl(var(--foreground-hsl) / .05)',padding:'12px 18px',fontSize:13}}>重新设计输入区和计划交互，让它更自然、更清晰。</p></div>
 <p style={{fontSize:13,lineHeight:1.8,marginBottom:24,color:'hsl(var(--muted-foreground))'}}>我会先理清工作方式，再整理对话中的提问与计划。以下是实施步骤。</p>
 <InteractionCard key={interaction.id} interaction={interaction}/>
 <div style={{position:'fixed',bottom:24,left:'50%',transform:'translateX(-50%)',width:'min(720px, calc(100vw - 40px))'}} className="agent-session-controls">
 {commands.menu}<div className="goal-session-composer-shell goal-dock-shell"><div className="goal-dock-shell-content"><GoalComposerPill commands={commands} projectId="preview" backendId="native" modeControl={<></>} modelControl={<button className="goal-dock-composer-chip">GPT-5.6</button>} content={content} onContentChange={setContent} onSubmit={()=>{}} providerId={null} modelId={null} onModelSelect={()=>{}} providers={[]} globalConfig={null} documentId={null} onDocumentChange={()=>{}} wikiAttachMode="auto" onWikiAttachModeChange={()=>{}} documents={[]} skillIds={[]} onSkillIdsChange={()=>{}} reasoningEffort="high" onReasoningEffortChange={()=>{}} permissionTier="boundary" onPermissionTierChange={()=>{}} placeholder={mode==='plan'?'描述你想做的事，一起理清方案…':'告诉 Synax 你想做什么…'}/></div></div>
 </div></main>
}
createRoot(document.getElementById('app')!).render(<Demo/> )
