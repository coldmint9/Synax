const reinitializingProjects = new Set<string>();

export function isProjectReinitializing(projectId: string): boolean {
  return reinitializingProjects.has(projectId);
}

export function beginProjectReinitialize(projectId: string): boolean {
  if (reinitializingProjects.has(projectId)) return false;
  reinitializingProjects.add(projectId);
  return true;
}

export function endProjectReinitialize(projectId: string): void {
  reinitializingProjects.delete(projectId);
}

/** Test-only helper */
export function _clearReinitializeLocksForTests(): void {
  reinitializingProjects.clear();
}
