import type {
  DispatchIntentInput,
  DispatchIntentResult,
} from './contracts'
import { getAdapter } from './registry'

export async function dispatchIntent(input: DispatchIntentInput): Promise<DispatchIntentResult> {
  return getAdapter(input.providerId).dispatchIntent(input)
}
