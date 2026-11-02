# ADR 0001: Code-first GraphQL with a committed schema file

**Status:** accepted (Milestone 1)

## Context
The mobile app consumes the API through generated types (GraphQL Code Generator). The schema is the contract between the two. NestJS supports schema-first (hand-written SDL, generated TS types) and code-first (decorated TS classes generate the SDL).

## Decision
Code-first. `autoSchemaFile` writes `apps/api/schema.graphql` (sorted) in dev/test. The file is committed. CI regenerates it and fails if it differs. In production the schema is built in memory.

## Consequences
- One source of truth: resolver signatures and the schema can't disagree.
- Contract changes are visible in every PR diff, which is where breaking changes (e.g. nullable to non-null) get caught.
- Risk: it's tempting to decorate classes that mirror database tables. Rule: GraphQL types live in their module and are mapped explicitly from domain objects. Prisma models are never returned from resolvers.
- Large input types get decorator-heavy. Accepted.
