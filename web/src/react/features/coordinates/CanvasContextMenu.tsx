import { createPortal } from 'react-dom'
import { useEffect } from 'react'

type MenuKind = 'pane' | 'node' | 'edge'

interface CanvasContextMenuProps {
  x: number
  y: number
  kind: MenuKind
  canCreateFeature?: boolean
  canCreateGoal?: boolean
  canCreateAction?: boolean
  onCreateFeature: () => void
  onCreateGoal: () => void
  onCreateAction: () => void
  onCopyNode: () => void
  onDeleteNode: () => void
  onDeleteEdge: () => void
  onSetDependencyMode: () => void
  onSetRelatedMode: () => void
  onClose: () => void
}

export default function CanvasContextMenu(props: CanvasContextMenuProps) {
  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose()
    }
    window.addEventListener('keydown', onEsc)
    return () => window.removeEventListener('keydown', onEsc)
  }, [props])

  const content = (
    <div
      className="fixed z-[400] min-w-[168px] rounded-lg border border-border bg-popover p-1 shadow-xl"
      style={{ left: props.x, top: props.y }}
      onMouseLeave={props.onClose}
    >
      {props.kind !== 'edge' ? (
        <>
          <div className="mb-1 border-b border-border/50 px-2 py-1 text-[10px] text-muted-foreground">
            连线模式
          </div>
          <button className="context-menu-btn" type="button" onClick={props.onSetDependencyMode}>Dependency</button>
          <button className="context-menu-btn" type="button" onClick={props.onSetRelatedMode}>Related</button>
          <div className="my-1 border-b border-border/50" />
          {props.canCreateFeature && <button className="context-menu-btn" type="button" onClick={props.onCreateFeature}>新建 Feature</button>}
          {props.canCreateGoal && <button className="context-menu-btn" type="button" onClick={props.onCreateGoal}>新建 Goal</button>}
          {props.canCreateAction && <button className="context-menu-btn" type="button" onClick={props.onCreateAction}>新建 Action</button>}
          {props.kind === 'node' && <button className="context-menu-btn" type="button" onClick={props.onCopyNode}>复制节点</button>}
          {props.kind === 'node' && (
            <button className="context-menu-btn text-destructive" type="button" onClick={props.onDeleteNode}>
              删除节点
            </button>
          )}
        </>
      ) : (
        <button className="context-menu-btn text-destructive" type="button" onClick={props.onDeleteEdge}>
          删除连线
        </button>
      )}
    </div>
  )
  return createPortal(content, document.body)
}
