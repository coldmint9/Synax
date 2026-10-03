import { Select } from "@/shared/ui/ui/Select";
import { FolderCode } from "lucide-react";
import type { ProjectWorkspaceRoot } from "../../adapters/transport/project";
import { useWorkspaceCopy } from "./workspaceCopy";
import "./workspaceProjects.css";

/** Full project identity stays visible even when several roots share a name. */
export function WorkspaceRootSelect({
  roots,
  value,
  onChange,
  disabled,
}: {
  roots: ProjectWorkspaceRoot[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
}) {
  const c = useWorkspaceCopy();
  return (
    <Select
      value={value || null}
      onChange={(key) => {
        if (key) onChange(key);
      }}
      disabled={disabled || roots.length === 0}
      className="workspace-root-select"
      label={c.members}
      placeholder={c.noRoots}
      leading={<FolderCode size={15} className="text-muted-foreground" />}
      options={roots.map((root) => ({
        value: root.id,
        textValue: `${root.name} ${root.path}`,
        disabled: root.status === "missing",
        label: (
          <div className="workspace-project-text">
            <div className="workspace-project-name">
              <strong>{root.name}</strong>
              {root.role === "primary" && (
                <span className="workspace-primary-badge">{c.primary}</span>
              )}
              {root.status === "missing" && (
                <span className="text-danger text-xs">{c.missing}</span>
              )}
            </div>
            <span>{root.path}</span>
          </div>
        ),
      }))}
    />
  );
}
