// ---------------------------------------------------------------------------
// api/services/wiki/wiki-design-mapping-service.ts
//
// 从 WikiBlock 选区生成 coordinates goal/actions，用户确认后调用 ACP Agent
// ---------------------------------------------------------------------------

import { nanoid } from 'nanoid';
import { eq } from 'drizzle-orm';
import * as z from 'zod/v4';
import { getDb } from '../../db/index.js';
import { wikiDesignMappingTasks, wikiActionContextBundles } from '../../db/schema.js';
import { wikiStore } from './wiki-store.js';
import { wikiRefreshService } from './wiki-refresh-service.js';
import { generateGatewayObject } from '../llm-runtime/stream.js';
import { createAcpClientFor, type ProviderId, type CoordinatesRunEvent } from '../acp/index.js';
import { resolveWorkspaceRoot } from '../agent-runtime/tools/workspace.js';
import { logger } from '../../lib/logger.js';
import type { WikiDesignMappingStatus } from './contracts.js';

// ── Domain types ─────────────────────────────────────────────────────────────

export interface DesignMappingTask {
  id: string;
  projectId: string;
  sourceSnapshotId: string;
  selectedBlockIds: string[];
  selectedText: string;
  userInstruction: string;
  relatedCoordinateIds: string[];
  generatedGoalId: string | null;
  generatedActionIds: string[];
  actionContextBundleId: string;
  acpSessionId: string | null;
  status: WikiDesignMappingStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ActionContextBundle {
  id: string;
  projectId: string;
  selectedText: string;
  userInstruction: string;
  wikiBlockIds: string[];
  coordinateIds: string[];
  fileIds: string[];
  symbolIds: string[];
  constraints: string[];
  relatedTestFiles: string[];
  createdAt: string;
}

export interface GoalPreview {
  label: string;
  summary: string;
  rationale: string;
}

export interface ActionPreview {
  label: string;
  summary: string;
  targetFiles: string[];
  estimatedScope: 'small' | 'medium' | 'large';
}

export interface PlanResult {
  task: DesignMappingTask;
  contextBundle: ActionContextBundle;
  goalPreview: GoalPreview;
  actionPreviews: ActionPreview[];
}

// ── Schema for LLM output ────────────────────────────────────────────────────

const PlanOutputSchema = z.object({
  goal: z.object({
    label: z.string(),
    summary: z.string(),
    rationale: z.string(),
  }),
  actions: z.array(z.object({
    label: z.string(),
    summary: z.string(),
    targetFiles: z.array(z.string()).optional(),
    estimatedScope: z.enum(['small', 'medium', 'large']).optional(),
  })).min(1).max(8),
  constraints: z.array(z.string()).optional(),
  relatedTestFiles: z.array(z.string()).optional(),
});

// ── Row mappers ──────────────────────────────────────────────────────────────

function rowToTask(r: typeof wikiDesignMappingTasks.$inferSelect): DesignMappingTask {
  return {
    id: r.id,
    projectId: r.projectId,
    sourceSnapshotId: r.sourceSnapshotId,
    selectedBlockIds: JSON.parse(r.selectedBlockIdsJson) as string[],
    selectedText: r.selectedText,
    userInstruction: r.userInstruction,
    relatedCoordinateIds: JSON.parse(r.relatedCoordinateIdsJson) as string[],
    generatedGoalId: r.generatedGoalId ?? null,
    generatedActionIds: JSON.parse(r.generatedActionIdsJson) as string[],
    actionContextBundleId: r.actionContextBundleId,
    acpSessionId: r.acpSessionId ?? null,
    status: r.status as WikiDesignMappingStatus,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function rowToBundle(r: typeof wikiActionContextBundles.$inferSelect): ActionContextBundle {
  return {
    id: r.id,
    projectId: r.projectId,
    selectedText: r.selectedText,
    userInstruction: r.userInstruction,
    wikiBlockIds: JSON.parse(r.wikiBlockIdsJson) as string[],
    coordinateIds: JSON.parse(r.coordinateIdsJson) as string[],
    fileIds: JSON.parse(r.fileIdsJson) as string[],
    symbolIds: JSON.parse(r.symbolIdsJson) as string[],
    constraints: JSON.parse(r.constraintsJson) as string[],
    relatedTestFiles: JSON.parse(r.relatedTestFilesJson) as string[],
    createdAt: r.createdAt,
  };
}

async function updateTask(
  taskId: string,
  updates: Partial<typeof wikiDesignMappingTasks.$inferInsert>,
): Promise<void> {
  const db = getDb();
  await db.update(wikiDesignMappingTasks).set({
    ...updates,
    updatedAt: new Date().toISOString(),
  }).where(eq(wikiDesignMappingTasks.id, taskId));
}

// ── Service ──────────────────────────────────────────────────────────────────

export const wikiDesignMappingService = {
  async getTask(taskId: string): Promise<DesignMappingTask | null> {
    const db = getDb();
    const rows = await db
      .select()
      .from(wikiDesignMappingTasks)
      .where(eq(wikiDesignMappingTasks.id, taskId))
      .limit(1);
    return rows[0] ? rowToTask(rows[0]) : null;
  },

  async getBundle(bundleId: string): Promise<ActionContextBundle | null> {
    const db = getDb();
    const rows = await db
      .select()
      .from(wikiActionContextBundles)
      .where(eq(wikiActionContextBundles.id, bundleId))
      .limit(1);
    return rows[0] ? rowToBundle(rows[0]) : null;
  },

  async plan(input: {
    projectId: string;
    snapshotId: string;
    selectedBlockIds: string[];
    selectedText: string;
    instruction: string;
  }): Promise<PlanResult> {
    const db = getDb();
    const now = new Date().toISOString();

    // 1. Gather source bindings from selected blocks
    const fileIds: string[] = [];
    const symbolIds: string[] = [];
    const coordinateIds: string[] = [];

    for (const blockId of input.selectedBlockIds) {
      const bindings = await wikiStore.getBindingsByBlock(blockId);
      for (const b of bindings) {
        if (b.sourceType === 'file') fileIds.push(b.sourceId);
        else if (b.sourceType === 'symbol') symbolIds.push(b.sourceId);
        coordinateIds.push(b.id);
      }
    }

    // 2. Build context bundle
    const bundleId = nanoid();
    await db.insert(wikiActionContextBundles).values({
      id: bundleId,
      projectId: input.projectId,
      selectedText: input.selectedText,
      userInstruction: input.instruction,
      wikiBlockIdsJson: JSON.stringify(input.selectedBlockIds),
      coordinateIdsJson: JSON.stringify(coordinateIds),
      fileIdsJson: JSON.stringify([...new Set(fileIds)]),
      symbolIdsJson: JSON.stringify([...new Set(symbolIds)]),
      constraintsJson: '[]',
      relatedTestFilesJson: '[]',
      createdAt: now,
    });

    // 3. Create task in planning state
    const taskId = nanoid();
    await db.insert(wikiDesignMappingTasks).values({
      id: taskId,
      projectId: input.projectId,
      sourceSnapshotId: input.snapshotId,
      selectedBlockIdsJson: JSON.stringify(input.selectedBlockIds),
      selectedText: input.selectedText,
      userInstruction: input.instruction,
      relatedCoordinateIdsJson: JSON.stringify(coordinateIds),
      generatedActionIdsJson: '[]',
      actionContextBundleId: bundleId,
      status: 'planning',
      createdAt: now,
      updatedAt: now,
    });

    // 4. Call LLM to generate goal/actions plan
    let goalPreview: GoalPreview;
    let actionPreviews: ActionPreview[];
    let constraints: string[] = [];
    let relatedTestFiles: string[] = [];

    try {
      const blockContents = await Promise.all(
        input.selectedBlockIds.map(id => wikiStore.getBlock(id)),
      );
      const blockSummary = blockContents
        .filter(Boolean)
        .map(b => `[${b!.blockType}] ${JSON.stringify(b!.content).slice(0, 200)}`)
        .join('\n');

      const object = await generateGatewayObject(
        {
          purpose: 'wiki',
          projectId: input.projectId,
          messages: [
            {
              role: 'system',
              content: `You are a software architect. Given selected wiki documentation and a user instruction,
generate a structured implementation plan as a Goal with Actions.
- Goal: the high-level intent
- Actions: concrete, atomic implementation steps (1-8 actions)
- Each action should reference specific files or modules when possible
- Keep actions focused and independently executable
- Output only valid json matching the schema exactly`,
            },
            {
              role: 'user',
              content: `Selected wiki content:\n${blockSummary}\n\nUser instruction: ${input.instruction}\n\nRelated files: ${[...new Set(fileIds)].join(', ')}\nRelated symbols: ${[...new Set(symbolIds)].join(', ')}`,
            },
          ],
        },
        PlanOutputSchema,
      );

      goalPreview = object.goal;
      actionPreviews = object.actions.map(a => ({
        label: a.label,
        summary: a.summary,
        targetFiles: a.targetFiles ?? [],
        estimatedScope: a.estimatedScope ?? 'medium',
      }));
      constraints = object.constraints ?? [];
      relatedTestFiles = object.relatedTestFiles ?? [];
    } catch (err) {
      logger.warn({ err, taskId }, 'wiki design mapping: LLM plan failed, using stub');
      goalPreview = {
        label: input.instruction.slice(0, 60),
        summary: input.instruction,
        rationale: 'Generated from selected wiki content',
      };
      actionPreviews = [{
        label: 'Implement changes',
        summary: input.instruction,
        targetFiles: fileIds.slice(0, 3),
        estimatedScope: 'medium',
      }];
    }

    // 5. Update bundle with constraints
    await db.update(wikiActionContextBundles).set({
      constraintsJson: JSON.stringify(constraints),
      relatedTestFilesJson: JSON.stringify(relatedTestFiles),
    }).where(eq(wikiActionContextBundles.id, bundleId));

    // 6. Mark task ready_for_confirmation
    await updateTask(taskId, { status: 'ready_for_confirmation' });

    const task = (await this.getTask(taskId))!;
    const bundle = (await this.getBundle(bundleId))!;

    return { task, contextBundle: bundle, goalPreview, actionPreviews };
  },

  async confirm(
    taskId: string,
    opts: { workDir?: string; providerId?: string; userId?: string } = {},
  ): Promise<{ task: DesignMappingTask; acpSessionId: string }> {
    const task = await this.getTask(taskId);
    if (!task) throw new Error(`DesignMappingTask not found: ${taskId}`);
    if (task.status !== 'ready_for_confirmation') {
      throw new Error(`Task ${taskId} is not ready for confirmation (status: ${task.status})`);
    }

    const bundle = await this.getBundle(task.actionContextBundleId);
    if (!bundle) throw new Error(`ActionContextBundle not found: ${task.actionContextBundleId}`);

    // Validate workDir up-front (don't dispatch into an arbitrary directory)
    let workDirAbs: string | null = null;
    if (opts.workDir) {
      workDirAbs = resolveWorkspaceRoot(opts.workDir);
    }

    // Build ACP prompt from bundle
    const acpPrompt = [
      `Goal: ${task.userInstruction}`,
      '',
      `Context from wiki:`,
      task.selectedText ? `"${task.selectedText.slice(0, 500)}"` : '',
      '',
      bundle.constraints.length > 0
        ? `Constraints:\n${bundle.constraints.map(c => `- ${c}`).join('\n')}`
        : '',
      bundle.fileIds.length > 0
        ? `Relevant files:\n${bundle.fileIds.map(f => `- ${f}`).join('\n')}`
        : '',
    ].filter(Boolean).join('\n');

    const acpSessionId = nanoid();
    await updateTask(taskId, { acpSessionId, status: 'running' });

    // Fire-and-forget ACP execution + wiki refresh
    this._runAcpAndRefresh(taskId, task, acpPrompt, {
      workDir: workDirAbs,
      providerId: (opts.providerId as ProviderId) ?? 'opencode-acp',
      userId: opts.userId ?? 'wiki-design-mapping',
    }).catch(err => {
      logger.error({ err, taskId }, 'wiki design mapping: ACP execution failed');
    });

    return { task: (await this.getTask(taskId))!, acpSessionId };
  },

  async _runAcpAndRefresh(
    taskId: string,
    task: DesignMappingTask,
    acpPrompt: string,
    opts: { workDir: string | null; providerId: ProviderId; userId: string },
  ): Promise<void> {
    try {
      const acpEvents: CoordinatesRunEvent[] = [];
      const fileChanges = new Set<string>();
      let acpFailed = false;
      let acpFailureReason = '';

      try {
        const client = await createAcpClientFor(opts.providerId);
        for await (const event of client.dispatchStream({
          projectId: task.projectId,
          sessionId: task.acpSessionId,
          userId: opts.userId,
          userName: 'Wiki Design Mapping',
          intent: acpPrompt,
          providerId: opts.providerId,
          context: {
            workDir: opts.workDir,
            contextPrompt: 'This ACP run originates from a confirmed Wiki design mapping. Writes are allowed.',
          },
        })) {
          acpEvents.push(event);
          if (event.payload?.fileChanges) {
            for (const change of event.payload.fileChanges) {
              fileChanges.add(change.path);
            }
          }
          if (event.type === 'run_failed') {
            acpFailed = true;
            acpFailureReason = event.payload?.message ?? event.payload?.reason ?? 'ACP run failed';
          }
        }
      } catch (acpErr) {
        acpFailed = true;
        acpFailureReason = acpErr instanceof Error ? acpErr.message : String(acpErr);
        logger.warn({ acpErr, taskId }, 'wiki design mapping: ACP dispatch failed');
      }

      if (acpFailed) {
        logger.warn({ taskId, reason: acpFailureReason }, 'wiki design mapping: ACP run did not complete cleanly');
      }

      logger.info(
        { taskId, eventCount: acpEvents.length, fileChanges: fileChanges.size },
        'wiki design mapping: ACP dispatch finished',
      );

      await updateTask(taskId, { status: 'code_changed' });

      // Trigger Wiki refresh preview if we have a workspace path
      if (opts.workDir) {
        await updateTask(taskId, { status: 'wiki_previewing' });
        await wikiRefreshService.triggerRefresh(
          task.projectId,
          task.sourceSnapshotId,
          opts.workDir,
        );
      }

      await updateTask(taskId, { status: 'completed' });
    } catch (err) {
      await updateTask(taskId, { status: 'failed' });
      throw err;
    }
  },
};
