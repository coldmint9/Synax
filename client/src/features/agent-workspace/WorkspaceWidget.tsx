import { Children, Fragment, isValidElement, type ReactNode } from "react";

/** Register a widget by composing this definition into WorkspaceDashboardLayout. */
export interface WorkspaceWidgetDefinition {
  id: string;
  label: string;
  children: ReactNode;
}

export function WorkspaceWidget({ children }: WorkspaceWidgetDefinition) {
  return <>{children}</>;
}

export function collectWorkspaceWidgets(children: ReactNode): WorkspaceWidgetDefinition[] {
  return Children.toArray(children).flatMap((child) => {
    if (!isValidElement(child)) return [];
    if (child.type === Fragment)
      return collectWorkspaceWidgets((child.props as { children: ReactNode }).children);
    return child.type === WorkspaceWidget ? [child.props as WorkspaceWidgetDefinition] : [];
  });
}
