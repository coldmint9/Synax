import { GitBranch, ListChecks } from 'lucide-react'

export default function PlanView({ projectId }: { projectId: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
      <div className="rounded-2xl border border-border/40 bg-card/60 backdrop-blur-xl p-8 max-w-sm w-full shadow-[0_2px_8px_rgba(0,0,0,0.04)]">
        <ListChecks size={32} className="mx-auto mb-3 text-muted-foreground/30" />
        <h2 className="text-sm font-semibold text-foreground/80">规划视图</h2>
        <p className="mt-2 text-[12px] text-muted-foreground/60 leading-relaxed">
          在文档视图中对 Wiki Block 添加评价，
          <br />
          然后在此处生成行动规划。
        </p>
        <div className="mt-4 flex flex-col gap-2 text-left text-[11px] text-muted-foreground/50">
          <div className="flex items-center gap-2 rounded-lg bg-foreground/[0.02] px-3 py-2">
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/10 text-[10px] font-bold text-primary">1</span>
            <span>在文档视图中评价 Block</span>
          </div>
          <div className="flex items-center gap-2 rounded-lg bg-foreground/[0.02] px-3 py-2">
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/10 text-[10px] font-bold text-primary">2</span>
            <span>点击「生成规划」按钮</span>
          </div>
          <div className="flex items-center gap-2 rounded-lg bg-foreground/[0.02] px-3 py-2">
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/10 text-[10px] font-bold text-primary">3</span>
            <span>确认后执行，Review 闭环</span>
          </div>
        </div>
      </div>
    </div>
  )
}
