import { useEffect, useId, useRef } from 'react'
import { Check, ChevronDown, CircleAlert, GitMerge, GitCommitHorizontal } from 'lucide-react'
import './git-graph.css'

const commits = [
  { id: 'merge', lane: 'main', title: '合并 feature/session-refresh 到 main', hash: 'a8d43f1', detail: '两个分支会汇合到这次合并提交。冲突确认和测试通过后，才会创建这个节点。' },
  { id: 'main-auth', lane: 'main', title: '轮换会话签名密钥', hash: '5be27d1', branch: 'main', conflict: 'auth', detail: 'main 更新了签名密钥轮换逻辑，触及 auth.ts 中的会话刷新入口。组合方案会同时保留过期刷新和密钥轮换。' },
  { id: 'feature-auth', lane: 'feature', title: '刷新即将过期的会话', hash: 'c70a92e', branch: 'feature/session-refresh', detail: '当前 feature 分支增加了过期会话的自动刷新。在 auth.ts 中与 main 的密钥轮换逻辑合并。' },
  { id: 'main-middleware', lane: 'main', title: '修复未登录请求的重定向', hash: 'd3f9a1c', conflict: 'middleware', detail: 'main 为未登录请求增加了登录重定向，需要与 middleware.ts 中的公共资源缓存策略共同生效。' },
  { id: 'feature-tests', lane: 'feature', title: '增加会话边界测试', hash: '81bc2a4', detail: '为过期 token、轮换密钥和未登录跳转补充测试。解决冲突后，会运行完整的 42 个测试场景。' },
  { id: 'analytics', lane: 'other', title: '记录结账流程事件', hash: 'e6c15b2', branch: 'feature/analytics', detail: '另一个开发分支的独立提交。本次合并保持它原来的分支关系。' },
  { id: 'base', lane: 'main', title: '共同祖先 · 更新基础依赖', hash: '9c24df0', detail: 'main、feature/session-refresh 和 feature/analytics 从这次提交之后开始分叉。' },
]

const rowHeight = 34
const graphHeight = rowHeight * commits.length
const lanes = { main: 19, feature: 41, other: 63 }
const point = (index, lane) => ({ x: lanes[lane], y: index * rowHeight + rowHeight / 2 })

function GraphCanvas({ stage }) {
  const canvasRef = useRef(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const context = canvas.getContext('2d')
    if (!context) return
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
    let frame = 0
    let start = performance.now()
    const animated = stage === 'merging' || stage === 'merged'

    function draw(now = performance.now()) {
      const scale = window.devicePixelRatio || 1
      if (canvas.width !== 80 * scale || canvas.height !== graphHeight * scale) {
        canvas.width = 80 * scale
        canvas.height = graphHeight * scale
      }
      context.setTransform(scale, 0, 0, scale, 0, 0)
      context.clearRect(0, 0, 80, graphHeight)
      const style = getComputedStyle(canvas)
      const color = (name, fallback) => style.getPropertyValue(name).trim() || fallback
      const palette = {
        main: color('--blue', '#657797'),
        feature: color('--accent', '#66806c'),
        other: color('--muted', '#8a8e94'),
        surface: color('--surface', '#ffffff'),
        amber: color('--amber', '#a97a35'),
      }
      const progress = reducedMotion.matches ? 1 : Math.min((now - start) / 850, 1)
      const merged = stage === 'merged'
      const mergeActive = stage === 'merging' || merged

      function path(points, stroke, { dashed = false, alpha = 1 } = {}) {
        context.beginPath()
        context.moveTo(points[0], points[1])
        if (points.length === 4) context.lineTo(points[2], points[3])
        else context.bezierCurveTo(...points.slice(2))
        context.lineWidth = 1.7
        context.strokeStyle = stroke
        context.globalAlpha = alpha
        context.setLineDash(dashed ? [3, 4] : [])
        context.stroke()
        context.setLineDash([])
        context.globalAlpha = 1
      }

      // Edges connect actual commit coordinates, oldest at the bottom.
      path([19, 221, 19, 51], palette.main, { alpha: 0.7 })
      path([19, 221, 41, 221, 41, 204, 41, 187], palette.feature, { alpha: 0.8 })
      path([41, 187, 41, 85], palette.feature, { alpha: 0.8 })
      path([19, 221, 63, 221, 63, 208, 63, 187], palette.other, { alpha: 0.5 })
      path([19, 51, 19, 17], palette.main, { dashed: !merged, alpha: mergeActive ? 0.9 : 0.38 })
      path([41, 85, 41, 52, 19, 49, 19, 17], palette.feature, { dashed: !merged, alpha: mergeActive ? 0.9 : 0.4 })

      if (mergeActive && progress < 1) {
        // Move a small tracer toward the merge node; the graph never reflows.
        const t = progress
        const u = 1 - t
        const x = u * u * u * 41 + 3 * u * u * t * 41 + 3 * u * t * t * 19 + t * t * t * 19
        const y = u * u * u * 85 + 3 * u * u * t * 52 + 3 * u * t * t * 49 + t * t * t * 17
        context.beginPath()
        context.arc(x, y, 3, 0, Math.PI * 2)
        context.fillStyle = palette.feature
        context.fill()
      }

      commits.forEach((commit, index) => {
        const p = point(index, commit.lane)
        const pending = index === 0 && !merged
        context.beginPath()
        context.arc(p.x, p.y, index === 0 ? 4.5 : 3.25, 0, Math.PI * 2)
        context.fillStyle = pending ? palette.surface : palette[commit.lane]
        context.strokeStyle = index === 0 && stage === 'conflict' ? palette.amber : palette[commit.lane]
        context.lineWidth = pending ? 1.5 : 1
        context.fill()
        context.stroke()
      })

      if (merged && progress < 1) {
        context.beginPath()
        context.arc(19, 17, 5 + progress * 7, 0, Math.PI * 2)
        context.strokeStyle = palette.feature
        context.globalAlpha = (1 - progress) * 0.6
        context.lineWidth = 1.5
        context.stroke()
        context.globalAlpha = 1
      }
      if (animated && progress < 1) frame = requestAnimationFrame(draw)
    }

    const redraw = () => {
      cancelAnimationFrame(frame)
      start = performance.now()
      draw()
    }
    const observer = new MutationObserver(redraw)
    for (let element = canvas.parentElement; element; element = element.parentElement) {
      observer.observe(element, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] })
    }
    reducedMotion.addEventListener('change', redraw)
    draw()
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      reducedMotion.removeEventListener('change', redraw)
    }
  }, [stage])

  return <canvas className="graph-canvas" ref={canvasRef} width="80" height={graphHeight} aria-hidden="true" />
}

export default function GitGraph({ stage = 'conflict', confirmedCount = 0, onConflictClick, selectedCommit, onSelectCommit }) {
  const detailId = useId()
  const selected = commits.find((commit) => commit.id === selectedCommit)
  const conflictsResolved = confirmedCount >= 2 || ['testing', 'ready', 'merging', 'merged', 'failed'].includes(stage)
  const pendingLabel = stage === 'merging' ? '正在合并' : stage === 'ready' ? '等待合并' : stage === 'stale' ? '需要重算' : '待创建'

  return (
    <section className={`graph-root graph-stage-${stage}`} aria-label="分支提交图：main 与会话刷新分支将在顶部汇合，底部是共同祖先">
      <div className="graph-commits">
        <GraphCanvas stage={stage} />
        <ol className="graph-rows" aria-label="从最新到最早的提交记录">
          {commits.map((commit, index) => {
            const isSelected = selectedCommit === commit.id
            return (
              <li className={`graph-row${isSelected ? ' graph-row-selected' : ''}${index === 0 ? ' graph-merge-row' : ''}`} key={commit.id}>
                <button
                  className="graph-summary"
                  type="button"
                  onClick={() => onSelectCommit?.(isSelected ? null : commit.id)}
                  aria-expanded={isSelected}
                  aria-controls={isSelected ? detailId : undefined}
                  title={commit.title}
                >
                  <span className="graph-commit-title">{commit.title}</span>
                  {commit.branch && <span className={`graph-branch graph-branch-${commit.lane}`}>{commit.branch}</span>}
                  <ChevronDown className="graph-row-chevron" size={12} aria-hidden="true" />
                </button>
                {commit.conflict && stage === 'conflict' && !conflictsResolved ? (
                  <button type="button" className="graph-conflict" onClick={() => onConflictClick?.(commit.conflict)} aria-label={`查看 ${commit.conflict === 'auth' ? 'auth.ts' : 'middleware.ts'} 冲突`}>
                    <CircleAlert size={11} aria-hidden="true" /> {confirmedCount > 0 ? '差异' : '冲突'}
                  </button>
                ) : commit.conflict && conflictsResolved ? (
                  <span className="graph-resolved" title="冲突方案已确认"><Check size={12} aria-hidden="true" /><span className="graph-sr-only">已解决</span></span>
                ) : null}
                <span className={`graph-hash${index === 0 && stage !== 'merged' ? ' graph-pending' : ''}`}>{index === 0 && stage !== 'merged' ? pendingLabel : commit.hash}</span>
              </li>
            )
          })}
        </ol>
      </div>
      {selected && (
        <div className="graph-detail" id={detailId}>
          {selected.id === 'merge' ? <GitMerge size={14} aria-hidden="true" /> : <GitCommitHorizontal size={14} aria-hidden="true" />}
          <p>{selected.id === 'merge' && stage === 'merged' ? '两个分支已汇合，42 个测试通过。本次演示已生成合并节点，完整决策保留在当前对话里。' : selected.detail}</p>
          {selected.conflict && stage === 'conflict' && <button className="graph-detail-action" type="button" onClick={() => onConflictClick?.(selected.conflict)}>查看方案</button>}
        </div>
      )}
      <p className="graph-caption">{stage === 'merged' ? '分支已汇合，历史仍在这里。' : '每一步都在这棵提交树里继续。'}<span>点击提交查看详情</span></p>
    </section>
  )
}
