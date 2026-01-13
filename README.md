# SSR-Agent

Claude-powered synthetic usability testing that produces quantitative and qualitative metrics using the Semantic Similarity Rating (SSR) methodology.

## What It Does

SSR-Agent runs "synthetic users" (Claude roleplaying personas) through your website to:

1. **Execute test scenarios** - Claude navigates your site attempting tasks like "complete checkout" or "find pricing"
2. **Capture everything** - Screenshots, Playwright traces, console errors, network failures, step logs
3. **Collect qualitative feedback** - Claude answers evaluation questions in free text from the persona's perspective
4. **Produce quantitative scores** - SSR converts free-text answers into Likert distributions (1-5 scale)
5. **Enable regression detection** - Compare runs against baselines with CI integration

## Installation

```bash
npm install
```

## Quick Start

### 1. Initialize config

```bash
npx tsx src/cli.ts init
```

This creates `webtest.config.json` with example scenarios and personas.

### 2. Configure your site

Edit `webtest.config.json`:

```json
{
  "baseUrl": "https://your-site.com",
  "allowedHosts": ["your-site.com", "auth.your-site.com"],
  "scenarios": [
    {
      "id": "checkout",
      "name": "Complete Checkout",
      "goal": "Add an item to cart and complete checkout",
      "successCriteria": "Order confirmation page is displayed"
    }
  ],
  "personas": [
    {
      "id": "impatient-user",
      "name": "Impatient User",
      "traits": ["easily frustrated", "skims content", "clicks quickly"],
      "demographics": { "techExperience": "medium" }
    }
  ],
  "evaluationQuestions": [
    { "id": "ease", "question": "How easy was it to complete the task?" },
    { "id": "trust", "question": "How trustworthy did this site feel?" }
  ]
}
```

### 3. Run a test

```bash
# Set API keys
export ANTHROPIC_API_KEY=your-key
export VOYAGE_API_KEY=your-key  # Optional, for SSR scoring

# Run the test
npx tsx src/cli.ts run --scenario checkout --persona impatient-user
```

### 4. View the report

```bash
npx tsx src/cli.ts report --latest
```

## Commands

### `init`

Creates a `webtest.config.json` file with example configuration.

```bash
npx tsx src/cli.ts init
```

### `generate-personas`

Generate realistic user personas using Claude AI.

```bash
npx tsx src/cli.ts generate-personas --audience "e-commerce shoppers aged 25-45" --count 5
```

**Options:**
| Option | Description |
|--------|-------------|
| `--audience <description>` | Description of target audience (required) |
| `--count <number>` | Number of personas to generate (default: 3) |
| `--update` | Add generated personas to webtest.config.json |

**Examples:**

```bash
# Generate 3 personas and output JSON to stdout
npx tsx src/cli.ts generate-personas --audience "SaaS users in enterprise IT"

# Generate 5 personas and add them to the config file
npx tsx src/cli.ts generate-personas --audience "mobile banking users" --count 5 --update

# Pipe output to a file
npx tsx src/cli.ts generate-personas --audience "healthcare professionals" > personas.json
```

### `run`

Executes a test scenario with a persona.

```bash
npx tsx src/cli.ts run --scenario <id> --persona <id> [options]
```

**Options:**
| Option | Description |
|--------|-------------|
| `--scenario <id>` | Scenario ID from config (required) |
| `--persona <id>` | Persona ID from config (required) |
| `--headless` | Run browser in headless mode |
| `--save-baseline <name>` | Save results as a named baseline |
| `--ci` | CI mode: exit with code based on thresholds |

**What happens during a run:**

1. Launches Chromium browser (headless or visible)
2. Starts Playwright tracing
3. Navigates to `baseUrl`
4. Takes initial screenshot
5. Claude agent begins executing the scenario:
   - Observes page state (URL, elements, text)
   - Takes actions (click, type, navigate)
   - Verifies conditions with assertions
6. After completion, Claude answers evaluation questions
7. Captures final screenshot and saves trace
8. Persists all artifacts (JSON, markdown report)
9. Calculates SSR scores (if VOYAGE_API_KEY set)

### `compare`

Compare a run against a saved baseline.

```bash
npx tsx src/cli.ts compare --baseline <name> --candidate <run-id>
```

### `report`

View a run report with SSR scores.

```bash
npx tsx src/cli.ts report --latest
npx tsx src/cli.ts report --run <run-id>
```

## Output Artifacts

Each run creates a directory in `runs/<timestamp>-<scenario>-<persona>/` containing:

| File | Description |
|------|-------------|
| `metadata.json` | Run configuration and timing |
| `run-result.json` | Full structured results |
| `step-log.json` | All browser actions taken |
| `report.md` | Human-readable markdown report |
| `ssr-scores.json` | SSR scores for each evaluation question |
| `trace.zip` | Playwright trace (view with `npx playwright show-trace trace.zip`) |
| `screenshot-initial.png` | Screenshot before agent starts |
| `screenshot-final.png` | Screenshot after agent finishes |
| `console-errors.json` | JavaScript console errors (if any) |
| `network-errors.json` | Failed network requests (if any) |

## SSR Scoring

SSR (Semantic Similarity Rating) converts free-text responses into quantitative scores:

1. Claude provides a free-text answer based on its persona (e.g., "The checkout was confusing, I almost gave up")
2. The answer is embedded using Voyage AI
3. Similarity is computed against 6 anchor statement sets per question
4. A probability distribution over Likert 1-5 is generated via softmax
5. Expected score and entropy are calculated

**Example output:**
```
ease: 2.34/5.00  (distribution shows high probability of 2-3)
trust: 4.12/5.00 (distribution shows high probability of 4-5)
```

## CI Integration

Use `--ci` flag for automated testing with threshold-based exit codes:

```bash
npx tsx src/cli.ts run --scenario checkout --persona user --ci --headless
```

Configure thresholds in `webtest.config.json`:

```json
{
  "thresholds": {
    "minSuccessRate": 1,
    "minEaseScore": 3.5,
    "minTrustScore": 3.5
  }
}
```

Exit codes:
- `0` - All thresholds passed
- `1` - One or more thresholds failed

## Configuration Reference

### Full Config Schema

```json
{
  "baseUrl": "https://example.com",
  "allowedHosts": ["example.com"],
  "scenarios": [
    {
      "id": "unique-id",
      "name": "Human Readable Name",
      "goal": "What the user is trying to accomplish",
      "successCriteria": "How to know if the task succeeded"
    }
  ],
  "personas": [
    {
      "id": "unique-id",
      "name": "Persona Name",
      "traits": ["trait1", "trait2"],
      "demographics": { "key": "value" }
    }
  ],
  "evaluationQuestions": [
    {
      "id": "ease",
      "question": "How easy was it to complete the task?"
    }
  ],
  "anchors": {
    "ease": {
      "1": "Anchor statement for score 1",
      "2": "Anchor statement for score 2",
      "3": "Anchor statement for score 3",
      "4": "Anchor statement for score 4",
      "5": "Anchor statement for score 5"
    }
  },
  "thresholds": {
    "minSuccessRate": 1,
    "minEaseScore": 3.5,
    "minTrustScore": 3.5
  }
}
```

### Security Controls

The agent has built-in guardrails:
- **Domain allowlist**: Only navigates to hosts in `allowedHosts`
- **30s timeout**: Per-action timeout prevents hangs
- **No secrets in output**: Cookies/tokens never returned in tool outputs
- **Max 50 turns**: Prevents infinite loops

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Claude API access |
| `VOYAGE_API_KEY` | No | Enables SSR scoring via Voyage embeddings |

## Development

```bash
# Type check
npx tsc --noEmit

# Build
npm run build

# Run CLI
npx tsx src/cli.ts <command>

# View a Playwright trace
npx playwright show-trace runs/<run-id>/trace.zip
```

## How It Works

### Agent Tools

The Claude agent has access to four browser tools:

1. **`mcp__browser__observe`** - Returns current page state (URL, title, interactive elements, visible text)
2. **`mcp__browser__act`** - Performs actions: `goto`, `click`, `type`, `press`, `select`, `scroll`, `wait`, `back`
3. **`mcp__browser__assert`** - Verifies conditions: `urlContains`, `textVisible`, `elementVisible`
4. **`mcp__browser__end`** - Closes browser and flushes trace

### Evaluation Flow

After the scenario completes:

1. Claude is prompted with evaluation questions and the persona context
2. It answers each question with 2-4 sentences reflecting the persona's experience
3. Answers are embedded and compared against anchor statements
4. SSR produces a probability distribution and expected score per question

## Limitations

- SSR accuracy depends on embedding model quality and anchor statement design
- Results are synthetic - useful for regression detection, not absolute truth
- Complex multi-step scenarios may hit the 50-turn limit
