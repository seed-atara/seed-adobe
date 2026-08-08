# ADR 0002 — Provider capability abstraction

Status: Accepted

## Decision

All model APIs sit behind normalized provider interfaces and expose capabilities dynamically.

## Why

Generative APIs change rapidly and differ in reference types, seeds, durations, resolution, and job semantics.

This is especially important because the project targets Seedance 2.5 before its exact official API contract has been confirmed in this research snapshot.
