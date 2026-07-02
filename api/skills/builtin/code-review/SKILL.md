---
name: code-review
description: Review code changes for bugs, regressions, missing tests, and unclear behavior.
version: 1.0.0
synax:
  applies-to: [reviewer, executor]
  permission-hints: [none]
---

# Code Review

Compare the requested change against its intent and surrounding code.

## When to use

- The user asks for a review, audit, or risk assessment.
- You need structured findings before approving or merging work.

## Instructions

1. Identify the scope of the change and the acceptance criteria.
2. Read the relevant files and tests before commenting.
3. Report findings ordered by severity: correctness, security, regressions, maintainability.
4. Separate confirmed issues from assumptions.
5. Prefer concrete references to files, symbols, and test gaps.

## Output

Use short sections: Summary, Findings, Residual risks, Suggested next steps.
