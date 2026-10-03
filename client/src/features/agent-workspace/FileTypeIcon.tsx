import { memo } from "react";
import { fileTypeIconForName } from "./fileTypeIcons";

interface FileTypeIconProps {
  path: string;
  size?: number;
  className?: string;
}

/** Compact file-type mark shared by links, lists, tabs, and viewer headers. */
export const FileTypeIcon = memo(function FileTypeIcon({
  path,
  size = 12,
  className = "",
}: FileTypeIconProps) {
  const fileName = path.split(/[\\/]/).pop() || path;

  const Icon = fileTypeIconForName(fileName);

  return (
    <Icon
      color="currentColor"
      strokeWidth={2}
      width={size}
      height={size}
      className={`file-type-icon ${className}`.trim()}
      aria-hidden="true"
      focusable="false"
      data-file-type-icon={fileName}
    />
  );
});
