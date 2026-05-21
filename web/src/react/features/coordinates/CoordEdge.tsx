import { BaseEdge, EdgeLabelRenderer, getBezierPath, getSmoothStepPath, type EdgeProps } from '@xyflow/react'
import type { CoordEdge } from '../../../lib/coordinates'

/**
 * 边视觉层级设计（从弱到强）：
 *
 * hierarchy (灰色细实线) —— 树结构骨架
 *   语义：父子包含关系（project→feature→goal→action）
 *   样式：细 1.2px · 柔灰色 · Bezier 曲线
 *   地位：布局本身已暗示层级，线应淡化到背景层
 *
 * related (橙色实线) —— 跨域语义关联
 *   语义：逻辑相关但不强依赖
 *   样式：2px · 橙色 · Step 折线
 *   地位：重要但非关键路径
 *
 * dependency (蓝色动画虚线) —— 执行依赖
 *   语义：前置依赖，制约执行顺序
 *   样式：2.5px · 蓝色 · 动画虚线 · Step 折线
 *   地位：最关键的非结构关系，视觉最突出
 */

function colorForType(type: CoordEdge['type'], selected: boolean) {
  if (selected) return '#2970FF'
  if (type === 'hierarchy') return 'hsl(160 8% 62% / 0.5)'
  if (type === 'dependency') return 'hsl(210 80% 56% / 0.85)'
  return 'hsl(24 86% 52% / 0.75)'
}

function pathForType(
  type: CoordEdge['type'],
  props: EdgeProps,
): [path: string, labelX: number, labelY: number] {
  if (type === 'hierarchy') {
    const [path, labelX, labelY] = getBezierPath({
      sourceX: props.sourceX,
      sourceY: props.sourceY,
      targetX: props.targetX,
      targetY: props.targetY,
      curvature: 0.25,
    })
    return [path, labelX, labelY]
  }
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    targetX: props.targetX,
    targetY: props.targetY,
    borderRadius: 10,
  })
  return [path, labelX, labelY]
}

export default function CoordEdgeView(props: EdgeProps) {
  const edgeType = (props.data?.edgeType as CoordEdge['type']) ?? 'dependency'
  const stroke = colorForType(edgeType, !!props.selected)
  const [path, labelX, labelY] = pathForType(edgeType, props)

  const strokeWidth = props.selected ? 3 : edgeType === 'hierarchy' ? 1.2 : edgeType === 'dependency' ? 2.5 : 2

  return (
    <>
      <BaseEdge
        id={props.id}
        path={path}
        interactionWidth={16}
        style={{
          stroke,
          strokeWidth,
          strokeDasharray: edgeType === 'dependency' ? '4 4' : undefined,
          strokeLinecap: 'round',
          transition: 'stroke 120ms ease, stroke-width 120ms ease, opacity 120ms ease',
        }}
      />
      {props.selected && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan rounded-md border border-border/60 bg-background/90 px-2 py-1 text-[10px] shadow-sm backdrop-blur-sm"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              position: 'absolute',
              pointerEvents: 'all',
            }}
          >
            <span className="font-medium">{edgeType}</span>
            <span className="mx-1 text-muted-foreground/50">·</span>
            <span className="text-muted-foreground">drag to reconnect</span>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}
