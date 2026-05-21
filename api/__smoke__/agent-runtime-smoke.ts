import { agentSessionRuntime } from '../services/agent-runtime/session-runtime.js';
import { agentRuntimeStore } from '../services/agent-runtime/session-store.js';
import { permissionPolicy } from '../services/agent-runtime/permission-policy.js';
import { toolRegistry } from '../services/agent-runtime/tool-registry.js';
import { skillRegistry } from '../services/agent-runtime/skill-registry.js';

async function main() {
  agentRuntimeStore.reset();

  const planner = agentSessionRuntime.create({
    projectId: 'agent-runtime-smoke',
    profileId: 'planner',
    prompt: 'Plan a small Synapse workflow.',
  });

  const explorer = agentSessionRuntime.create({
    projectId: planner.projectId,
    profileId: 'explorer',
    parentSessionId: planner.id,
    prompt: 'Explore read-only evidence.',
  });

  const skills = skillRegistry.listSummaries({ profileId: 'explorer' });
  const read = await toolRegistry.execute(explorer.id, 'file.glob', { pattern: 'api/services/agent-runtime/**/*.ts', limit: 10 });
  const denied = permissionPolicy.evaluate({
    sessionId: explorer.id,
    category: 'write',
    internalGate: 'write',
    rules: explorer.permissionRules,
    isSubSession: true,
  });

  console.log(
    JSON.stringify(
      {
        planner: planner.id,
        explorer: explorer.id,
        lazySkills: skills.map((skill) => ({ id: skill.id, hasContent: 'content' in skill })),
        readToolStatus: read.record.status,
        subSessionWriteDecision: denied.action,
        eventTypes: agentRuntimeStore.listEvents(planner.id).map((event) => event.type),
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
