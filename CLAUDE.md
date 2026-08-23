# drizzle-explain

`drizzle-explain` performance-tests Drizzle ORM queries by running them through `EXPLAIN ANALYZE` inside a transaction that is always rolled back, then asserting the plan is within tolerance. See [README.md](README.md) for the full design and API — it is the source of truth for behaviour.

## Before writing any code

Read [README.md](README.md) and [CONTRIBUTING.md](CONTRIBUTING.md) and follow the guidelines there. Conventions mirror [`drizzle-transact`](https://github.com/cressie176/drizzle-transact): very small named functions, no `else`/`switch`, composition over inheritance, encapsulate everything not part of the public API, intent-revealing names, no explanatory comments, and tests against a real database (no mocks).

## Working agreement (per issue)

When working an issue:

1. **Read the README first** — it is the contract. Implement to match it.
2. **Check the README after finishing the task.** If the implementation diverged from what the README describes, either fix the code to match, or update the README to reflect a deliberate, better decision — never leave them inconsistent. Record any divergence in the issue's Notes.
3. **Keep to the files the issue says it owns.** Each issue lists a **Parallelisation** block stating what it depends on, what it can safely run alongside, and which files it owns. Respect it so parallel worktrees don't collide. Not every issue can run in parallel — the issue says which.
4. **Update progress on the GitHub issue** as you go — tick the task/acceptance checkboxes and add a Notes entry for any implementation change.
5. **Commit when the task is done — don't let work pile up.** As soon as an issue (or a self-contained sub-task) is finished and its tests pass, make a single focused commit for it before starting the next one. Never batch several completed tasks into one large uncommitted heap; each logical change should land in its own commit so history stays reviewable and unrelated changes don't get entangled across shared files.
6. **Do not close the issue.** The maintainer (Steve) reviews and approves; close only after explicit approval.

## Parallel worktrees

Issues are worked in separate git worktrees so multiple agents can run at once, but only where the issue's Parallelisation block permits it. Dependencies gate the rest: project setup blocks everything; the plan-node contract blocks the core and drivers; and so on. Always check the issue before assuming it can run alongside another.

## Architecture

- **Database-independent core** — orchestration (`createExplain`/`explain`), the plan-tree walk, limit-merging, and the annotated-plan renderer. The core only ever sees the normalized `PlanNode` tree, never a vendor-specific plan key.
- **Drivers** (`drizzle-explain/postgres`, `drizzle-explain/mariadb`) — each runs its database's `EXPLAIN`, wraps execution in a rolled-back transaction, and translates the vendor plan into the normalized `PlanNode`. The raw vendor plan is preserved in `analysis.plan`.
- **Checks are applied only when the driver supplies the signal.** A driver that can't report cost means `maxCost` is silently skipped, not failed.
