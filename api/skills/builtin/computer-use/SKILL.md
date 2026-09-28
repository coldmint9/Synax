---
name: computer-use
description: Control the current desktop with Cua Driver only after confirming the user has authorized this task.
version: 1.0.0
synax:
  applies-to: [executor]
  permission-hints: [mcp]
---

# Computer Use

Cua controls the user's actual desktop, including signed-in applications and sensitive information. The built-in browser.* tools instead manage Synax's isolated Chromium. Use browser.* for ordinary web application testing, and Cua only when the user asks for their actual desktop, native apps, system dialogs, or signed-in browser.

1. Observe first: list apps and windows, then get a fresh window state or accessibility tree. Never guess a window identifier or coordinate.
2. Prefer fresh semantic elements and snapshot-bound tokens. Use pixels only when the semantic path cannot address the target. Do not invent `capture_id` or `element_token` values.
3. Use `delivery_mode: "background"` unless the user has approved foreground interaction; an unavailable background action is not permission to change modes automatically.
4. Perform one consequential action at a time. Reobserve after window changes, page navigation, and actions; verify the user's desired postcondition before claiming success.
5. A timeout or lost response may mean the action already happened. Never repeat click, typing, submit, launch, kill, or clipboard write without reobserving and user approval when appropriate.
6. Avoid unnecessary full-screen captures, clipboard reads, secrets, and account data. Do not copy desktop content into logs or unrelated tools.
7. If the driver is unavailable, permissions are missing, or a target is ambiguous, stop and explain the specific blocker rather than using shell commands to bypass restrictions.
