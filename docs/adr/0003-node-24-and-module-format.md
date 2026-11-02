# ADR 0003: Node 24 and a CommonJS app on ESM-only NestJS 12

**Status:** accepted (Milestone 1)

## Context
NestJS 12 packages ship as ESM only. The official Nest 12 app template still compiles the app to CommonJS (`module: nodenext`, no `"type": "module"`) and relies on Node's `require(esm)`. Jest can only load those packages from CommonJS tests via native `require(esm)` on **Node ≥ 24.9**. On Node 22 the test suite fails to load `@nestjs/testing`.

Prisma 7's generator is ESM-first and emits `.js`-suffixed relative imports.

## Decision
- Node 24 LTS (`.nvmrc`, `engines: >=24.9`).
- Follow the Nest 12 template: CommonJS output, `node --experimental-vm-modules` for Jest.
- Prisma generator: `moduleFormat = "cjs"`, `importFileExtension = ""` so both `tsc` and Jest resolve the generated client.

## Consequences
- No custom ESM build setup to maintain. Upgrades follow Nest's template.
- Revisit if Nest or Jest move to a full-ESM default.
