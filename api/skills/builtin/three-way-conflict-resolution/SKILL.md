---
name: three-way-conflict-resolution
description: Analyze three-way text conflicts and create reviewable proposals.
version: 1.0.0
synax:
  applies-to: [executor]
  profile-ids: [git-manager]
  injection: on-demand
  required-capabilities: [git.diff.read, git.resolution.propose]
  permission-hints: [none]
---

# three-way-conflict-resolution

Read the complete base, target, source and result for the selected file; bounded blob reads can supply missing ranges. Explain each side's intent and preserve independent changes. Use the smallest coherent resolution, checking imports, callers and invariants visible in the available evidence. Do not blindly choose ours/theirs. If evidence is insufficient or the conflict is binary/structural, return a human blocker. Submit content and rationale with the exact current revision via resolution.propose. Report the proposal ID and explicitly leave acceptance, application, and verification to the MR UI/service.
