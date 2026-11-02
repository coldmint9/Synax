---
name: code-review
description: Review code changes for bugs, regressions, missing tests, and unclear behavior.
version: 1.1.0
synax:
  applies-to: [reviewer, executor]
  permission-hints: [none]
---

# Code Review

Review the change against its intent and the code it touches. Findings are the product; editing the code is out of scope unless the user asks for it.

## Scope first

- Establish what changed and why: diff, status, related tests and the acceptance criteria.
- Read the callers and the closest existing implementation of the same behavior before judging the change.
- Note generated files, formatting noise and unrelated edits so they do not hide the real change.

## What to look for

1. **Correctness** — wrong assumptions, empty and error paths, off-by-one, async ordering, retries, idempotency.
2. **Regressions** — existing behavior the change silently alters, contract or schema changes, migrations.
3. **Security and permissions** — trust boundaries, injection, path traversal, secret exposure, authorization checks.
4. **Data** — consistency, transactions, concurrency, serialization and versioning.
5. **Tests** — behavior that changed without a test that would fail on regression.
6. **Maintainability** — only when it obscures correctness or makes the next change risky.

## Reporting

- Order by severity: P0 blocking, P1 should fix, P2 suggestion.
- Each finding: file and line, trigger condition, impact, smallest fix direction.
- Separate confirmed issues from assumptions, and state what evidence would confirm an assumption.
- Say which checks were run and which were not.
- Do not restate the diff; the reader can read it.

## Output

Summary, Findings, Test gaps, Residual risks, Suggested next steps.
