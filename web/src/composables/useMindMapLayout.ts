import type { CoordEdge, CoordForest, CoordNodePositions } from '../lib/coordinates'

export interface MindMapNodePosition {
  id: string
  x: number
  y: number
  depth: number
}

export interface MindMapEdgePath {
  id: string
  source: string
  target: string
  d: string
  strength: number
  type: CoordEdge['type']
  /** Endpoint anchors in world space (for handles / hit testing). */
  sx: number
  sy: number
  tx: number
  ty: number
}

export interface MindMapLayoutResult {
  nodePositions: MindMapNodePosition[]
  edgePaths: MindMapEdgePath[]
  bounds: { width: number; height: number }
}

// ── Layout Constants ──
const NODE_W = 280
const NODE_H = 92
const X_STRIDE = 360
const SIBLING_GAP = 28
const BAND_GAP = 80
const OFFSET_X = 80
const OFFSET_Y = 80

// ── Helpers ──
function nodeCenterX(x: number) { return x + NODE_W / 2 }
function nodeCenterY(y: number) { return y + NODE_H / 2 }

/**
 * Feature-Clustered 树布局
 *
 * 每个 feature 子树占据独立垂直"泳道"，feature 之间留 BAND_GAP 间隙
 * 作为跨边路由通道。父节点垂直居中于子节点之上，层次边（hierarchy）使用
 * 贝塞尔曲线，跨边（dependency/related）使用阶梯路径。
 */
export function computeMindMapLayout(
  forest: CoordForest,
  preferredPositions: CoordNodePositions = {},
): MindMapLayoutResult {
  const root = forest.nodes[forest.rootId]
  if (!root) {
    return { nodePositions: [], edgePaths: [], bounds: { width: 0, height: 0 } }
  }

  // ── Phase 1: 递归计算每棵子树的高度 ──
  const heightCache = new Map<string, number>()

  function subtreeHeight(id: string): number {
    const cached = heightCache.get(id)
    if (cached !== undefined) return cached
    const node = forest.nodes[id]
    if (!node || node.children.length === 0) {
      heightCache.set(id, NODE_H)
      return NODE_H
    }
    let total = 0
    for (let i = 0; i < node.children.length; i++) {
      if (i > 0) total += SIBLING_GAP
      total += subtreeHeight(node.children[i])
    }
    heightCache.set(id, total)
    return total
  }

  // ── Phase 2: 递归放置子树（先子后父，父居中） ──
  interface Pos {
    x: number
    y: number
    depth: number
  }
  const posMap = new Map<string, Pos>()
  const positions: MindMapNodePosition[] = []

  function placeSubtree(id: string, depth: number, yStart: number): void {
    const node = forest.nodes[id]
    if (!node) return
    const x = OFFSET_X + depth * X_STRIDE

    if (node.children.length === 0) {
      // 叶子节点 — 直接放置在指定 Y
      posMap.set(id, { x, y: yStart, depth })
      positions.push({ id, x, y: yStart, depth })
      return
    }

    // 先放置所有子节点
    let childY = yStart
    for (let i = 0; i < node.children.length; i++) {
      const childId = node.children[i]
      placeSubtree(childId, depth + 1, childY)
      if (i < node.children.length - 1) {
        childY += subtreeHeight(childId) + SIBLING_GAP
      } else {
        childY += subtreeHeight(childId)
      }
    }

    // 父节点垂直居中于子节点
    const firstChild = posMap.get(node.children[0])!
    const lastChild = posMap.get(node.children[node.children.length - 1])!
    const parentCenter = (nodeCenterY(firstChild.y) + nodeCenterY(lastChild.y)) / 2
    const parentY = parentCenter - NODE_H / 2

    posMap.set(id, { x, y: parentY, depth })
    positions.push({ id, x, y: parentY, depth })
  }

  // 放置 root 节点
  posMap.set(root.id, { x: OFFSET_X, y: OFFSET_Y, depth: 0 })
  positions.push({ id: root.id, x: OFFSET_X, y: OFFSET_Y, depth: 0 })

  // ── Phase 3: Feature Bands — 每个 feature 子树占据独立垂直区域 ──
  if (root.children.length > 0) {
    // 首先丢弃 root 初始位置（后续会被居中覆盖）
    let currentBandY = OFFSET_Y

    for (const featureId of root.children) {
      placeSubtree(featureId, 1, currentBandY)
      currentBandY += subtreeHeight(featureId) + BAND_GAP
    }

    // root 垂直居中于 feature 节点
    const firstFeature = posMap.get(root.children[0])!
    const lastFeature = posMap.get(root.children[root.children.length - 1])!
    const rootCenter = (nodeCenterY(firstFeature.y) + nodeCenterY(lastFeature.y)) / 2
    const rootY = rootCenter - NODE_H / 2

    const rootPos = posMap.get(root.id)!
    rootPos.y = rootY
    const rootIdx = positions.findIndex(p => p.id === root.id)
    if (rootIdx !== -1) positions[rootIdx].y = rootY
  }

  // ── 应用 preferredPositions 覆盖 ──
  for (const pos of positions) {
    const pinned = preferredPositions[pos.id]
    if (pinned) {
      pos.x = pinned.x
      pos.y = pinned.y
    }
  }

  // ── 构建 edgePaths（路径由 React Flow 在渲染时计算） ──
  const edgePaths: MindMapEdgePath[] = forest.edges
    .filter(edge => posMap.has(edge.source) && posMap.has(edge.target))
    .map(edge => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      strength: edge.strength,
      type: edge.type,
      d: '',
      sx: 0,
      sy: 0,
      tx: 0,
      ty: 0,
    }))

  // ── 计算画布范围 ──
  const width = Math.max(1400, ...positions.map(n => n.x + NODE_W + 120))
  const height = Math.max(900, ...positions.map(n => n.y + NODE_H + 100))
  return { nodePositions: positions, edgePaths, bounds: { width, height } }
}
