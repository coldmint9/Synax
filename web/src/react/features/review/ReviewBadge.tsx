import { AlertTriangle, CheckCircle2, Clock3 } from 'lucide-react'
import type { NodeReviewState } from '../../../lib/coordinates'

export function ReviewBadge({ review }: { review?: NodeReviewState }) {
  if (!review) return null
  const verdict = review.verdict
  const accepted = verdict === 'accepted' || verdict === 'accept'
  const rejected = verdict === 'rejected' || verdict === 'reject'
  const cls = accepted
    ? 'border-success/30 bg-success/10 text-success'
    : rejected
      ? 'border-destructive/30 bg-destructive/10 text-destructive'
      : 'border-warning/30 bg-warning/10 text-warning'
  const Icon = accepted ? CheckCircle2 : rejected ? AlertTriangle : Clock3
  return (
    <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium ${cls}`}>
      <Icon size={10} />
      {verdict ?? review.status}
      {typeof review.confidence === 'number' && (
        <span className="opacity-70">{Math.round(review.confidence * 100)}%</span>
      )}
    </span>
  )
}
