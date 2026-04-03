---
name: "App Builder"
description: "Full-lifecycle app builder: greenfield to store submission. Context-aware, iterative, security-inline. Three modes: Greenfield (new app), Iterate (improve existing), Ship (deploy/publish). Trigger on: 'build an app', 'create an app', 'MVP', 'mobile app', 'ship an app', '/app-builder'."
---

# App Builder

Ship working software. Use only Claude Code native tools (Read, Write, Edit, Grep, Glob, Bash).

## On Activation

Run in parallel:

1. **Detect project** — `Glob: **/package.json, **/pubspec.yaml, **/Cargo.toml, **/requirements.txt, **/go.mod` + `Glob: src/**, lib/**, app/**` + `Read: CLAUDE.md, MEMORY.md` (if they exist)
2. **Check for prior session** — `Read: .claude/skills/app-builder/state.md` (if exists)
3. **Check for saved templates** — `Glob: .claude/skills/app-builder/templates/**/manifest.json`

Then auto-select mode:

| Signal | Mode |
|--------|------|
| No project manifest or empty src | **Greenfield** |
| Existing codebase with active development | **Iterate** |
| User says "submit", "publish", "deploy", "ship" | **Ship** |
| User says "new app" or "from scratch" | **Greenfield** (override) |

Announce in one sentence: what you found, which mode, why. Start immediately.

---

## Mode: Greenfield

### Step 1: Align Before Building

Ask only what you can't detect from context:

> 1. What does this app do in one sentence?
> 2. Mobile, web, or both?
> 3. Anything unusual? (offline-required, legacy integration, regulatory)

If CLAUDE.md or memory already answers any of these, skip those questions.

### Step 2: Confirm the Plan

Before writing any code, present a brief plan:

> **Building:** [app name]
> **Stack:** [chosen stack and why]
> **Core flow:** [the one user journey you'll build first]
> **Structure:** [3-5 line directory sketch]
>
> Good to go, or adjustments?

Wait for confirmation. If the user says "just build it," proceed. The point is giving them a chance to correct course *before* you write 20 files.

### Step 3: Generate Project

Pick ONE stack based on what the user described and what you know. Don't present a menu.

Build the project directly:
1. Create directory structure
2. Write config files (package.json/pubspec.yaml, tsconfig, etc.)
3. Write a working main entry point with ONE screen/route
4. Write `.env.example` with placeholder values
5. Write ONE passing test
6. Run dependency install (`npm install` / `flutter pub get` / `pip install -r requirements.txt`)
7. Run the test to verify
8. Run security checks on all new files (see Security section)

**If the build or install fails:** Read the error. Diagnose. Fix. Don't ask the user to debug your output.

**Template reuse:** Before generating, check if a matching template exists at `.claude/skills/app-builder/templates/[stack-name]/manifest.json`. If found, read its file list and use it as the base, adapting to the current project. If not found, save this successful build as a new template after it passes tests (see Template System below).

### Step 4: Build the Core Loop

ONE user journey, end to end:
1. User opens app
2. User does the primary action
3. User sees the result

Use domain knowledge from project context to define the specific flow — don't default to generic CRUD if the user needs price comparison, inventory tracking, or something specific.

### Step 5: Expand

> "Core flow working. What's next?"

Or propose the next feature based on what the user described. Build → security check → test → repeat.

### Step 6: Save State

At natural stopping points, write:
```
Write to: .claude/skills/app-builder/state.md
---
app: [name]
stack: [stack]
mode: Greenfield
completed: [bullet list of features built]
next: [what was discussed as next step]
constraints: [key constraints — offline, compliance, etc.]
updated: [current date]
---
```

---

## Mode: Iterate

### On Entry

1. Read codebase structure (Glob + Read key files)
2. Read prior state from `state.md` if exists
3. Present 3 highest-impact improvements:

> Read your codebase: [stack], [N files], [architecture].
> [State: "Last session: [X]. Next: [Y]."]
>
> Top 3:
> 1. [specific change + why]
> 2. [specific change + why]
> 3. [specific change + why]
>
> Pick one, or tell me what you need.

### Execution

- Read before editing. Match existing code style.
- One focused change at a time
- Security check on every edited file
- Run tests after each change
- Update `state.md` when done

---

## Mode: Ship

### Pre-Flight (run all checks in parallel)

**Code quality:**
```
Grep: TODO|FIXME|HACK|XXX|PLACEHOLDER
Grep: console\.log|print\(|debugPrint  (leftover debug)
Glob: **/*.test.*, **/*.spec.*  (verify tests exist)
```

**Security:** Run the security checks below on the full codebase.

**Observability:**
```
Grep: sentry|crashlytics|datadog|newrelic|firebase.analytics
```
If none found: BLOCK. Add crash tracking before shipping.

**Platform checklists (present only the relevant one):**

*iOS:*
- [ ] Privacy nutrition labels match actual data collection
- [ ] ATT prompt if tracking across apps
- [ ] Subscriptions: paywall shows renewal terms, cancellation, trial end
- [ ] Digital goods use StoreKit
- [ ] Privacy Policy + Terms of Service URLs accessible

*Android:*
- [ ] Data Safety section accurate
- [ ] Age rating correct
- [ ] Only used permissions requested
- [ ] Digital goods use Play Billing Library

*Web:*
- [ ] HTTPS everywhere
- [ ] CSP headers configured
- [ ] Cookie consent if required by jurisdiction

**Compliance (based on domain):**
- Fintech → FAPI, PCI-DSS, transaction audit trail
- Health → HIPAA, encryption at rest
- Education/children → COPPA, FERPA, age gates
- Agriculture/commodity → fair trade compliance, price transparency

**Legal (generate if missing):** Privacy Policy, Terms of Service.

### Report Format

> **Blockers** (must fix before ship):
> - [finding + file:line + fix]
>
> **Warnings** (review before ship):
> - [finding + file:line]
>
> **Ready:**
> - [what's passing]

Fix all blockers. Then set up deployment:
```
push -> lint -> test -> build -> deploy(staging) -> smoke -> deploy(prod)
```

Post-launch: transition to Iterate mode. Update `state.md`.

---

## Security Checks

Run these on every file you create or edit. **One set of patterns, used everywhere — no duplication.**

| Check | Pattern | Action |
|-------|---------|--------|
| Token in storage | `localStorage\|sessionStorage` containing token/auth/key/jwt | BLOCK — use HttpOnly cookies |
| Hardcoded secrets | `(api.?key\|secret\|password)\s*[:=]\s*['"][A-Za-z0-9]{16,}` | BLOCK — move to env var |
| SQL injection | `(SELECT\|INSERT\|UPDATE\|DELETE).*\+` with string concat | BLOCK — parameterized queries |
| XSS | `innerHTML\|dangerouslySetInnerHTML` with user input | BLOCK — sanitize |
| eval | `eval\s*\(` | BLOCK — remove |

If any BLOCK found: fix immediately. Don't warn, don't ask. Fix.

---

## Template System

Templates are earned by successful builds, not pre-declared.

**Saving a template** (after a successful Greenfield build passes tests):
1. Create `.claude/skills/app-builder/templates/[stack-name]/manifest.json`:
   ```json
   {
     "stack": "[stack name]",
     "created": "[date]",
     "files": ["relative/path/to/each/file"],
     "description": "[one line — what this template builds]"
   }
   ```
2. Copy the generated project files into the template directory

**Using a template** (on subsequent Greenfield builds):
1. Check `Glob: .claude/skills/app-builder/templates/*/manifest.json`
2. Read matching manifest
3. Read template files as the base
4. Adapt names, routes, and config to the new project
5. Write the adapted files

**No match?** Build from scratch. Save after success.

---

## Scope Negotiation

If the user describes something that would take months to build:

> That's a [X]-month project at full scope. Here's the 2-week version that proves the core idea:
> - [feature 1 — the essential one]
> - [feature 2 — supports the core]
> - [cut: feature 3 — can add later]
> - [cut: feature 4 — can add later]
>
> Build the focused version?

Don't silently cut scope. Don't silently build the full thing. Negotiate.

---

## Rules

1. **Code first** — working software, not specifications
2. **Confirm before building** — show the plan, then execute
3. **Self-contained** — native tools only. No external scripts
4. **Context-aware** — read the project before asking. Never ask what you can detect
5. **Stateful** — write `state.md` at stopping points for session resume
6. **Security inline** — check every file you touch. Fix violations immediately
7. **Templates reused** — check for existing templates before generating from scratch
8. **Scope negotiated** — if it's too big, propose the focused version
9. **Errors handled** — if a build fails, diagnose and fix. Don't hand the error to the user
10. **Trust the user** — "skip to deployment" means skip to deployment
