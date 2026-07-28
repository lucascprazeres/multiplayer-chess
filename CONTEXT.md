# Multiplayer Chess Game — Architecture & Design Decisions

This document captures the finalized design decisions for a multiplayer chess game backend that supports both human players (via web/mobile clients) and LLM players (via MCP). It is meant to be used as authoritative context for implementation. Follow it precisely — do not infer or introduce approaches, patterns, or scope that are not explicitly described here.

## 1. Project Goal

Build a Node.js backend for a room-based multiplayer chess game where:

- Human players connect via a web (and eventually mobile) client using an invite link.
- An LLM can join a room as a full player (not an observer or move-suggestion assistant) using the Model Context Protocol (MCP).
- The chess engine/rules logic is agnostic to whether a player is human or an LLM.

## 2. Communication Protocol

- **Decision:** Use the Model Context Protocol (MCP) for LLM connectivity. Do not build a custom protocol for LLM communication.
- **Rationale:** MCP is purpose-built for tool-based interaction with LLMs. Building a custom protocol was explicitly rejected to keep scope focused on the game itself.
- Human clients connect via HTTP (REST) and WebSocket, not MCP.

## 3. Room / Access Model

- **Human players:** Join via an invite link that redirects to the web client.
- **LLM players:** Are given the `room_id` and an access `token` directly (no link/redirect flow), plus documentation describing how to connect via MCP tools.
- **Token scope — IMPORTANT:** The access token belongs to the **Room** (and thus to the Player record within that room), **not** to an individual Game. Do not scope tokens to a Game. The token remains valid for the lifetime of the Room, allowing the LLM to play across multiple Games within the same Room without reconnecting.
- **Token format:** JWT, signed with a single server-side secret (`HS256`). Do not use asymmetric signing (`RS256`) for the MVP — there is no requirement for external services to verify tokens independently.
- **JWT payload structure:**
  ```json
  {
    "playerId": "uuid",
    "roomId": "uuid",
    "type": "human" | "llm",
    "color": "white" | "black",
    "iat": 0,
    "exp": 0
  }
  ```
- **Expiration (`exp`):** Set at Room creation time and reused for every Player token issued in that Room, so all tokens in a Room expire together when the Room's lifetime ends. Do not give each Player token an independent `exp` based on their individual join time.
- **Revocation rule — IMPORTANT:** JWTs are stateless, so signature validity alone is not sufficient for authorization. Every authenticated call (e.g., `make_move`, `resign`, `send_message`) must check **both**: (a) the JWT signature is valid, **and** (b) the Room is still active (status lookup against the database). This covers the case where a Room ends before the token's `exp` is reached (e.g., early resignation) — the token must be rejected even if not technically expired.
- All MCP contract fields, tool names, and messages must be written in **English**.

## 4. Core Entities

Room and Game are intentionally **decoupled**. Do not merge them into a single entity.

### Room

- `id`
- `invite_code`
- `status`: `waiting` | `playing` | `finished`
- `players`: list of Player references
- `current_game_id`: reference to the active Game
- history of past `game_ids` (for future reference; no rematch flow is implemented yet — see Section 8)

### Game

- `id`
- `room_id` (FK to Room)
- `fen` (current board position)
- move history (PGN or equivalent)
- `turn`
- `status`: `in_progress` | `checkmate` | `draw` | `resigned` | `abandoned` (see Section 7; `timed_out` is a future addition, not implemented now)
- `winner`
- timestamps

### Player

- `id`
- `room_id` (FK to Room)
- `name`
- `type`: `human` | `llm`
- `color`: `white` | `black`
- `token`: JWT (belongs to the Room, per Section 3 — do not re-scope to Game; see Section 3 for payload structure, expiration, and revocation rules)

**Why decoupled:** This separation allows future rematches (new Game within the same Room) without touching Room-level state, and keeps Game as a pure chess-state object. Rematch flow itself is explicitly out of scope for now (Section 8).

## 5. MCP Tools Contract

All tool names, parameters, and responses must be in English. Moves are expressed using `from` / `to` square notation (UCI-style, e.g. `e2` → `e4`), **not** piece IDs.

### Move payload

- **Decision:** Use `{ from: string, to: string, promotion?: string }`.
- **Explicitly rejected approach:** Do NOT implement a piece-ID-based payload (e.g., referencing a piece by an ID returned from a board-state call). This was considered and rejected because:
  - `from`/`to` is unambiguous on its own — only one piece can occupy a given square.
  - It matches standard chess notation the LLM already understands from training data, minimizing hallucination risk.
  - Piece IDs would complicate special cases (promotion, castling, en passant) unnecessarily.
- `promotion` is optional and only used for pawn promotion (e.g., `"queen"`, `"knight"`, `"rook"`, `"bishop"`).

### Core tools

- **`get_board`** — Returns current board state, whose turn it is, and game status.
- **`make_move`** — Applies a move. **Must return the updated board state, game status (turn, check/checkmate/draw), and the applied move in the response.** This is an intentional design decision (see below) — do not make `make_move` return only a success/failure flag requiring a separate `get_board` call.
- **`list_valid_moves`** — Returns legal moves, to reduce illegal move attempts by the LLM.
- **`game_history`** — Returns the move history of the current game.
- **`send_message`** — Sends a message to the room's chat, if applicable.
- **`wait_for_turn`** — See Section 6.
- **`resign`** — Explicitly ends the game with the caller as the loser. Required for the voluntary-exit flow (Section 7).

**Design note on `make_move` returning board state:** This was deliberately evaluated for coupling concerns and accepted as correct. Returning the updated resource after a mutation is standard REST/RPC practice, reduces round-trips (each MCP tool call costs tokens/latency for the LLM), and avoids a race-condition window between making a move and separately querying board state. This is NOT considered problematic coupling since `make_move` still returns only data resulting directly from the move itself — it must not return unrelated data such as chat history or other games' data.

## 6. Turn Notification Strategy

- **Decision:** Use a **long-polling** MCP tool called `wait_for_turn`, not:
  - Plain polling (repeated dumb `get_board` calls) — rejected as wasteful.
  - Push/webhook/SSE-based reactive notification — rejected as unnecessarily complex given MCP's request/response nature and the fact that we don't control the LLM's host/client runtime.
- **`wait_for_turn` contract:**
  - Input: `game_id`, `timeout_seconds` (optional, default ~30s).
  - Output: same payload as `get_board`, plus a `reason` field.
  - **Current supported `reason` values (MVP scope):** `"your_turn"`, `"game_over"`.
  - **Explicitly out of scope for now:** `"rematch_proposed"` or any rematch-related reason (see Section 8). Do not implement rematch-related reasons yet.
  - **Explicitly out of scope for now:** turn timeout as a reason (see Section 7 — `timed_out` status is a planned future addition, not part of MVP).
- **Implementation approach:** Event-driven long polling, not a sleep/loop.
  - When `make_move` is processed and persisted, the server emits an internal event scoped to the `game_id` (e.g., via `EventEmitter` in Node.js).
  - `wait_for_turn` registers a listener for that `game_id` and resolves on whichever comes first: the event, or the timeout (`Promise.race` pattern).
  - **Single-instance MVP:** an in-process `EventEmitter` per room/game is sufficient. **Do not introduce Redis Pub/Sub or any cross-instance messaging system now** — this is only needed if horizontally scaling to multiple server instances, which is out of scope for the MVP.

## 7. Disconnection & Game-Ending Flows (MVP scope)

These flows must be implemented in the MVP to avoid rooms/games getting stuck.

### Human player disconnects (WebSocket drop)

- Do NOT treat immediate disconnection as abandonment.
- Mark the Player as `disconnected` (keep them in the Room).
- Start a reconnection grace period (~60–120 seconds).
- If the player reconnects (same token/session) within the window, resume normally.
- If the grace period expires, end the Game with status `abandoned`, and notify the opponent (via `wait_for_turn` / WebSocket) with an appropriate reason.

### LLM "disconnection"

- The LLM has no persistent connection (no WebSocket) — it only acts when calling tools.
- **Explicitly deferred to later (not MVP):** a turn timeout that would auto-resolve a stalled game if no one moves within a time limit. This applies to both human and LLM players.
- Do NOT implement turn timeout logic in the MVP. It was deliberately deferred. The architecture is designed so this can be added later as an additional event source (see below) without structural changes — but it must not be built now.

### Voluntary exit

- Requires an explicit `resign` action (MCP tool for LLM, UI action for human).
- Ends the Game with status `resigned` and sets the winner accordingly.

### Game status enum (current + planned)

- Implement now: `in_progress`, `checkmate`, `draw`, `resigned`, `abandoned`.
- **Do not implement now** (planned future addition only): `timed_out`.

### Note on future turn-timeout addition

When turn timeout is added later, it should reuse the same event-emission mechanism used for `wait_for_turn` and disconnection handling (i.e., a new event source feeding into the same notification pipeline) — no new tables, no new architectural layer. This is documented here only for context; **do not build it now.**

## 8. Explicitly Out of Scope (Do Not Implement)

To avoid scope creep and unwanted inference during implementation, the following were discussed and explicitly deferred or rejected. Do not implement any of these unless a future instruction says otherwise:

- **Rematch flow** (`propose_rematch`, `respond_rematch`, `rematch_proposed` event reason). Room/Game are decoupled specifically to allow this later, but no rematch logic should be built now. A Room has exactly one Game for now.
- **Turn timeout** (auto-ending a game due to inactivity, `timed_out` status). Deferred to a later phase.
- **Custom protocol for LLM communication.** Use MCP only.
- **Piece-ID-based move payloads.** Use `from`/`to` square notation only.
- **Cross-instance event propagation (e.g., Redis Pub/Sub).** Single in-process `EventEmitter` is sufficient for MVP; do not introduce this infrastructure now.
- **Reactive/push-based MCP notifications (SSE-driven proactive push to the LLM host).** Use long polling via `wait_for_turn` instead.

## 9. Technology Stack

| Layer                     | Technology                                            | Notes                                                                                                                                                                                |
| ------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Runtime                   | Node.js                                               |                                                                                                                                                                                      |
| Language                  | TypeScript                                            | Implied by tooling choices below                                                                                                                                                     |
| Chess rules engine        | `chess.js`                                            | Move validation, check/checkmate/draw detection, valid move generation, SAN/UCI/FEN notation. Do not reimplement chess rules manually.                                               |
| HTTP server               | Fastify                                               | Chosen over Express for schema validation and plugin-based structure.                                                                                                                |
| MCP layer                 | `@modelcontextprotocol/sdk` (official TypeScript SDK) |                                                                                                                                                                                      |
| Real-time (human clients) | Socket.IO                                             | Chosen over raw `ws` for built-in reconnection handling and native "rooms" support, which maps naturally to the Room concept.                                                        |
| Database                  | PostgreSQL                                            | Chosen upfront (not deferred to a later migration).                                                                                                                                  |
| ORM / query layer         | Drizzle ORM                                           | Chosen over Prisma for transparency (predictable generated SQL, no separate engine process) while keeping strong TypeScript typing. Prisma was considered and explicitly not chosen. |
| Validation                | Zod                                                   | Used for both REST payloads and MCP tool input validation.                                                                                                                           |

## 10. Architecture / Layering

**Pattern: MVC (without View) + Service layer + Repository pattern.**

```
/src
  /controllers   → HTTP routes (Fastify), MCP tool definitions, WebSocket handlers.
                   Responsibility: receive request, validate payload (Zod), call the
                   appropriate service, format response. NO business logic here.
  /services      → Use cases / business logic (e.g., createRoom, makeMove, joinRoom,
                   resign). Orchestrates domain logic (chess.js) and repositories.
                   Must NOT know about Drizzle or any persistence detail.
  /repositories  → Data access layer, encapsulates all Drizzle queries.
                   This is the ONLY layer that talks to Drizzle/Postgres directly.
  /models
    /domain       → Domain entities and their invariants: Game, Room, Player
                     (chess-rule-adjacent logic, not persistence).
    /schema       → Drizzle table definitions (persistence schema only).
```

### Hard layering rules (do not violate)

- **Controllers must never contain chess/business logic.** They only validate input and delegate to Services.
- **Services must never call Drizzle directly or know about SQL/table structure.** They only call Repositories.
- **Repositories must never contain business logic.** They only perform data access.
- Domain models (`Game`, `Room`, `Player`) are distinct from persistence schema models (Drizzle table definitions) — do not conflate the two into a single model layer.

## 11. Summary of Key Decisions (Quick Reference)

- Protocol for LLM: MCP (not custom).
- LLM joins as a full player, same endpoints/tools as any player — not an observer.
- LLM access: raw `room_id` + `token`, no invite link.
- Token scope: per-Room (per-Player), not per-Game. Token format: JWT (HS256), with `exp` tied to Room lifetime, and authorization checks requiring both valid signature AND active Room status (not `exp` alone).
- Move payload: `from`/`to` square notation + optional `promotion`, not piece IDs.
- `make_move` returns full updated state (board, status, applied move) — intentional, not accidental coupling.
- Turn notification: long-polling `wait_for_turn` tool, event-driven server-side (in-process `EventEmitter`), not push/SSE, not dumb polling.
- Room and Game are separate entities (to allow future rematch), but rematch logic is NOT implemented yet.
- Disconnection handling (grace period + `abandoned` status) and `resign` are in MVP scope.
- Turn timeout (`timed_out` status) is explicitly deferred, not MVP.
- Stack: Node.js + TypeScript, Fastify, `chess.js`, `@modelcontextprotocol/sdk`, Socket.IO, PostgreSQL + Drizzle ORM, Zod.
- Layering: Controller → Service → Repository, with Domain models separate from Drizzle schema models.
