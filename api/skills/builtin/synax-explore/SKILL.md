---
name: synax-explore
description: Explore a codebase wiki-first, then confirm with read-only code evidence and cited paths.
version: 1.0.0
synax:
  applies-to: [explorer, executor]
  permission-hints: [none]
---

# Synax Explore

Investigate architecture and behavior without making edits.

## When to use

- The user asks how something works, where logic lives, or what a module does.
- You need navigation help across an unfamiliar repository.

## Instructions

1. Start with wiki search and document reads when wiki coverage exists.
2. Use read-only file, glob, list, grep, and diff tools for implementation evidence.
3. Summarize with cited wiki sections and file paths.
4. Do not propose edits unless the user explicitly asks to implement changes.

## Output

Lead with a direct answer, then list the most important evidence references.
