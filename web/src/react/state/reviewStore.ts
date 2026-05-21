import { create } from 'zustand'
import { startGoalReviewStream, type GoalReviewPackage, type GoalReviewStreamEvent } from '../../lib/api/review'
import type { CoordinatesContextIndex, CoordForest } from '../../lib/coordinates'

interface ReviewState {
  panelOpen: boolean
  activeGoalId: string | null
  activeRunId: string | null
  running: boolean
  error: string | null
  events: GoalReviewStreamEvent[]
  packagesById: Record<string, GoalReviewPackage>
  latestPackageByGoal: Record<string, string>
  abort: null | (() => void)
  openPanel: (goalId?: string) => void
  setPanelOpen: (open: boolean) => void
  closePanel: () => void
  startGoalReview: (input: {
    projectId: string
    goalId: string
    forest: CoordForest
    contextIndex?: CoordinatesContextIndex
    workDir?: string | null
    locale?: 'zh' | 'en'
    onCompleted?: (pkg: GoalReviewPackage) => void
    onFailed?: (reason: string) => void
  }) => Promise<void>
  discardPackage: (packageId: string) => void
  clearError: () => void
}

export const useReviewStore = create<ReviewState>((set, get) => ({
  panelOpen: false,
  activeGoalId: null,
  activeRunId: null,
  running: false,
  error: null,
  events: [],
  packagesById: {},
  latestPackageByGoal: {},
  abort: null,

  openPanel: (goalId) => set(s => ({ panelOpen: true, activeGoalId: goalId ?? s.activeGoalId })),
  setPanelOpen: (open) => set({ panelOpen: open }),
  closePanel: () => set({ panelOpen: false }),
  clearError: () => set({ error: null }),

  startGoalReview: async ({ projectId, goalId, forest, contextIndex, workDir, locale = 'zh', onCompleted, onFailed }) => {
    get().abort?.()
    set({
      panelOpen: true,
      activeGoalId: goalId,
      activeRunId: null,
      running: true,
      error: null,
      events: [],
      abort: null,
    })

    const abort = startGoalReviewStream(
      { projectId, goalId, forest, contextIndex, workDir, locale },
      (event) => {
        set(s => {
          const next: Partial<ReviewState> = { events: [...s.events, event] }
          if (event.type === 'review_started') {
            next.activeRunId = event.payload.run.id
          }
          if (event.type === 'review_completed') {
            const pkg = event.payload.package
            onCompleted?.(pkg)
            next.running = false
            next.activeRunId = pkg.run.id
            next.packagesById = { ...s.packagesById, [pkg.run.id]: pkg }
            next.latestPackageByGoal = { ...s.latestPackageByGoal, [pkg.run.goalId]: pkg.run.id }
            next.abort = null
          }
          if (event.type === 'review_failed') {
            onFailed?.(event.payload.reason)
            next.running = false
            next.error = event.payload.reason
            next.abort = null
          }
          return next as ReviewState
        })
      },
      (err) => {
        set({ running: false, error: err instanceof Error ? err.message : String(err), abort: null })
      },
    )
    set({ abort })
  },

  discardPackage: (packageId) => {
    set(s => {
      const pkg = s.packagesById[packageId]
      const packagesById = { ...s.packagesById }
      delete packagesById[packageId]
      const latestPackageByGoal = { ...s.latestPackageByGoal }
      if (pkg && latestPackageByGoal[pkg.run.goalId] === packageId) {
        delete latestPackageByGoal[pkg.run.goalId]
      }
      return { packagesById, latestPackageByGoal }
    })
  },
}))
