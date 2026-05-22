import {
  Background,
  ControlButton,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type EdgeChange,
  type FinalConnectionState,
  type IsValidConnection,
  type NodeChange,
  type OnReconnect,
} from '@xyflow/react'
import { BookOpen, LayoutGrid } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { type CoordNodeType, validateCoordConnection } from '../../../lib/coordinates'
import { forestToReactFlow, useCoordinatesState, useCoordinatesStore } from '../../state/coordinatesStore'
import { useShellStore } from '../../state/shellStore'
import { useReviewStore } from '../../state/reviewStore'
import CoordEdgeView from './CoordEdge'
import CoordNodeView from './CoordNode'
import CoordToolbar from './CoordToolbar'
import CanvasContextMenu from './CanvasContextMenu'
import NodeDetailPanel from './NodeDetailPanel'
import InitProgressOverlay from './InitProgressOverlay'
import CodeSearchPanel from './CodeSearchPanel'
import ContextPanel from './context/ContextPanel'
import { ReviewPanel } from '../review/ReviewPanel'

interface CoordinatesFlowProps {
  projectId: string
  projectName: string
}

// MiniMap 颜色回调（组件外定义，引用稳定）
function miniNodeColor(n: any): string {
  return n.data?.minimapColor ?? '#64748b'
}
function miniNodeStroke(n: any): string {
  return n.data?.minimapStroke ?? '#94a3b8'
}

const nodeTypes = { coordNode: CoordNodeView }
const edgeTypes = { coordEdge: CoordEdgeView }

type ReactFlowGraphData = ReturnType<typeof forestToReactFlow>
type ReactFlowGraphNode = ReactFlowGraphData['nodes'][number]

interface ReactFlowGraphProps {
  theme: 'light' | 'dark' | 'system'
  isDark: boolean
  nodes: ReactFlowGraphData['nodes']
  edges: ReactFlowGraphData['edges']
  isValidConnection: IsValidConnection
  onMoveNodes: (updates: Array<{ id: string; x: number; y: number }>) => void
  onEdgesChange: (changes: EdgeChange[]) => void
  onConnect: (connection: Connection) => void
  onReconnect: OnReconnect
  onReconnectEnd: (
    event: MouseEvent | TouchEvent,
    edge: any,
    handleType: string,
    connectionState: FinalConnectionState,
  ) => void
  onConnectEnd: (
    event: MouseEvent | TouchEvent,
    connectionState: FinalConnectionState,
  ) => void
  onPaneClick: () => void
  onNodeClick: (event: React.MouseEvent, node: any) => void
  onEdgeClick: (event: React.MouseEvent, edge: any) => void
  onPaneContextMenu: (event: React.MouseEvent | MouseEvent) => void
  onNodeContextMenu: (event: React.MouseEvent, node: any) => void
  onEdgeContextMenu: (event: React.MouseEvent, edge: any) => void
  onAutoArrange: () => void
}

function ReactFlowGraph({
  theme,
  isDark,
  nodes,
  edges,
  isValidConnection,
  onMoveNodes,
  onEdgesChange,
  onConnect,
  onReconnect,
  onReconnectEnd,
  onConnectEnd,
  onPaneClick,
  onNodeClick,
  onEdgeClick,
  onPaneContextMenu,
  onNodeContextMenu,
  onEdgeContextMenu,
  onAutoArrange,
}: ReactFlowGraphProps) {
  const [flowNodes, setFlowNodes] = useState(nodes)
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null)

  useEffect(() => setFlowNodes(nodes), [nodes])

  const displayEdges = useMemo(() => {
    if (!hoveredNodeId) return edges
    return edges.map(edge => ({
      ...edge,
      style: {
        ...(edge.style as Record<string, unknown> | undefined),
        opacity: (edge.source === hoveredNodeId || edge.target === hoveredNodeId) ? 1 : 0.12,
        transition: 'opacity 0.2s ease',
      },
    }))
  }, [edges, hoveredNodeId])

  const handleNodesChange = (changes: NodeChange<ReactFlowGraphNode>[]) => {
    setFlowNodes((currentNodes) => applyNodeChanges<ReactFlowGraphNode>(changes, currentNodes))
    const settledPositions = changes
      .filter((change): change is Extract<NodeChange, { type: 'position' }> =>
        change.type === 'position' && change.dragging !== true && Boolean(change.position)
      )
      .map((change) => ({ id: change.id, x: change.position!.x, y: change.position!.y }))
    onMoveNodes(settledPositions)
  }

  return (
    <ReactFlow
      colorMode={theme}
      nodes={flowNodes}
      edges={displayEdges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      fitView
      snapToGrid
      nodesDraggable
      nodesConnectable
      edgesFocusable
      edgesReconnectable
      minZoom={0.3}
      maxZoom={2.2}
      isValidConnection={isValidConnection}
      onNodesChange={handleNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      onReconnect={onReconnect}
      onReconnectEnd={onReconnectEnd}
      onConnectEnd={onConnectEnd}
      onPaneClick={() => {
        setHoveredNodeId(null)
        onPaneClick()
      }}
      onNodeClick={onNodeClick}
      onNodeMouseEnter={(_, node) => setHoveredNodeId(node.id)}
      onNodeMouseLeave={() => setHoveredNodeId(null)}
      onEdgeClick={onEdgeClick}
      onPaneContextMenu={onPaneContextMenu}
      onNodeContextMenu={onNodeContextMenu}
      onEdgeContextMenu={onEdgeContextMenu}
    >
      <Background gap={24} size={1} color="var(--glass-border)" />
      <MiniMap
        pannable
        zoomable
        ariaLabel="Coordinates minimap"
        style={{
          backgroundColor: isDark ? 'hsl(30 10% 11% / 0.84)' : 'hsl(42 28% 98% / 0.84)',
          border: '1px solid var(--glass-border)',
          backdropFilter: 'blur(6px)',
        }}
        maskColor={isDark ? 'rgb(8 10 12 / 0.6)' : 'rgb(255 255 255 / 0.6)'}
        nodeColor={miniNodeColor}
        nodeStrokeColor={miniNodeStroke}
        nodeStrokeWidth={1.5}
      />
      <Controls
        style={{
          backgroundColor: isDark ? 'hsl(30 10% 11% / 0.82)' : 'hsl(42 28% 98% / 0.82)',
          border: '1px solid var(--glass-border)',
          color: 'var(--foreground)',
          backdropFilter: 'blur(6px)',
        }}
      >
        <ControlButton onClick={onAutoArrange} title="自动整理布局" aria-label="Auto arrange layout">
          <LayoutGrid size={14} />
        </ControlButton>
      </Controls>
    </ReactFlow>
  )
}

function CoordinatesFlowInner({ projectId, projectName }: CoordinatesFlowProps) {
  const store = useCoordinatesStore(projectId, projectName)
  const forest = useCoordinatesState(projectId, projectName, s => s.forest)
  const nodePositions = useCoordinatesState(projectId, projectName, s => s.nodePositions)
  const selectedNodeId = useCoordinatesState(projectId, projectName, s => s.selectedNodeId)
  const selectedEdgeId = useCoordinatesState(projectId, projectName, s => s.selectedEdgeId)
  const backgroundMode = useCoordinatesState(projectId, projectName, s => s.backgroundMode)
  const layoutVersion = useCoordinatesState(projectId, projectName, s => s.layoutVersion)
  const contextIndex = useCoordinatesState(projectId, projectName, s => s.contextIndex)
  const lastConnectionError = useCoordinatesState(projectId, projectName, s => s.lastConnectionError)
  const connectionMode = useCoordinatesState(projectId, projectName, s => s.connectionMode)
  const convergenceFlags = useCoordinatesState(projectId, projectName, s => s.convergenceReport.flags)
  const setSelectedNode = useCoordinatesState(projectId, projectName, s => s.setSelectedNode)
  const setSelectedEdge = useCoordinatesState(projectId, projectName, s => s.setSelectedEdge)
  const setConnectionMode = useCoordinatesState(projectId, projectName, s => s.setConnectionMode)
  const autoArrange = useCoordinatesState(projectId, projectName, s => s.autoArrange)
  const moveNodes = useCoordinatesState(projectId, projectName, s => s.moveNodes)
  const createNode = useCoordinatesState(projectId, projectName, s => s.createNode)
  const copyNode = useCoordinatesState(projectId, projectName, s => s.copyNode)
  const removeNode = useCoordinatesState(projectId, projectName, s => s.removeNode)
  const connectNodes = useCoordinatesState(projectId, projectName, s => s.connectNodes)
  const removeEdge = useCoordinatesState(projectId, projectName, s => s.removeEdge)
  const reconnectEdge = useCoordinatesState(projectId, projectName, s => s.reconnectEdge)
  const clearConnectionError = useCoordinatesState(projectId, projectName, s => s.clearConnectionError)
  const setConnectionError = useCoordinatesState(projectId, projectName, s => s.setConnectionError)
  const refreshContextIndex = useCoordinatesState(projectId, projectName, s => s.refreshContextIndex)
  const bindContextBlockToNode = useCoordinatesState(projectId, projectName, s => s.bindContextBlockToNode)
  const submitIntent = useCoordinatesState(projectId, projectName, s => s.submitIntent)
  const acceptRun = useCoordinatesState(projectId, projectName, s => s.acceptRun)
  const rejectRun = useCoordinatesState(projectId, projectName, s => s.rejectRun)
  const reRunAction = useCoordinatesState(projectId, projectName, s => s.reRunAction)
  const dispatchActionPrompt = useCoordinatesState(projectId, projectName, s => s.dispatchActionPrompt)
  const startGoalReview = useCoordinatesState(projectId, projectName, s => s.startGoalReview)
  const applyGoalReview = useCoordinatesState(projectId, projectName, s => s.applyGoalReview)
  const updateNodeFields = useCoordinatesState(projectId, projectName, s => s.updateNodeFields)
  const theme = useShellStore(s => s.preferences.theme)
  const { fitView } = useReactFlow()
  const { nodes, edges } = useMemo(() => forestToReactFlow({
    forest,
    nodePositions,
    selectedNodeId,
    selectedEdgeId,
    contextIndex,
  }), [forest, nodePositions, selectedNodeId, selectedEdgeId, contextIndex])
  const [menu, setMenu] = useState<{ x: number; y: number; kind: 'pane' | 'node' | 'edge'; id?: string } | null>(null)
  const [contextOpen, setContextOpen] = useState(false)
  const isDark = theme === 'dark'

  useEffect(() => {
    if (!projectId) return
    void refreshContextIndex()
  }, [projectId, refreshContextIndex])

  // 布局版本号变化时重新适配视口
  useEffect(() => {
    if (layoutVersion > 0) {
      requestAnimationFrame(() => {
        fitView({ padding: 0.15, duration: 300 })
      })
    }
  }, [layoutVersion, fitView])

  const selectedNode = selectedNodeId ? forest.nodes[selectedNodeId] : null
  const selectedFeatureLabel = useMemo(() => {
    if (!selectedNode) return 'General'
    if (selectedNode.type === 'feature') return selectedNode.label
    let current = selectedNode
    while (current.parentId) {
      const parent = forest.nodes[current.parentId]
      if (!parent) break
      if (parent.type === 'feature') return parent.label
      current = parent
    }
    return 'General'
  }, [selectedNode, forest.nodes])

  const isValidConnection: IsValidConnection = (candidate) => {
    if (!candidate.source || !candidate.target) return false
    return validateCoordConnection(
      store.getState().forest,
      candidate.source,
      candidate.target,
      store.getState().connectionMode,
    ).ok
  }

  const onEdgesChange = (changes: EdgeChange[]) => {
    const removed = changes.filter(c => c.type === 'remove').map(c => c.id)
    removed.forEach(id => removeEdge(id))
  }

  const onConnect = (connection: Connection) => {
    if (!connection.source || !connection.target) return
    connectNodes(connection.source, connection.target, store.getState().connectionMode)
  }

  const onReconnect: OnReconnect = (oldEdge, connection) => {
    if (!connection.source || !connection.target) return
    reconnectEdge(oldEdge.id, connection.source, connection.target)
  }

  const onReconnectEnd = (
    _: MouseEvent | TouchEvent,
    edge: any,
    _handleType: string,
    connectionState: FinalConnectionState,
  ) => {
    if (connectionState.isValid) return
    setSelectedEdge(edge.id)
  }

  const onConnectEnd = (
    _: MouseEvent | TouchEvent,
    connectionState: FinalConnectionState,
  ) => {
    // Only show error when dropped on a specific node but validation failed
    if (!connectionState.fromNode || !connectionState.toNode) return
    if (connectionState.isValid !== false) return
    const result = validateCoordConnection(
      store.getState().forest,
      connectionState.fromNode.id,
      connectionState.toNode.id,
      store.getState().connectionMode,
    )
    if (!result.ok) {
      setConnectionError(result.reason ?? 'Connection is not allowed.')
    }
  }

  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setMenu(null)
      clearConnectionError()
      setSelectedEdge(null)
    }
    window.addEventListener('keydown', onEsc)
    return () => window.removeEventListener('keydown', onEsc)
  }, [clearConnectionError, setSelectedEdge])

  const createFromMenu = (type: CoordNodeType) => {
    if (!menu) return
    if (type === 'feature') {
      createNode(store.getState().forest.rootId, 'feature')
      setMenu(null)
      return
    }
    if (!menu.id) return
    const node = store.getState().forest.nodes[menu.id]
    if (!node) return
    if (type === 'goal') createNode(node.id, 'goal')
    if (type === 'action') createNode(node.type === 'goal' ? node.id : (node.parentId ?? node.id), 'action')
    setMenu(null)
  }

  // 点击节点时展开面板（仅 action 类型自动展开）
  const handleNodeClick = (_: React.MouseEvent, node: any) => {
    setSelectedNode(node.id)
    setMenu(null)
  }

  return (
    <div className="flex h-full w-full">
      {/* ── Canvas Area ── */}
      <div className={`relative flex-1 min-w-0 ${backgroundMode === 'gridLight' ? 'canvas-grid-light' : 'bg-background'}`}>
        <ReactFlowGraph
          theme={theme}
          isDark={isDark}
          nodes={nodes}
          edges={edges}
          isValidConnection={isValidConnection}
          onMoveNodes={moveNodes}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onReconnect={onReconnect}
          onReconnectEnd={onReconnectEnd}
          onConnectEnd={onConnectEnd}
          onPaneClick={() => {
            setMenu(null)
            clearConnectionError()
            setSelectedNode(null)
            setSelectedEdge(null)
          }}
          onNodeClick={handleNodeClick}
          onEdgeClick={(_, edge) => {
            setSelectedEdge(edge.id)
            setMenu(null)
          }}
          onPaneContextMenu={(e) => {
            e.preventDefault()
            setMenu({ x: e.clientX, y: e.clientY, kind: 'pane' })
          }}
          onNodeContextMenu={(e, node) => {
            e.preventDefault()
            setMenu({ x: e.clientX, y: e.clientY, kind: 'node', id: node.id })
          }}
          onEdgeContextMenu={(e, edge) => {
            e.preventDefault()
            setMenu({ x: e.clientX, y: e.clientY, kind: 'edge', id: edge.id })
          }}
          onAutoArrange={autoArrange}
        />

        <CoordToolbar
          disabled={false}
          selectedNodeLabel={selectedNode?.label ?? ''}
          selectedFeatureLabel={selectedFeatureLabel}
          selectedNodeType={selectedNode?.type}
          selectedNodeStatus={selectedNode?.status}
          connectionMode={connectionMode}
          projectName={projectName}
          onSubmit={(payload) => submitIntent(payload)}
          onToggleConnectionMode={() =>
            setConnectionMode(
              store.getState().connectionMode === 'dependency' ? 'related' : 'dependency'
            )
          }
        />

        {/* ── 边图例 + 连接模式指示器 ── */}
        <div className="absolute top-3 left-3 z-20 flex items-center gap-3 rounded-lg border border-border/30 bg-background/80 px-3 py-2 text-[10px] shadow-sm backdrop-blur-sm">
          <div className="flex items-center gap-1.5">
            <svg width="20" height="3" viewBox="0 0 20 3">
              <line x1="0" y1="1.5" x2="20" y2="1.5" stroke="hsl(160 8% 62% / 0.5)" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
            <span className="text-muted-foreground">parent</span>
          </div>
          <div className="flex items-center gap-1.5">
            <svg width="20" height="3" viewBox="0 0 20 3">
              <line x1="0" y1="1.5" x2="20" y2="1.5" stroke="hsl(210 80% 56% / 0.85)" strokeWidth="2" strokeDasharray="3 2" strokeLinecap="round" />
            </svg>
            <span className="text-muted-foreground">depends</span>
          </div>
          <div className="flex items-center gap-1.5">
            <svg width="20" height="3" viewBox="0 0 20 3">
              <line x1="0" y1="1.5" x2="20" y2="1.5" stroke="hsl(24 86% 52% / 0.75)" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <span className="text-muted-foreground">related</span>
          </div>
          <div className="h-3 w-px bg-border/50" />
          <div
            className={`rounded border px-1.5 py-0.5 font-medium ${
              connectionMode === 'dependency'
                ? 'border-blue-500/40 bg-blue-500/10 text-blue-400'
                : 'border-orange-500/40 bg-orange-500/10 text-orange-400'
            }`}
            title="右键菜单可切换连接模式"
          >
            {connectionMode === 'dependency' ? 'dep' : 'rel'}
          </div>
        </div>

        {lastConnectionError && (
          <div className="absolute bottom-16 left-1/2 z-30 -translate-x-1/2 rounded-md border border-destructive/40 bg-background/90 px-3 py-1 text-xs text-destructive">
            {lastConnectionError}
          </div>
        )}

        {menu && (
          <CanvasContextMenu
            x={menu.x}
            y={menu.y}
            kind={menu.kind}
            canCreateFeature={menu.kind === 'pane' || (menu.kind === 'node' && forest.nodes[menu.id!]?.type === 'project')}
            canCreateGoal={menu.kind === 'node' && forest.nodes[menu.id!]?.type === 'feature'}
            canCreateAction={menu.kind === 'node' && ['goal', 'action'].includes(forest.nodes[menu.id!]?.type)}
            onCreateFeature={() => createFromMenu('feature')}
            onCreateGoal={() => createFromMenu('goal')}
            onCreateAction={() => createFromMenu('action')}
            onSetDependencyMode={() => { setConnectionMode('dependency'); setMenu(null) }}
            onSetRelatedMode={() => { setConnectionMode('related'); setMenu(null) }}
            onCopyNode={() => {
              if (menu.id) copyNode(menu.id)
              setMenu(null)
            }}
            onDeleteNode={() => {
              if (menu.id) removeNode(menu.id)
              setMenu(null)
            }}
            onDeleteEdge={() => {
              if (menu.id) removeEdge(menu.id)
              setMenu(null)
            }}
            onClose={() => setMenu(null)}
          />
        )}

        {/* ── v3 analyzer 挂载点：仅保留面向用户的检索 + 分析进度 ── */}
        <InitProgressOverlay projectId={projectId} projectName={projectName} />

        {/* ── 右上角：代码检索 + 上下文（纵向右对齐，避免窄屏/换行时横向重叠）── */}
        <div className="pointer-events-none absolute right-3 top-3 z-20 flex max-w-[calc(100%-1.5rem)] flex-col items-end gap-2">
          <div className="pointer-events-auto w-full max-w-full sm:w-auto sm:max-w-none flex justify-end">
            <CodeSearchPanel projectId={projectId} projectName={projectName} />
          </div>
          {!contextOpen && (
            <button
              type="button"
              onClick={() => setContextOpen(true)}
              className="pointer-events-auto flex shrink-0 items-center gap-1.5 rounded-lg border border-border/40 bg-background/80 px-2 py-1.5 text-[11px] text-muted-foreground shadow-sm backdrop-blur-sm hover:bg-secondary/60 hover:text-foreground"
              title="Open context panel"
            >
              <BookOpen size={12} />
              <span>Context</span>
            </button>
          )}
        </div>

        {/* ── Context Panel ── */}
        <ContextPanel
          open={contextOpen}
          selectedNode={selectedNode}
          contextIndex={contextIndex}
          onBindContextBlock={(nodeId, blockId, relation) => void bindContextBlockToNode(nodeId, blockId, relation)}
          onRefreshContext={() => void refreshContextIndex()}
          onClose={() => setContextOpen(false)}
          onSelectNode={(nodeId) => setSelectedNode(nodeId)}
        />
      </div>

      {/* ── Node Detail Panel (right side) ── */}
      {selectedNode && (
        <NodeDetailPanel
          node={selectedNode}
          scopeLine={`[Project: ${projectId}] [User: default]`}
          convergenceFlags={convergenceFlags}
          links={forest.links}
          codeIndex={forest.codeIndex}
          contextIndex={contextIndex}
          childActions={selectedNode.type === 'goal'
            ? selectedNode.children.flatMap(id => {
                const child = forest.nodes[id]
                return child ? [{ id: child.id, label: child.label, status: child.status }] : []
              })
            : undefined}
          onBindContextBlock={(nodeId, blockId, relation) => void bindContextBlockToNode(nodeId, blockId, relation)}
          onAccept={(actionId) => acceptRun(actionId)}
          onReject={(actionId, note, reasons) => rejectRun(actionId, note, reasons)}
          onReRun={(actionId) => reRunAction(actionId)}
          onDispatch={(actionId, prompt) => dispatchActionPrompt(actionId, prompt)}
          onStartGoalReview={(goalId) => startGoalReview(goalId)}
          onUpdateFields={(nodeId, fields) => updateNodeFields(nodeId, fields)}
          onClose={() => setSelectedNode(null)}
          onOpenContext={() => setContextOpen(true)}
        />
      )}

      {/* ── Batch Review Panel ── */}
      <ReviewPanel
        nodes={forest.nodes}
        onApply={(pkg) => applyGoalReview(pkg)}
        onClose={() => useReviewStore.getState().setPanelOpen(false)}
      />
    </div>
  )
}

export default function CoordinatesFlow(props: CoordinatesFlowProps) {
  return (
    <ReactFlowProvider>
      <CoordinatesFlowInner {...props} />
    </ReactFlowProvider>
  )
}
