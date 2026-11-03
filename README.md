# Agency OS

A production-oriented AI agent for digital agencies. It investigates project health across fragmented SaaS systems, explains its conclusions with evidence, and proposes actions that only run after human approval.

The demo question: **"What is blocking Project Acme?"** The agent answers from real Linear, GitHub and Slack APIs populated with synthetic data, not mocks.

> This is an engineering exploration of what a Forward Deployed Engineer would build inside a customer environment. All data is synthetic. It is not a packaged product.

## What it does today

- **Investigates** a project with Claude tool use (hand-rolled loop on the Anthropic API) across Linear, GitHub and Slack, then returns a structured assessment: risk, blockers, evidence, conflicts, uncertainty.
- **Proposes, never executes on its own.** Write actions (creating a Linear issue) are proposals. Approval is enforced in application code, not by prompting, and the writer is outside the model's tool loop.
- **Treats external content as untrusted.** Slack messages, issue titles and PR titles are data. Prompt-injection scenarios are part of the eval suite.
- **Is traceable.** OTel-shaped internal tracing with optional OTLP export, with secret redaction at the boundary.
- **Is evaluated.** 25 scenarios with deterministic graders (plus an LLM judge where semantic judgment is needed), run from Python against the real TypeScript agent code path.

## Integrations

| System  | Status      | How                                                       |
| ------- | ----------- | --------------------------------------------------------- |
| Linear  | Implemented | Custom MCP server in `mcp/linear` (reads); gated writes   |
| GitHub  | Implemented | Direct REST via Octokit; CI status from the Actions API   |
| Slack   | Implemented | Direct `@slack/web-api`                                   |
| HubSpot | Not started | Only mentioned in `docs/customer-discovery.md`            |
| Webflow | Not started |                                                           |

## Architecture

```text
apps/web (Hono + React)   apps/cli   apps/eval-runner
              \              |              /
               @agency-os/runtime  (production integration factory)
                          |
               packages/agent  (investigate, approval, tools)
                          |
        packages/integrations/*   mcp/linear
                          |
              Linear / GitHub / Slack APIs
```

Observability (`packages/observability`, `packages/observability-otel-export`) cuts across the layers. See `docs/architecture.md` and `docs/decisions.md` for the reasoning behind each choice.

## Getting started

Requirements: Node >= 22, pnpm 10, Python 3.12 (evals only).

```sh
pnpm install
cp .env.example .env     # fill in your own sandbox credentials
pnpm build
pnpm ask "What is blocking Project Acme?"   # CLI
pnpm web                                    # web UI on 127.0.0.1:3000
```

You need your own Anthropic key and your own Linear, GitHub and Slack sandbox accounts with synthetic data. The demo project registry (`packages/shared/src/project-registry.ts`) expects IDs you set in `.env`. Real Linear writes stay off unless `DEMO_WRITE_MODE=enabled` and a separate write-scoped key is set.

## Checks

```sh
pnpm format && pnpm typecheck && pnpm lint && pnpm test
python evals/run.py --suite free    # no model calls, no API key (runs in CI)
python evals/run.py --suite smoke   # fast local feedback (needs credentials)
```

Details: `docs/evaluation.md`.

## Documentation

- `docs/architecture.md`: components and data flow
- `docs/decisions.md`: architectural decision records, with trade-offs
- `docs/failures.md`: failures observed and what they taught
- `docs/evaluation.md`: eval framework, graders, scenarios
- `docs/web-runtime.md`, `docs/railway.md`: web transport and deployment
- `docs/vision.md`: the original product spec (broader than what is built)
- `AGENTS.md`: engineering rules for AI coding agents working in this repo

## Known limitations

- The web server has no authentication layer; treat it as a demo, not a multi-tenant service.
- Project mapping across systems is a static typed registry, not dynamic discovery.
- Only one write action exists (create a Linear issue), and it is disabled by default.

## License

MIT, see `LICENSE`.
