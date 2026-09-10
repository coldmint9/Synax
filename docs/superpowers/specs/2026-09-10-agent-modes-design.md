# Synax Agent modes, human input, and specialist delegation

Approved in conversation on 2026-09-10. Scope: native Synax engine only; existing ACP and wiki plan-node behavior remains compatible.

## Behavior
- Public modes: chat, plan, goal; plan_node stays an internal compatibility mode. Mode and permissions are independent.
- Plan mode permits known read-only tools, internal task/plan state writes, human.ask, plan.propose, and constrained delegation. General shell, external tools without a trusted read classification, file writes and permission escalation are denied at listing and execution/resume boundaries.
- human.ask produces bounded typed questions (single_select, multi_select, text, textarea, number, boolean). Server persists questions and answers. Interaction tool calls must occupy a step alone; mixed batches perform no effects.
- plan.propose freezes a versioned plan with objective, steps, acceptance criteria, assumptions, scope and risks. UI supports save, revise, execute. Execution approves only that version, never general tool permissions.
- Durable interaction records tie to session/run/step/tool call, retain request and reply revisions, and support idempotent replies. Waiting releases runtime slots and pauses active work. Refresh/restart retains pending forms. Cancelled sessions cannot be revived by late answers. A committed answer retains a durable resume marker until consumed.
- Goal mode proposes a plan then autonomously advances within a root budget, stopping for input, approval, blockers, exhausted budget or explicit cancellation. Completed runs are not completed goals. Goal completion needs matching acceptance evidence and no unfinished tasks/children. Subjective acceptance is explicitly handed back to the user.
- Dynamic specialist definitions are per-child immutable snapshots: name, role, instructions, capability subset, skill IDs, task, deliverable and acceptance criteria. They cannot expand parent privileges or register globally. One level of children. Child questions return to the primary agent. Read-only children by default; bounded file writes require scope, serialize writers, and never include unrestricted shell.
- Goal/plan state lives in session metadata and existing task/artifact/event storage. One new interaction table. No new runtime dependencies or workflow engine.

## Wire contracts
GET /api/agent-runtime/sessions/:sessionId/interactions => { interactions: AgentInteraction[] }
POST .../interactions/:interactionId/reply => { revision: number, action: 'submit'|'decline'|'cancel'|'save'|'revise'|'execute', answers?: Record<string, string|string[]|number|boolean>, message?: string }; response { interaction: AgentInteraction }.
PATCH .../mode => { mode: 'chat'|'plan'|'goal' }; allowed only at a safe idle boundary, never while a form is pending.
AgentInteraction: { id, sessionId, runId, stepId, toolCallId, kind: 'clarification'|'plan_approval', revision, status: 'pending'|'answered'|'declined'|'cancelled', request: { title, questions?: HumanQuestion[], plan?: AgentPlan }, response: object|null, createdAt, resolvedAt }.
HumanQuestion: { id, type, label, required?, options?: {value,label}[], allowOther?, min?, max? }.
AgentPlan: { title, objective, steps: {id,title,description,dependsOn:string[],expectedFiles:string[]}[], acceptanceCriteria:string[], assumptions:string[], risks:string[] }.
Session metadata: mode, plan: { revision, status: 'draft'|'approved'|'saved', ...AgentPlan }, goal: { objective, status: 'planning'|'executing'|'completed'|'blocked'|'budget_exhausted'|'cancelled', maxSteps, stepsUsed, maxTokens, tokensUsed, acceptanceEvidence?, reason? }.
New waiting_input status for sessions/runs/steps. Live interaction events lead clients to refetch durable state, not use the stream as the authority.

## Verification
Regression checks cover read-only enforcement including children and permission resume; form validation/idempotency/late rejection/restart; mixed-call barriers; checkpoint answer consumption; plan approval/revision; goal budget and completion evidence; specialist snapshot and permission inheritance; accessible typed form submission and mode controls. Preserve pre-existing local edits and report baseline/environment failures separately. No production DB reset or service restart as part of tests.
