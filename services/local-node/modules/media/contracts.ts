/** Explicit generation capabilities; input modalities alone do not imply generation. */
export type MediaAdapter = "openai" | "xai" | "ark" | "minimax" | "openrouter";
export type ModelCapability = "chat" | "image_generation" | "video_generation";
export type MediaOperation = "text-to-image" | "image-to-image" | "text-to-video" | "image-to-video";
export type MediaReferenceRole = "reference" | "first_frame" | "last_frame";
export interface MediaCapabilities {
  operations: MediaOperation[];
  referenceRoles?: MediaReferenceRole[];
  maxReferences?: number;
  parameters?: Record<string, { values?: Array<string | number | boolean>; min?: number; max?: number }>;
  streaming?: boolean;
  polling?: boolean;
  cancellation?: boolean;
}
export interface MediaModelSelection { providerId: string; modelId: string }
export interface MediaModel extends MediaModelSelection {
  label: string; providerLabel: string; adapter: MediaAdapter; capabilities: MediaCapabilities;
}
export interface MediaJobInput extends MediaModelSelection {
  projectId?: string;
  operation: MediaOperation;
  prompt: string;
  references?: Array<{ assetId: string; role: MediaReferenceRole }>;
  parameters?: Record<string, string | number | boolean>;
  idempotencyKey: string;
}
export type MediaJobStatus = "queued" | "submitting" | "running" | "downloading" | "succeeded" | "failed" | "cancelled" | "unknown";
export interface MediaJob {
  id: string; sessionId: string; input: MediaJobInput; status: MediaJobStatus;
  upstreamId?: string; error?: string; errorCode?: string;
  resultAssetIds: string[]; createdAt: string; updatedAt: string;
  cancellationSupported: boolean;
}
