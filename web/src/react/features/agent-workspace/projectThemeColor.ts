export type ProjectThemeColor =
  | "blue"
  | "teal"
  | "amber"
  | "rose"
  | "violet"
  | "green"
  | "default";

const PROJECT_THEME_COLORS: readonly Exclude<ProjectThemeColor, "default">[] = [
  "blue",
  "teal",
  "amber",
  "rose",
  "violet",
  "green",
];

const projectColors = new Map<string, ProjectThemeColor>();
const assignedColors = new Set<Exclude<ProjectThemeColor, "default">>();

function pickProjectThemeColor(): ProjectThemeColor {
  let pool: Exclude<ProjectThemeColor, "default">[] =
    [...PROJECT_THEME_COLORS].filter((color) => !assignedColors.has(color));
  if (pool.length === 0) {
    assignedColors.clear();
    pool = [...PROJECT_THEME_COLORS];
  }
  const color = pool[Math.floor(Math.random() * pool.length)];
  assignedColors.add(color);
  return color;
}

export function getProjectThemeColor(projectId?: string | null): ProjectThemeColor {
  const key = projectId?.trim();
  if (!key) return "default";
  const existing = projectColors.get(key);
  if (existing) return existing;
  const color = pickProjectThemeColor();
  projectColors.set(key, color);
  return color;
}

export function resetProjectThemeColors(): void {
  projectColors.clear();
  assignedColors.clear();
}
