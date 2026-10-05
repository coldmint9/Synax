---
name: mr-recovery
description: Explain recoverable MR states without rewriting history.
version: 1.0.0
synax:
  applies-to: [executor]
  profile-ids: [git-manager]
  injection: on-demand
  required-capabilities: [git.mr.inspect]
  permission-hints: [none]
---

# mr-recovery

Read persisted status, version, current step and events. Separate verified service state from unknown Git/index/ref state; ask the user to invoke the MR service recovery controls when that evidence is missing. Explain available refresh, human resolution, retry or cancel options without performing them. After an uncertain write, inspect first and avoid duplicate actions. When the service confirms the target was already updated, propose a new revert MR if reversal is requested; never rewrite target history or suggest reset --hard, clean or force push.
