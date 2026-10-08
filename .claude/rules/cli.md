---
paths:
  - "src/cli/**"
---

# CLI rules

Screens follow IMPL §2. Check the matching mock-up before changing a screen.

- Every screen starts with the stage, the position in the workflow and the session ID.
- `q` (save and quit) works on every prompt.
- Status is never shown by colour alone. Respect `NO_COLOR`, and keep output readable at 80 columns.
- The write confirmation defaults to No. There is no `--yes` and no non-interactive approval.
- Bulk acceptance never includes `revise` or `remove` recommendations.
- Interactive commands exit without changes when stdin is not a TTY.
- No stack traces unless `--debug` is set.
- The CLI never runs git commands that change a repository.
