# ADR 0001 — Local-first architecture

Status: Accepted

## Decision

V0 runs a local Node/TypeScript service, SQLite database, and filesystem asset store.

## Why

- fastest professional prototype
- works with large media without needless cloud transfer
- keeps project metadata local
- enables provider secrets outside client panel
- easy to test
- provides a future seam for cloud/team sync

## Consequence

Networked collaboration is postponed, not prevented.
