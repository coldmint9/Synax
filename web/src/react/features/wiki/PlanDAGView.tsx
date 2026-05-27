import { useCallback, useEffect, useMemo, useRef } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  useNodesState,
  useEdgesState,
  useReactFlow,
  ReactFlowProvider,
  type Node,
  type Edge,
} from '@xyflow/react'
import dagre from '@dagrejs/dagre'
import '@xyflow/react/dist/style.css'
import { PlanDAGNode, type PlanDAGNodeData } from './PlanDAGNode'
import type { PlanNodeDraft, WikiPlanNode } from '../../../lib/api/evaluation'

interface PlanDAGViewProps {
  nodes: (PlanNodeDraft | WikiPlanNode)[]
  isGenerating?: boolean
  onNodeClick?: (node: PlanNodeDraft | WikiPlanNode, index: number) => void
}

const nodeTypes = { planNode: PlanDAGNode }

const NODE_WIDTH = 260
const NODE_HEIGHT = 100

function layoutGraph(planNodes: (PlanNodeDraft | WikiPlanNode)[]) {
  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: 'TB', nodesep: 50, ranksep: 70, marginx: 40, marginy: 40 })
  g.setDefaultEdgeLabel(() => ({}))

  planNodes.forEach((node, i) => {
    const id = getNodeId(node, i)
    g.setNode(id, { width: NODE_WIDTH, height: NODE_HEIGHT })
  })

  planNodes.forEach((node, i) => {
    const targetId = getNodeId(node, i)
    const deps = node.dependsOn ?? []
    deps.forEach(dep => {
      const sourceIdx = planNodes.findIndex(n => n.title === dep)
      if (sourceIdx >= 0) {
        const sourceId = getNodeId(planNodes[sourceIdx], sourceIdx)
        g.setEdge(sourceId, targetId)
      }
    })
  })

  dagre.layout(g)

  const rfNodes: Node<PlanDAGNodeData>[] = planNodes.map((node, i) => {
    const id = getNodeId(node, i)
    const pos = g.node(id)
    return {
      id,
      type: 'planNode',
      position: { x: pos.x - NODE_WIDTH / 2, y: pos.y - NODE_HEIGHT / 2 },
      data: { node, index: i, status: 'status' in node ? (node as WikiPlanNode).status : 'pending' },
    }
  })

  const rfEdges: Edge[] = planNodes.flatMap((node, i) => {
    const targetId = getNodeId(node, i)
    return (node.dependsOn ?? [])
      .map(dep => {
        const sourceIdx = planNodes.findIndex(n => n.title === dep)
        if (sourceIdx < 0) return null
        const sourceId = getNodeId(planNodes[sourceIdx], sourceIdx)
        return {
          id: `${sourceId}->${targetId}`,
          source: sourceId,
          target: targetId,
          style: { stroke: 'var(--color-muted-foreground)', strokeWidth: 1.5, opacity: 0.3 },
        }
      })
      .filter(Boolean) as Edge[]
  })

  return { rfNodes, rfEdges }
}

function getNodeId(node: PlanNodeDraft | WikiPlanNode, index: number): string {
  if ('id' in node && node.id) return node.id
  return `draft-${index}-${node.title}`
}

function PlanDAGViewInner({ nodes: planNodes, isGenerating, onNodeClick }: PlanDAGViewProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState([])
  const [edges, setEdges, onEdgesChange] = useEdgesState([])
  const { fitView } = useReactFlow()
  const prevLenRef = useRef(0)

  useEffect(() => {
    if (planNodes.length === 0) {
      setNodes([])
      setEdges([])
      return
    }
    const { rfNodes, rfEdges } = layoutGraph(planNodes)
    setNodes(rfNodes)
    setEdges(rfEdges)

    if (planNodes.length > prevLenRef.current) {
      setTimeout(() => fitView({ duration: 300, padding: 0.2 }), 50)
    }
    prevLenRef.current = planNodes.length
  }, [planNodes, setNodes, setEdges, fitView])
  const handleNodeClick = useCallback((_: unknown, node: Node<PlanDAGNodeData>) => {
    onNodeClick?.(node.data.node, node.data.index)
  }, [onNodeClick])

  if (planNodes.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <span className="text-[11px] text-muted-foreground/40">
          {isGenerating ? '等待节点生成...' : '暂无规划节点'}
        </span>
      </div>
    )
  }

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onNodeClick={handleNodeClick}
      nodeTypes={nodeTypes}
      fitView
      fitViewOptions={{ padding: 0.2 }}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={!isGenerating}
      panOnDrag
      zoomOnScroll
      minZoom={0.3}
      maxZoom={1.5}
      proOptions={{ hideAttribution: true }}
    >
      <Background gap={20} size={1} color="var(--color-muted-foreground)" style={{ opacity: 0.06 }} />
      <Controls showInteractive={false} className="!shadow-none !border-border/20 !bg-card/80 !rounded-lg" />
    </ReactFlow>
  )
}

export default function PlanDAGView(props: PlanDAGViewProps) {
  return (
    <ReactFlowProvider>
      <PlanDAGViewInner {...props} />
    </ReactFlowProvider>
  )
}