import type { PlanSprint, PlanTask } from '../contracts/plan'

export interface PlanApi {
  getTasks(): Promise<PlanTask[]>
  getSprints(): Promise<PlanSprint[]>
}

export const planApi: PlanApi = {
  async getTasks() {
    return []
  },
  async getSprints() {
    return []
  },
}
