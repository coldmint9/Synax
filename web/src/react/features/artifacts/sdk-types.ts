import type {
  ArtifactControl,
  ArtifactState,
} from "../../../../../api/services/agent-runtime/artifacts/contracts";

/** Authoring contract for the global installed inside previews/exports. This module
 * has no runtime imports; importing it never grants application or Node access. */
export interface SynaxWidget {
  ready(): Promise<{
    theme: "light" | "dark";
    locale: string;
    state: ArtifactState;
    standalone: boolean;
  }>;
  getState(): ArtifactState;
  setState(next: {
    privateState?: unknown;
    modelState?: unknown;
  }): Promise<void>;
  onThemeChange(listener: (theme: "light" | "dark") => void): () => void;
  onStateChange(listener: (state: ArtifactState) => void): () => void;
  reportHeight(height: number): void;
  registerControls(schema: ArtifactControl[]): Promise<void>;
  onControlsChange(
    listener: (values: Record<string, unknown>) => void,
  ): () => void;
  requestFeedbackDraft(input: {
    text?: string;
    modelState?: unknown;
  }): Promise<void>;
}
