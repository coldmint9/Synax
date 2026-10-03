-- Older run status updates moved the locator past already captured replies.
-- A step proves that its parent run existed by that sequence. Recover only
-- same-session, same-epoch evidence; never make discarded branch steps visible.
-- This repairs existing checkpoints without changing their immutable roots.
UPDATE conversation_v3_runtime_records AS run
SET sequence = MIN(sequence, COALESCE((
  SELECT MIN(locator.sequence)
  FROM agent_runtime_run_steps AS step
  JOIN conversation_v3_runtime_records AS locator
    ON locator.session_id = step.session_id
    AND locator.kind = 'steps'
    AND locator.record_id = step.id
    AND locator.epoch = run.epoch
  WHERE step.session_id = run.session_id
    AND step.run_id = run.record_id
), sequence))
WHERE kind = 'runs'
  AND session_id IN (
    SELECT session_id FROM conversation_v3_heads WHERE boundary_only = 1
  );
