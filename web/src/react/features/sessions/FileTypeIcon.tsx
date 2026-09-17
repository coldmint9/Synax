import { memo } from 'react'
import { FileIcon } from '@react-symbols/icons/utils'

interface FileTypeIconProps {
  path: string
  size?: number
  className?: string
}

/** Compact file-type mark shared by links, lists, tabs, and viewer headers. */
export const FileTypeIcon = memo(function FileTypeIcon({
  path,
  size = 12,
  className = '',
}: FileTypeIconProps) {
  const fileName = path.split(/[\\/]/).pop() || path

  return (
    <FileIcon
      fileName={fileName}
      autoAssign
      width={size}
      height={size}
      className={`file-type-icon ${className}`.trim()}
      aria-hidden="true"
      focusable="false"
      data-file-type-icon={fileName}
    />
  )
})
