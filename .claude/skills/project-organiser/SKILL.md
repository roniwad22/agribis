---
name: "Project Organiser"
description: "Audits your project's file structure against its actual architecture and workflow, then reorganizes so the codebase reflects how the system works. Detects root clutter, monolith files, dead weight, convention drift, and misplaced files. Safe: branches first, commits in stages, rolls back on failure. Use whenever the user says 'organize my project', 'clean up the codebase', 'fix the file structure', 'this project is a mess', 'where should this go', or when you notice structural debt."
---

# Project Organiser

Audit a project's file structure against its actual architecture, then reorganize so the codebase reflects how the system works — not how it accidentally grew.

## Before Starting: Safety Check

Run before any analysis:

```
Bash: git status (any uncommitted changes?)
Bash: git branch --show-current (what branch are we on?)
```

**If there are uncommitted changes**: Tell the user. Offer to stash or commit first. Don't reorganize on top of unsaved work.

**If on main/master**: Create a reorganization branch first:
```bash
git checkout -b refactor/project-reorganisation
```

**If a feature freeze is active** (check MEMORY.md): Warn the user that reorganizing during a freeze will cause merge conflicts for active branches. Recommend waiting or limiting to root cleanup only.

## Step 1: Full Project Scan

Run in parallel:

```
Glob: **/* (everything)
Read: CLAUDE.md, MEMORY.md, .gitignore
Read: package.json / pubspec.yaml / Cargo.toml / requirements.txt
Bash: git log --oneline -30
```

Then **read the key source files** — entry points, routers, core modules. Understand the architecture, not just where files sit.

## Step 2: Diagnosis

Produce a **Project Health Report**. Be specific — name every file, show counts.

### 2a. Root Clutter

| File | What it is | Action |
|------|-----------|--------|
| `console.log('` | Shell fragment | `DELETE` |
| `sum` | Unknown artifact | `INVESTIGATE` — ask user |
| `ledger.json.migrated` | Migration output | `MOVE` to data/ or `DELETE` if consumed |

Root should contain ONLY: manifest, config, README/CLAUDE.md, entry points.

### 2b. Structural Alignment

Map the architecture to the directory tree:

```
ARCHITECTURE                    CURRENT STRUCTURE          MATCH?
API layer (routes, handlers)    src/api.js (1 file)        MONOLITH
App core (business logic)       src/app.js (1 file)        MONOLITH
Frontend (UI)                   public/*.html              OK
Tests                           tests/*.test.js            OK
Data (seeds, migrations)        *.migrated in root         MISPLACED
```

### 2c. Complexity Hotspots

For each source file:

```
FILE              LINES   EXPORTS   IMPORTED BY   IMPORTS FROM   VERDICT
src/api.js        1200    45        3             12             SPLIT
src/app.js        800     30        2             8              SPLIT
```

Thresholds: >500 lines = too big, >10 exports = too many responsibilities, imported by everything = god-object.

### 2d. Dead Weight

- Files not imported by anything (and not entry points)
- Dependencies in manifest not used anywhere
- Generated/temp files committed by accident
- Duplicate logic across files

### 2e. Convention Drift

- Mixed naming conventions in filenames
- Mixed module systems (require vs import)
- Inconsistent test naming (*.test.js vs *.spec.js)

## Step 3: Present the Plan

**Do not move files until the user approves.**

> ## Project Reorganisation Plan
>
> ### Critical (blocks development)
> - [action] — [why]
>
> ### Structural (improves maintainability)
> - [action] — [why]
>
> ### Cleanup (nice to have)
> - [action] — [why]
>
> ### Proposed Structure
> ```
> [tree diagram tailored to THIS project's domain and stack]
> ```
>
> **Touches [N] files. I'll work on branch `refactor/project-reorganisation` and commit in stages so any step can be rolled back. Proceed?**

The proposed structure must match the project's domain, not a generic template.

**Workflow-aligned structures by project type:**
- **Web/API**: `routes/` → `middleware/` → `services/` → `models/` → database
- **CLI**: `commands/` → `core/` → `utils/`
- **Mobile**: `screens/` → `widgets/` → `services/` → `models/`
- **Pipeline**: `ingest/` → `transform/` → `validate/` → `output/`

## Step 4: Execute (in stages)

Reorganize in this order, **committing after each stage** so any step can be reverted independently:

### Stage 1: Clean junk → commit
Delete obvious artifacts (shell fragments, temp files, accidental files). Commit:
```bash
git add -A && git commit -m "chore: remove accidental files from root"
```

### Stage 2: Create structure → commit
Create new directories. Commit.

### Stage 3: Move files → commit per batch
Move files in logical batches (all route files together, all model files together). After EACH batch:

1. **Update all references** — search broadly:
   ```
   Grep: "old/path" in **/*.{js,ts,py,json,yml,yaml,toml,md,html}
   ```
   This catches: imports, requires, dynamic paths, config references, CI configs, Docker paths, PM2 configs, documentation links.

2. **Check for non-obvious references**:
   ```
   Grep: the filename (without path) in **/*.{json,yml,yaml,toml,env}
   ```
   Config files often reference filenames without full paths.

3. **Commit the batch**:
   ```bash
   git add -A && git commit -m "refactor: move [what] to [where]"
   ```

### Stage 4: Run tests
```bash
npm test (or equivalent)
```
If tests fail: diagnose, fix the broken reference, commit the fix. If unfixable: revert the last batch with `git revert HEAD`.

### Stage 5: Update project config
Update any paths in: package.json scripts, Dockerfile, docker-compose, CI configs, ecosystem.config.js, railway.toml. Commit.

## Step 5: Post-Reorganisation

> ## Done
>
> **Branch**: `refactor/project-reorganisation` ([N] commits)
> **Moved**: [N] files | **Deleted**: [N] | **Created**: [N] dirs | **Updated**: [N] references
>
> **Before → After**: [side-by-side structure sketch]
>
> Tests: [PASS/FAIL]
> Ready to merge when you've reviewed the branch.

## How to Split a Monolith File

Identifying domains in an unfamiliar codebase:

1. **Read the entire file** — list every function/export
2. **Find the domain clusters** — look for these signals:
   - Functions that call each other form a cluster
   - Functions that share the same parameters/data types belong together
   - Route handlers grouped by URL prefix (`/users/*`, `/orders/*`, `/payments/*`) are domain boundaries
   - Database table names in queries indicate domain boundaries
3. **Name the domains** — each cluster gets a name matching the business concept (users, orders, payments — not helpers, utils, misc)
4. **Extract** — one file per domain, in the appropriate directory
5. **Shared utilities** — functions used across 3+ domains go to a shared utils file. Functions used by only 2 domains stay in the more relevant one and get imported.
6. **Backward compat** — if the monolith was heavily imported, create a temporary index that re-exports from new files. Delete it once all imports are updated.

## Rules

1. **Safety first.** Branch before reorganizing. Commit in stages. Never reorganize on uncommitted work.
2. **Diagnose before prescribe.** Read the full project before suggesting changes.
3. **Get approval before moving.** A wrong reorganization is worse than a messy one.
4. **Update ALL references after every move.** Search broadly — imports, configs, CI, Docker, docs, scripts.
5. **Run tests after reorganizing.** If tests fail, fix or revert before continuing.
6. **Match the domain, not a template.** Structure reflects this project's architecture.
7. **Split by domain, not by type.** Group by what code does (users, payments), not what it is (controllers, models).
8. **Preserve git history.** Use `git mv` so file history is tracked.
9. **Delete with confidence.** Junk gets deleted, not shuffled to a "misc" folder.
10. **Structure and content are separate commits.** Don't change code logic while moving files.

## Never

- Move files without updating references across the ENTIRE codebase (imports, configs, CI, Docker, docs)
- Create "misc", "other", or "legacy" folders — that's hiding mess
- Reorganize without a branch and staged commits
- Reorganize during a feature freeze without warning the user
- Split files into one-function-per-file
- Change code logic while reorganizing — separate commits
- Delete files that might be important without asking
- Ignore the project's existing naming conventions
