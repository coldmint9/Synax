---
name: batch-mr-orchestration
description: Review cumulative source ordering and batch blockers.
version: 1.0.0
synax:
  applies-to: [executor]
  profile-ids: [git-manager]
  injection: on-demand
  required-capabilities: [git.mr.inspect, git.history.compare]
  permission-hints: [none]
---

# batch-mr-orchestration

Read the persisted ordered steps and frozen OIDs. Distinguish duplicate or already-contained sources from unprocessed sources using server step status. Suggest dependency-aware order, explaining evidence and uncertainty. A clean independent preflight does not prove a cumulative merge will succeed. Stop recommendations at unresolved conflicts; describe how later sources can depend on earlier resolutions. Do not reorder or prepare the MR from this suggestion session. Report pending steps and request an explicit human plan change when needed.
