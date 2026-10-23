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
const COLOR_STORAGE_KEY = 'synax:project-colors:v1';
let loaded = false;
function loadColors(): void {
  if (loaded) return;
  loaded = true;
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(COLOR_STORAGE_KEY) ?? '{}');
    if (!saved || typeof saved !== 'object') return;
    for (const [id, value] of Object.entries(saved).slice(-512)) {
      if (PROJECT_THEME_COLORS.includes(value as Exclude<ProjectThemeColor, 'default'>)) {
        projectColors.set(id, value as ProjectThemeColor);
        assignedColors.add(value as Exclude<ProjectThemeColor, 'default'>);
      }
    }
  } catch { /* Storage may be unavailable; in-memory colors remain stable. */ }
}

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
  loadColors();
  const existing = projectColors.get(key);
  if (existing) return existing;
  const color = pickProjectThemeColor();
  projectColors.set(key, color);
  try { localStorage.setItem(COLOR_STORAGE_KEY, JSON.stringify(Object.fromEntries([...projectColors].slice(-512)))); } catch { /* optional persistence */ }
  return color;
}

export function resetProjectThemeColors(): void {
  projectColors.clear();
  assignedColors.clear();
  loaded = false;
  try { localStorage.removeItem(COLOR_STORAGE_KEY); } catch { /* optional persistence */ }
}
