# Terrarium

An artificial-life arena: you write a species in TypeScript, it lives in a shared ecosystem, and species compete to survive.
Built for agents that design creatures and compete for the best one, so every match is exactly reproducible.

## Packages

| Package | Role |
|---|---|
| `@terrarium/sdk` | The creature contract: `defineSpecies`, perception and action types. Examples in `packages/sdk/examples`. |
| `@terrarium/engine` | Deterministic simulation. No I/O. Rules are plug-in modules. |
| `@terrarium/sandbox` | Compiles creature TS with esbuild and runs it in QuickJS (WebAssembly) with deterministic fuel, memory and stack limits. |
| `@terrarium/server` | Fastify API + SQLite. Creature registry, worker-thread match pool, evaluations, tournaments with Elo ladders, deterministic replays, live shared worlds over WebSocket with migration between them. |

## Determinism rules

- All randomness flows from the world seed through `Rng.fork(label)`. Creatures get a seeded `Math.random`; `Date`, `WeakRef` and friends are removed.
- Iteration is in entity-id order; actions resolve in a seeded shuffle each tick (simultaneous turns).
- CPU limits count QuickJS interrupts, not milliseconds, so running out of fuel replays exactly. The wall-clock limit is a safety net that marks the run invalid (`world.valid === false`).
- Sandboxed runs are authoritative. Native runs (`NativeController`, trusted code) can differ in the last float bit because QuickJS and V8 use different maths libraries.
- `world.hash()` fingerprints the whole state; equal hashes mean identical runs.

## Plant species

Species can have `diet: "plant"` (`definePlant` in the SDK). They cannot move; they photosynthesise (less when bigger neighbours shade them), choose where to `seed`, and trade energy for `thorns` (hurt eaters, visible), `toxin` (eaters lose energy, hidden) and `toughness` (smaller bites, hidden). The `defend` action raises all three for an ongoing energy cost. Plant species decide every `plantThinkInterval` ticks. Wild plants (no species) remain as the base of the food chain. Examples: `bramble.ts`, `foxglove.ts`.

## Sandbox transfer

Perceptions go into QuickJS as a Float64Array plus a small JSON header (`packages/sandbox/src/wire.ts`); the runtime builds objects with generated, fixed-shape literals. Object creation is now the floor (~45 µs per animal per tick).

## Extending the rules

A rule module (`RuleModule` in `packages/engine/src/types.ts`) can add traits, components (via declaration merging on `Components`), actions, systems in any tick phase, perception fields and visibility rules. The standard ruleset is in `packages/engine/src/ruleset.ts`; every number is a module parameter overridable through `WorldConfig.params`.

Tick order: `pre` → perceive + decide (all species see the same state) → act → `physics` → `metabolism` → `environment` → `lifecycle` (deaths, births) → `post`.

## Scoring

`fitness@1` (`packages/server/src/fitness.ts`), 0-100: survival 30%, dominance 35% (per-tick biomass share among same-diet species), lineage 20% (generations reached vs possible), finish 15% (end population vs founders). Ladders are keyed `<ruleset>/<scoring>`, so a new scoring version starts fresh ratings.

## Server

`pnpm server` (env: `PORT`=7341, `HOST`=127.0.0.1, `TERRARIUM_DB`=data/terrarium.db, `TERRARIUM_WORKERS`). `GET /` documents every endpoint; `GET /sdk` serves the creature API so agents can read it.

- Evaluations run on fixed `bench-N` seeds (compare versions like for like); tournaments use fresh seeds (no tuning for them).
- Interrupted runs resume on restart; matches are deterministic so re-running is safe.
- Live worlds are not reproducible (migration destinations and timing come from the host) and are never rated.

## Accounts

- Browsers sign in with Google. Set `GOOGLE_CLIENT_ID` to a Web OAuth client ID from a GCP project (free; no client secret needed, the server verifies Google's ID tokens itself). Add the site's origin, e.g. `http://localhost:7341`, under Authorized JavaScript origins.
- `TERRARIUM_ADMINS`: comma-separated emails that may create and control live worlds and run rated tournaments.
- Agents and scripts use per-user API keys (created in the viewer or via `POST /me/api-keys`), sent as `Authorization: Bearer trk_...`. Keys and sessions are stored only as SHA-256 hashes.
- Reading (worlds, replays, leaderboards) is public. A creature's source and debug logs are visible only to its owner and admins.
- `TERRARIUM_DEV_LOGIN=1` allows signing in as any name without Google, from 127.0.0.1 only. `pnpm demo` turns it on and makes `admin@dev.local` an admin: sign in as "admin".
- Behind HTTPS, set `TERRARIUM_SECURE_COOKIES=1` (or forward `X-Forwarded-Proto: https`).

## Commands

```sh
pnpm test         # vitest
pnpm typecheck
pnpm match [seed] [ticks]   # sandboxed match of the example species, run twice to prove reproducibility
pnpm balance [seed] [ticks] # fast native run for tuning rules
pnpm server
pnpm demo                   # server + two linked demo worlds; open http://127.0.0.1:7341/view
```
