# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Spec authority

`CONTEXT.md` is the authoritative design document for this project. Read it before making any design or architecture decision. It states: "Follow it precisely — do not infer or introduce approaches, patterns, or scope that are not explicitly described here."

This repo is early — `apps/backend` is a scaffolded Fastify app with a placeholder route. Most of the stack below (chess.js, MCP SDK, Socket.IO, Drizzle, Zod) is agreed convention, not yet installed.

## Workspace

Nx monorepo with pnpm workspaces. Backend lives at `apps/backend`; clients get their own `apps/*`. Shared code goes in `libs/*`.

- Package manager: **pnpm**, never npm/yarn. New workspace-root deps need `pnpm add -Dw`.
- pnpm 11 blocks package build scripts by default. When install fails with `ERR_PNPM_IGNORED_BUILDS`, add the package to `allowBuilds:` in `pnpm-workspace.yaml` — not to `package.json`, which pnpm 11 no longer reads.

## Commands

Run tasks through Nx, not the underlying tool: `pnpm exec nx <target> <project>`.

- `pnpm exec nx test api` (Vitest, run mode), `nx build api` (esbuild), `nx lint api`, `nx typecheck api`, `nx serve api`.
- Everything at once: `pnpm exec nx run-many -t lint typecheck test build`.
- Single test: `pnpm exec nx test api -- -t 'test name'`.
- Postgres runs via **Docker Compose** (`docker compose up -d db`) — start it before running migrations or DB-touching tests.
- Formatting is Prettier at the root: `pnpm format`.
- TypeScript is pinned to 6.x — typescript-eslint does not support TS 7 yet, so do not bump it.

## ESM (project is `"type": "module"` throughout)

TS is configured with `moduleResolution: nodenext`. Three rules that break the build or runtime if ignored:

- Relative imports need explicit `.js` extensions: `import { app } from './app/app.js'` — even though the source file is `.ts`.
- No `__dirname` / `__filename`. Use `import.meta.dirname`.
- Import types with `import type` (or inline `type`). Fastify is CJS, so a value-position import of a type-only name like `FastifyInstance` becomes a real named import and throws at runtime.

## Stack constraints

These were chosen deliberately over alternatives; do not swap them:

- `chess.js` for all chess rules — never reimplement move validation, check/checkmate/draw detection, or FEN/SAN/UCI handling.
- Fastify (not Express), Drizzle ORM (not Prisma), Socket.IO (not raw `ws`), Zod for both REST and MCP input validation.
- `@modelcontextprotocol/sdk` for the LLM-facing layer. Human clients use HTTP + WebSocket, never MCP.

## Layering (hard rules)

Inside `apps/backend/src`: `controllers/` → `services/` → `repositories/`, with `models/domain` (entity invariants) separate from `models/schema` (Drizzle tables). `CONTEXT.md` §10 writes these as `/src/...`; in this monorepo they live under `apps/backend/src/`.

- Controllers hold no chess/business logic — validate with Zod, delegate to a service, format the response.
- Services never touch Drizzle or know about SQL/tables — they call repositories only.
- Repositories never hold business logic.
- Never conflate domain models with Drizzle schema models.

## Auth rule

Every authenticated call (`make_move`, `resign`, `send_message`, …) must check **both**: valid JWT signature **and** the Room is still active in the database. A valid `exp` alone is not sufficient — a Room can end early via resignation.

Tokens are scoped to the **Room** (HS256 JWT), never to a Game. `exp` is set at Room creation and shared by every Player token in that Room.

## Out of scope — do not implement

Deliberately deferred or rejected in `CONTEXT.md` §8. Do not build these, even if they seem like natural next steps:

- Rematch flow (`propose_rematch`, `rematch_proposed` reason). A Room has exactly one Game for now.
- Turn timeout / `timed_out` game status.
- Redis Pub/Sub or any cross-instance messaging — a single in-process `EventEmitter` is the MVP design.
- Piece-ID move payloads — use `{ from, to, promotion? }` square notation only.
- Push/SSE notification to the LLM — turn notification is the long-polling `wait_for_turn` tool.
- A custom protocol for LLM connectivity — MCP only.

## Other conventions

- All MCP tool names, parameters, responses, and messages are written in English.
- `make_move` returns the full updated state (board, status, applied move) — intentional, not accidental coupling. Do not reduce it to a success flag.

<!-- nx configuration start-->
<!-- Leave the start & end comments to automatically receive updates. -->

## General Guidelines for working with Nx

- For navigating/exploring the workspace, invoke the `nx-workspace` skill first - it has patterns for querying projects, targets, and dependencies
- When running tasks (for example build, lint, test, e2e, etc.), always prefer running the task through `nx` (i.e. `nx run`, `nx run-many`, `nx affected`) instead of using the underlying tooling directly
- Prefix nx commands with the workspace's package manager (e.g., `pnpm nx build`, `npm exec nx test`) - avoids using globally installed CLI
- You have access to the Nx MCP server and its tools, use them to help the user
- For Nx plugin best practices, check `node_modules/@nx/<plugin>/PLUGIN.md`. Not all plugins have this file - proceed without it if unavailable.
- NEVER guess CLI flags - always check nx_docs or `--help` first when unsure

## Scaffolding & Generators

- For scaffolding tasks (creating apps, libs, project structure, setup), ALWAYS invoke the `nx-generate` skill FIRST before exploring or calling MCP tools

## When to use nx_docs

- USE for: advanced config options, unfamiliar flags, migration guides, plugin configuration, edge cases
- DON'T USE for: basic generator syntax (`nx g @nx/react:app`), standard commands, things you already know
- The `nx-generate` skill handles generator discovery internally - don't call nx_docs just to look up generator syntax

<!-- nx configuration end-->
