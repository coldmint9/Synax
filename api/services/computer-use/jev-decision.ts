export interface Candidate {
  id: string;
  description: string;
  tool?: 'click' | 'type_text';
  args?: Record<string, unknown>;
}
export interface JevDecisionInput {
  goal: string;
  observation: string;
  candidates: readonly Candidate[];
}
export interface JevDecision {
  selectedId: string;
  confidence: number;
}

export function validateJevDecision(raw: unknown, candidates: readonly Candidate[]): JevDecision {
  if (!raw || typeof raw !== 'object') throw new Error('Jev returned an invalid decision');
  const value = raw as Record<string, unknown>;
  if (typeof value.selectedId !== 'string' || !candidates.some(c => c.id === value.selectedId))
    throw new Error('Jev selected an unknown candidate');
  if (typeof value.confidence !== 'number' || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1)
    throw new Error('Jev returned invalid confidence');
  if (value.probabilities !== undefined) {
    if (!value.probabilities || typeof value.probabilities !== 'object' || Array.isArray(value.probabilities))
      throw new Error('Jev returned invalid probabilities');
    const validIds = new Set(candidates.map(candidate => candidate.id));
    for (const [id, probability] of Object.entries(value.probabilities)) {
      if (!validIds.has(id) || typeof probability !== 'number' || !Number.isFinite(probability) || probability < 0 || probability > 1)
        throw new Error('Jev returned invalid probabilities');
    }
  }
  return { selectedId: value.selectedId, confidence: value.confidence };
}

export interface JevDecisionService { choose(input: JevDecisionInput, signal?: AbortSignal): Promise<JevDecision>; }

/** Test-only deterministic selector. Never used as a production fallback. */
export class MockJevDecisionService implements JevDecisionService {
  async choose(input: JevDecisionInput): Promise<JevDecision> {
    return { selectedId: input.candidates.find(c => c.tool)?.id ?? 'abstain', confidence: 1 };
  }
}

/** Lazy import: Direct Cua neither imports the SDK nor contacts Jev. */
export class LiveJevDecisionService implements JevDecisionService {
  constructor(private readonly apiKey: string) {}
  async choose(input: JevDecisionInput, signal?: AbortSignal): Promise<JevDecision> {
    signal?.throwIfAborted();
    if (input.candidates.length < 2 || input.candidates.length > 40) throw new Error('Invalid Jev candidate count');
    const { choice, TypeSafeClient } = await import('@typesafe-ai/sdk');
    const criteria = Object.fromEntries(input.candidates.map(c => [c.id, c.description]));
    const client = new TypeSafeClient({ apiKey: this.apiKey });
    const response = await client.systemOne({
      state: { observation: input.observation },
      questions: { candidate: choice(input.goal, criteria) },
    }, { signal, timeout: 15_000, retry: { maxRetries: 0 } });
    signal?.throwIfAborted();
    const answer = response.answers.candidate;
    if (answer.type !== 'choice') throw new Error('Jev returned an unexpected response type');
    return validateJevDecision({ selectedId: answer.choice, confidence: answer.confidence, probabilities: answer.probabilities }, input.candidates);
  }
}
