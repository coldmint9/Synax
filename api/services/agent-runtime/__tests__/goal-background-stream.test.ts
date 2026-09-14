import { beforeEach, describe, expect, it, vi } from 'vitest';
import { agentLoopRuntime } from '../loop-runtime.js';
import { streamAgentSession } from '../agent-stream-proxy.js';
import { agentSessionRuntime } from '../session-runtime.js';
import { ensureSynaxAgentRegistered } from '../synax/index.js';
import { resetAgentRuntimeFixtures } from './agent-runtime-fixtures.js';

vi.mock('../loop-runtime.js', () => ({ agentLoopRuntime: { streamRun: vi.fn(), streamContinue: vi.fn(), interruptSessions: vi.fn() } }));
vi.mock('../session-title-service.js', () => ({ registerTitleGenerator: vi.fn(), resolveInitialSessionTitle: vi.fn(({ prompt }: { prompt: string }) => prompt), maybeScheduleSessionTitleFromStreamChunk: vi.fn(), ensureSessionTitleGenerated: vi.fn() }));

describe('goal stream observation', () => {
  beforeEach(()=>{resetAgentRuntimeFixtures();ensureSynaxAgentRegistered();vi.clearAllMocks();});
  it('keeps the producer alive after the browser disconnects',async()=>{
    const session=agentSessionRuntime.create({projectId:'project-alpha',profileId:'synax',prompt:'A goal',sessionMetadata:{mode:'goal'}});
    let release!:()=>void; const gate=new Promise<void>(r=>{release=r;}); let finished=false;
    vi.mocked(agentLoopRuntime.streamRun).mockImplementation(async function*(){
      yield {type:'message_delta',runId:'r',stepId:'s',delta:'Working'};
      await gate; finished=true;
      yield {type:'done',sessionId:session.id,runId:'r'};
    });
    const controller=new AbortController();const stream=streamAgentSession(session.id,'turn',{},controller.signal);
    expect((await stream.next()).value).toMatchObject({type:'message_delta'});
    controller.abort();
    expect((await stream.next()).done).toBe(true);
    expect(finished).toBe(false);
    release();await vi.waitFor(()=>expect(finished).toBe(true));
    expect(vi.mocked(agentLoopRuntime.streamRun).mock.calls[0][2]).toBeUndefined();
  });
  it('cannot bypass native plan restrictions by selecting an ACP model',async()=>{
    const session=agentSessionRuntime.create({projectId:'project-alpha',profileId:'synax',prompt:'A plan',sessionMetadata:{mode:'plan'}});
    const stream=streamAgentSession(session.id,'turn',{model:'cursor-acp/default'});
    await expect(stream.next()).rejects.toThrow('execution backend');
    expect(agentLoopRuntime.streamRun).not.toHaveBeenCalled();
  });
});
