/**
 * Bounded diagnostic envelope for OpenAI Responses stream state.
 *
 * AI SDK already maps Responses events to the common LanguageModelV3 stream,
 * Response identity/status and standard usage remain available. Large raw
 * diagnostic copies are explicitly omitted; replay uses the separately stored
 * reasoningParts, messages and tool calls, whose signatures remain untouched.
 */
import { whitelistRawUsage } from "../../infrastructure/llm-runtime/usage.js";
import { assertBatchInput } from "./checkpoints/version-runtime/batch-input.js";
import { VersionStoreError } from "./checkpoints/version-store/limits.js";

const OUTPUT_DIAGNOSTIC_BYTES = 512 * 1024;
const USAGE_DIAGNOSTIC_BYTES = 64 * 1024;

function exceedsDiagnosticBudget(value: unknown, bytes: number): boolean {
  try {
    assertBatchInput(value, bytes);
    return false;
  } catch (error) {
    if (error instanceof VersionStoreError && error.code === "VERSION_BATCH_BUDGET") return true;
    throw error;
  }
}
export interface ResponsesProtocolSnapshot {
  protocol: 'openai-responses'
  responseId?: string
  status?: string
  output?: unknown[]
  incompleteDetails?: unknown
  usage?: Record<string, unknown>
  diagnosticProjection?: { omittedFields: string[]; reason: 'diagnostic_byte_budget' }
}

export class ResponsesSnapshotAccumulator {
  private responseId: string | undefined
  private status: string | undefined
  private output: unknown[] = []
  private incompleteDetails: unknown
  private usage: Record<string, unknown> | undefined

  ingest(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return
    const value = raw as Record<string, unknown>
    const type = typeof value.type === 'string' ? value.type : ''

    const response = isRecord(value.response) ? value.response : undefined
    if (response) {
      if (typeof response.id === 'string') this.responseId = response.id
      if (typeof response.status === 'string') this.status = response.status
      if (Array.isArray(response.output)) this.output = response.output
      if ('incomplete_details' in response) this.incompleteDetails = response.incomplete_details
      if (isRecord(response.usage)) this.usage = response.usage
    }

    if (type === 'response.output_item.added' || type === 'response.output_item.done') {
      const item = value.item
      if (item !== undefined) this.upsertOutputItem(item)
    }

    if (type === 'response.completed' || type === 'response.incomplete' || type === 'response.failed') {
      if (type === 'response.completed') this.status = 'completed'
      if (type === 'response.incomplete') this.status = 'incomplete'
      if (type === 'response.failed') this.status = 'failed'
      if ('incomplete_details' in value) this.incompleteDetails = value.incomplete_details
    }
  }

  snapshot(): ResponsesProtocolSnapshot | undefined {
    if (!this.responseId && !this.status && this.output.length === 0 && !this.usage) return undefined
    const omittedFields: string[] = [];
    const omitOutput = exceedsDiagnosticBudget(this.output, OUTPUT_DIAGNOSTIC_BYTES);
    if (omitOutput) omittedFields.push('output');
    let usage = this.usage;
    if (usage && exceedsDiagnosticBudget(usage, USAGE_DIAGNOSTIC_BYTES)) {
      usage = whitelistRawUsage(usage);
      omittedFields.push('usage.extensions');
    }
    const omitIncompleteDetails = this.incompleteDetails !== undefined &&
      exceedsDiagnosticBudget(this.incompleteDetails, USAGE_DIAGNOSTIC_BYTES);
    if (omitIncompleteDetails) omittedFields.push('incompleteDetails');
    return {
      protocol: 'openai-responses',
      ...(this.responseId ? { responseId: this.responseId } : {}),
      ...(this.status ? { status: this.status } : {}),
      ...(this.output.length > 0 && !omitOutput ? { output: this.output } : {}),
      ...(this.incompleteDetails !== undefined && !omitIncompleteDetails ? { incompleteDetails: this.incompleteDetails } : {}),
      ...(usage ? { usage } : {}),
      ...(omittedFields.length ? {
        diagnosticProjection: { omittedFields, reason: 'diagnostic_byte_budget' as const },
      } : {}),
    }
  }

  private upsertOutputItem(item: unknown): void {
    const id = isRecord(item) && typeof item.id === 'string' ? item.id : undefined
    if (!id) {
      this.output.push(item)
      return
    }
    const index = this.output.findIndex(existing => isRecord(existing) && existing.id === id)
    if (index >= 0) this.output[index] = item
    else this.output.push(item)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
