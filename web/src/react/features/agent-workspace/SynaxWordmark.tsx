import "./newSessionWelcome.css";

// Plain ASCII, not an image: the bundled mono face keeps every column aligned offline.
const WORDMARK =
  "  ____  __   __  _   _     _    __  __\n / ___| \\ \\ / / | \\ | |   / \\   \\ \\/ /\n \\___ \\  \\ V /  |  \\| |  / _ \\   \\  /\n  ___) |  | |   | |\\  | / ___ \\  /  \\\n |____/   |_|   |_| \\_|/_/   \\_\\/_/\\_\\";

export function SynaxWordmark({ compact = false }: { compact?: boolean }) {
  return (
    <div
      className={`synax-wordmark${compact ? " synax-wordmark--compact" : ""}`}
      role="img"
      aria-label="Synax"
    >
      <pre aria-hidden="true">{WORDMARK}</pre>
    </div>
  );
}
