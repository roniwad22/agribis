---
name: "Project Presenter"
description: "Builds presentations from your project's actual codebase — interactive HTML slide decks or PowerPoint (.pptx) files. SVG architecture diagrams, animated data flows, real metrics from code analysis. Four styles: pitch deck, technical deep-dive, product demo, progress update. Outputs HTML (interactive, browser-ready) or PPTX (for sharing, projectors, Google Slides import). Use whenever the user wants to present, demo, pitch, explain architecture, show progress, make slides, create a PowerPoint, or prepare for a meeting about their project."
---

# Project Presenter

Build presentations from real project data. Two output formats:
- **HTML** — interactive, animated, self-contained single file, opens in any browser
- **PowerPoint (.pptx)** — traditional slides, works with PowerPoint/Google Slides/Keynote

## On Activation

### Step 1: Deep-Read the Project

Run in parallel:

```
Read: CLAUDE.md, README.md, MEMORY.md
Glob: src/**/*.{js,ts,py,dart,go,rs}
Glob: **/package.json, **/pubspec.yaml, **/Cargo.toml, **/requirements.txt
Bash: git log --oneline -20
Bash: git shortlog -sn --no-merges
```

Then **read the key source files** — entry points, route handlers, data models, core logic. You need to understand the architecture deeply enough to draw accurate diagrams. File names alone aren't enough.

### Step 1b: NotebookLM Research (only when the user opts in)

**Do NOT query NotebookLM automatically.** Only use it when the user explicitly says to — e.g., "use my NotebookLM", "pull from my notebook", "I have research in NotebookLM", or provides a notebook name/URL.

When the user grants access:

1. Check availability:
   ```bash
   python -m notebooklm status 2>/dev/null
   ```
2. If authenticated, ask the user which notebook/sources to use:
   > You're connected to NotebookLM. Which notebook should I pull from? Or name the specific sources you want me to reference.

3. Once the user specifies sources, run targeted queries (not broad ones):
   ```bash
   python -m notebooklm ask "Who are the target users and what are their key pain points?" --json 2>/dev/null
   python -m notebooklm ask "What are the top 3 features or value propositions?" --json 2>/dev/null
   python -m notebooklm ask "What market data, traction metrics, or competitive positioning exists?" --json 2>/dev/null
   ```

4. Use the findings to enrich slide content — especially:
   - Problem/market slides (pitch deck) — real research data instead of assumptions
   - Feature prioritization — what the research says users need most
   - Competitive positioning — what differentiates this project
   - Metrics/traction — any data points from the research

**If NotebookLM is not available or user hasn't opted in:** Use only codebase analysis. Don't mention NotebookLM. Don't fail silently — just work with what you have.

### Step 2: Ask (only what you can't detect)

> 1. **Who's the audience?** (investors, engineers, users, team)
> 2. **What's the key message?** (e.g., "we're ready for pilot", "fund us", "here's the architecture")
> 3. **Format?** HTML (interactive, browser) or PowerPoint (.pptx)?

If the user mentioned NotebookLM, add: "Which notebook/sources should I pull from?"

Default to HTML unless the user says "PowerPoint", "pptx", "slides for a meeting", or indicates they need to share via email/projector where HTML interactivity won't matter. Skip questions the user already answered.

### Step 3: Confirm the Outline

> **[Title]** — [style], [N] slides
>
> 1. [Slide title] — [what content/diagram this slide has]
> 2. ...
>
> Good to go?

Wait for confirmation unless told to "just build it."

---

## Presentation Styles

### Pitch Deck (investors / stakeholders) — 8-12 slides
Problem → Market → Solution → How It Works → Traction → Business Model → Ask
- Bold, clean, large numbers, minimal text
- Simplified architecture (boxes and arrows, not code)
- Benefit language: "Farmers see prices before they sell" not "Real-time price API"

### Technical Deep-Dive (engineers) — 10-15 slides
System Overview → Architecture → Data Flow → Key Components → API Surface → Trade-offs → Future
- Dark theme, monospace accents, code snippets
- Architecture diagrams with real module names, sequence diagrams
- Design decisions and trade-offs, not marketing

### Product Demo (users) — 6-10 slides
What It Does → Key Features (one per slide) → How To Use It → What's Coming
- Friendly, colorful, animated feature reveals
- User journey maps, before/after visuals
- Benefits and ease of use, not implementation

### Progress Update (team) — 5-8 slides
Since Last Time → What Shipped → Metrics → Blockers → Next Sprint
- Data-forward: progress bars, git activity, diff stats
- What moved, what's blocking — they already know the vision

---

## Building the Presentation

### Generation Strategy

The output file will be large (1000-2000+ lines). Build it in sections to maintain quality:

1. **First: write the slide engine** — the `<style>` block (design system, transitions, responsive layout, print styles) and `<script>` block (navigation, progressive reveal, keyboard shortcuts). These are the same regardless of content. Get them working first.

2. **Then: write slides one at a time** — each `<section class="slide">` with its content and inline SVGs. Source every piece of text and every diagram from the project analysis.

3. **Finally: verify** — after writing the file, open it using the preview tools if available. If not, at minimum read back the file and check for: unclosed tags, broken SVG paths, JS syntax errors. If something is wrong, fix it before telling the user it's ready.

### The Slide Engine (embed in every presentation)

**Navigation**: arrow keys, click, swipe (mobile), on-screen buttons, slide counter ("3 / 12")
**Transitions**: CSS-driven slide/fade between slides, progressive reveal within slides (elements appear on successive key presses)
**Shortcuts**: Escape = overview grid, F = fullscreen, P = print
**Print**: `@media print` shows all slides stacked, one per page
**Progress**: bar or dots showing current position

### SVG Diagrams — The Hard Part

This is the skill's core value. Invest the most effort here.

**Architecture diagrams:**
1. From your source file reading, list every module/service/component and how they connect
2. Group by layer: user-facing (top), API/logic (middle), data/external (bottom)
3. Draw SVG: rounded-rect boxes with actual names, arrow paths showing real data flow
4. Color-code layers with the presentation's palette
5. Add `<title>` elements for accessibility and hover tooltips

**Data flow animations:**
1. Pick ONE real user action (e.g., "farmer submits harvest record")
2. Trace it through the code: endpoint → validation → business logic → database → notification
3. Draw the flow as connected nodes
4. Animate: on slide entry, highlight each node sequentially using `stroke-dashoffset` animation or opacity transitions with `animation-delay`

**Metric visualizations:**
- SVG `<rect>` bars, `<circle>` progress rings, `<text>` counters
- Animate on slide entry: bars grow from zero, numbers count up via JS
- Source data from: git commit count, file count, test count, API endpoint count, contributor count — real numbers from the codebase

**SVG rules:**
- Inline `<svg>` elements (not `<img>`) — enables CSS styling and JS interaction
- Always use `viewBox` for responsive scaling
- Keep markup minimal — hand-craft, don't paste from design tools
- Prefer CSS animations (`@keyframes`, `stroke-dashoffset`) over JS animation

### Content Sourcing

Every claim in the presentation must trace to something real:

| Content | Where to find it |
|---------|-----------------|
| Problem / pain | CLAUDE.md, README, memory files, **NotebookLM** (if opted in) |
| Solution | README, main entry point, core module |
| Architecture | Source file imports, route structure, data models |
| Features | Route handlers, UI components, exported functions, **NotebookLM** (user needs ranking) |
| Market / competitive | **NotebookLM** (if opted in) — research data, positioning, comparisons |
| Metrics | `git log`, `git shortlog`, file/test counts, **NotebookLM** (traction data) |
| Tech stack | package.json / pubspec.yaml / requirements.txt |
| Roadmap | TODO/FIXME in code, memory files, recent git activity |

**Writing rules:**
- One idea per slide. More than 5 bullets = split the slide.
- Headlines as statements: "3 user roles, 14 API endpoints, SMS-first" not "System Overview"
- Use concrete numbers from the codebase, not vague claims
- Pitch decks: benefit language. Technical: precision language. Demos: action language.

---

## PowerPoint (.pptx) Generation

When the user wants PowerPoint, generate a Python script that builds the .pptx using `python-pptx`.

### Setup

```bash
pip install python-pptx 2>/dev/null || pip install --user python-pptx
```

### How It Works

Write a Python script to `docs/presentations/build_[name].py` that:

1. Creates a presentation with the correct slide dimensions (widescreen 16:9: 13.333" x 7.5")
2. Defines a consistent theme: background color, title font/size/color, body font/size/color, accent colors — all matching the presentation style
3. Builds each slide programmatically:
   - **Title slides**: large centered text, subtitle below
   - **Content slides**: title + bullet points with proper indentation and spacing
   - **Diagram slides**: architecture and flow diagrams drawn with `python-pptx` shapes (rectangles, arrows, connectors) using real component names from code analysis
   - **Metric slides**: shapes arranged as charts — bars, progress indicators, large stat numbers
   - **Code slides** (technical only): monospace text boxes with syntax-colored code snippets
4. Saves the .pptx file

Then run the script:
```bash
python docs/presentations/build_[name].py
```

### Diagram Approach in PPTX

Since PPTX doesn't support SVG natively, draw diagrams with shapes:
- `MSO_SHAPE.ROUNDED_RECTANGLE` for components/modules
- `MSO_SHAPE.RIGHT_ARROW` or connectors for data flow
- Group related shapes by layer (frontend, API, database)
- Color-code using the same palette logic as HTML
- Add text to each shape with the real component name

### PPTX Design Rules

- **Font sizes**: Title 36pt, Subtitle 24pt, Body 20pt, Caption 14pt — never smaller
- **Colors**: Define 4-5 colors as constants at the top of the script. Use `RGBColor()`
- **Margins**: Leave generous padding — `Inches(0.8)` minimum from slide edges
- **One idea per slide** — same rule as HTML
- **No clip art, no stock imagery** — clean shapes, real data, strong typography
- **Speaker notes**: Add notes to each slide with talking points the presenter can reference

### PPTX Output

Save the script AND the generated .pptx:
- Script: `docs/presentations/build_[name].py` (re-runnable if the user wants to regenerate)
- Output: `docs/presentations/[name].pptx`

The script is kept so the user can modify and regenerate. Tell them:

> Saved to `docs/presentations/[name].pptx` — [N] slides, [style] format.
> Opens in PowerPoint, Google Slides, or Keynote.
> The build script is at `docs/presentations/build_[name].py` if you want to tweak and regenerate.

---

## HTML Output and Verification

Save to `docs/presentations/[descriptive-name].html`. Create the directory if needed.

**Before telling the user it's ready**, verify the output:
1. Read back the file and scan for unclosed HTML tags, broken SVG, JS errors
2. If preview tools are available, open the file and check that slides render and navigate correctly
3. If you find issues, fix them silently — don't deliver a broken file

Then:

> Saved to `docs/presentations/[name].html` — [N] slides, [style] format.
> Open in any browser, no server needed.
>
> Want me to adjust any slides, add content, or change the style?

---

## Iteration

**HTML**: Edit the existing file — don't regenerate from scratch. The user may have made manual tweaks.

**PPTX**: Edit the build script and re-run it. The script is the source of truth.

- "Make slide 4 simpler" → find slide 4, reduce elements
- "Add a slide about X" → analyze relevant code, insert new slide
- "Dark/light theme" → swap color constants/CSS custom properties
- "More detail on architecture" → re-read more source files, expand diagram
- "Give me both formats" → generate HTML first, then write a PPTX build script using the same content
- "PDF export" → HTML: add print button calling `window.print()`. PPTX: user can save-as-PDF from PowerPoint.

---

## Rules

1. **Real content only.** Every diagram, metric, and claim from the actual codebase. No placeholders.
2. **Deep-read first.** Read source files, not just filenames. Shallow reading = generic output.
3. **Verify before delivering.** Check for errors. Fix before handing over.
4. **One idea per slide.** Dense slides are bad slides.
5. **Diagrams are the product.** Invest the most effort in accurate diagrams — SVG for HTML, shapes for PPTX.
6. **Edit, don't regenerate.** Preserve the user's changes on iteration.
7. **HTML: single file, zero dependencies.** No CDN, no external links. Everything embedded.
8. **PPTX: keep the build script.** The script is re-runnable and editable. Always deliver both .py and .pptx.
