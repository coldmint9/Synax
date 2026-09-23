---
name: local-mr-review
description: Review a frozen local MR and report grounded risks.
version: 1.0.0
synax:
  applies-to: [executor]
  profile-ids: [git-manager]
  injection: on-demand
  required-capabilities: [git.mr.inspect, git.history.compare, git.diff.read]
  permission-hints: [none]
---

# local-mr-review

Inspect the MR and its frozen target/source OIDs. Read history.compare and list files. Compare explicit base, target, source and result contents using diff.read; cite file IDs and revision with each finding. Explain likely change intent separately from verified service facts. Identify semantic conflicts and missing evidence, propose relevant checks for human configuration, and summarize included, skipped and pending sources. Never treat a clean textual merge as proof of semantic correctness.
