/** No persistent state, controls, feedback or host privileges. */
export interface SynaxWidget {
  ready(): Promise<{ theme: "light" | "dark"; locale: string }>;
  onThemeChange(listener: (theme: "light" | "dark") => void): () => void;
  reportHeight(height: number): void;
}
