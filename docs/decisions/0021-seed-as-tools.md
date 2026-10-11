# 0021 — SEED as tools, and a way into After Effects

**Status:** built 2026-10-11 — `seed-mcp` over stdio, and `POST /v1/host/run`
**Date:** 2026-10-11

## The ask

"Can you quasi MCP this tool? Or all of After Effects? Like, look at an image,
cut the regions, run a first version of the animation, apply some effects, save
a new version."

Two asks wearing one sentence, and they had very different answers.

## What was already true

The service is sixty-odd authenticated localhost routes with typed bodies.
Wrapping those as tools is an adapter, not an architecture.

After Effects was the opposite, and not for the reason it looked like. The
work all exists — `apps/extension/jsx/seed-host.jsx` is 2,482 lines and sixty
functions: `seedCreateRegion`, `seedAddEffect`, `seedInsertAtPlayhead`,
`seedRenderRange`, `seedCaptureRegion`. What did not exist was any way to call
one without a human clicking. **The wire only ever ran one way**: the panel
does the work and tells the service what happened, and `deps.aeHost` on the
service side is a `MockAeHostAdapter` and always has been. An agent asking the
service about the project would have been answered with fiction.

## The decision

Two pieces.

**`seed-mcp`** — a stdio MCP server wrapping the service over HTTP rather than
importing it. Shorter to construct the repositories in-process; also two live
writers on the SQLite file the artist's panel is using. One owner of the data,
and the MCP process can come and go.

**A command queue.** CEP panels are not servers and cannot be dialled, so the
panel *asks*: the service holds queued work, the panel long-polls `/v1/host/next`,
runs it through the bridge it already uses for its own buttons, and posts the
result back. That is the missing direction.

## The rule that shapes it

**A command is a name and typed arguments. Never a script.**

The tempting version is one endpoint taking ExtendScript — infinite capability,
ten lines. It would also make the panel an arbitrary code execution service
running inside the artist's project with their filesystem, and `CLAUDE.md`
forbids precisely it: *do not execute text returned by an LLM/model*.

So the panel's own typed methods are the allowlist, enforced at both ends. The
service refuses an unknown name before it reaches a host; the panel dispatches
through a written-out `switch` rather than `bridge[name](...)`, because a
reflective lookup would silently widen the vocabulary to every method the
bridge ever gains — including ones added later for the panel's own use and
never considered as something an agent should trigger. The allowlist has to be
a decision, which means it has to be typed out.

Adding a capability is a deliberate two-line change in two files. That is the
cost, and it is the right one: a project file is not where you want to discover
that a generated line of script meant something slightly different.

## And a switch the artist owns

The queue only runs while **Agent** is on in the panel's status bar. Off by
default, not remembered across sessions.

The session token is the security boundary and this is not pretending to be
one. It is the artist *knowing*. A panel that quietly accepted instructions to
change the open project because a token reached a terminal history would be a
bad surprise, and the cost of asking is one click.

## What this does and does not reach

Working today, measured against the live service: the library, generation,
restoration, transformation, the plate check, lineage, jobs, providers. That is
most of the original request — look at an image, run a first version, save a
new version — because all of it is media work and the library is append-only,
assets immutable, edits creating descendants. Nothing an agent does there can
destroy work.

Reaching the project: `ping`, `getContext`, `rangeInfo`, `listRegions`,
`selectedMedia`, `captureFrame`, `createRegion`, `setRegionAspect`,
`setRegionContain`, `setProjectDepth`.

**Not yet reachable, and named rather than implied:** applying an effect
(`seedAddEffect` exists but is not exposed), inserting at the playhead,
rendering a range, and saving the project as a new version — which has no host
function at all. "Apply some effects and save a new version" is therefore the
part of the original ask that is not done.

## Unverified inside Adobe

The queue, the dispatch and the MCP surface are covered by tests, including a
round trip through a real MCP client over a real transport. What no test here
can cover is the part that decides whether this works: whether a 25-second long
poll survives inside a CEP panel, and whether `evalScript` off a timer behaves
as it does off a click. Neither has been run in After Effects.

Per `docs/research/` convention and the standing rule in this repo — a feature
written up as finished from component measurements was deleted once it was
opened in AE — this is a mechanism that *should* work, not one that is known
to. The media half is known to: it was run against the live service.
