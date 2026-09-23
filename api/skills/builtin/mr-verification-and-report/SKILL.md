---
name: mr-verification-and-report
description: Report actual MR checks and publication evidence.
version: 1.0.0
synax:
  applies-to: [executor]
  profile-ids: [git-manager]
  injection: on-demand
  required-capabilities: [git.mr.inspect]
  permission-hints: [none]
---

# mr-verification-and-report

Inspect the latest service state. List each configured check as passed, failed or not run and quote the recorded candidate tree fingerprint. Treat results for a different candidate tree as stale. This session cannot run commands or checks; direct the user to the MR service controls for configured checks. Report actual target/source OIDs, candidate OID, included/skipped/pending steps, unresolved files and proposal IDs. Only call a merge complete when the service records merged/noop; never claim target publication based on a proposed patch.
