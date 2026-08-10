# 0007 — The direction agent proposes; it never generates

Status: accepted
Date: 2026-08-10

## Context

Writing a good prompt for Seedream or Seedance is a separate craft from
directing a shot. An artist who knows exactly what they want — "same bar, push
in tighter, warmer lanterns" — has to translate that into the register these
models answer to, remember that references are addressed by position, and pick
sizes and durations from what the provider happens to support.

That translation is the kind of work a language model does well, and it is the
first task in this product where one earns its place. The risk is equally
specific: a model that can also *start* generations is a model that can spend
the artist's money and change their timeline on a misreading.

## Decision

Direction is a **planning** step with a hard boundary at execution.

`POST /v1/agent/compose` takes a description and returns a `ComposedPlan`. It
creates no job, writes no asset, and touches neither the database nor the host
application. The panel fills its form from the plan and the artist presses
Generate exactly as they would have without it.

Three further constraints shape the implementation.

**The model never names a provider or a model id.** It returns a
provider-agnostic draft — media kind, intent, prompt, reference order, and the
parameters it wants. Code maps that onto a concrete provider from declared
capabilities, and the model id comes from runtime configuration. This is the
`CLAUDE.md` rule that contracts are verified rather than assumed, applied to a
component whose failure mode is confident invention. A plan cannot name a model
that does not exist, however plausible the name.

**Everything the code adjusts is said out loud.** A duration outside the
provider's range is clamped and reported; a size that is not offered is dropped
and reported; references beyond `maxImageReferences` are cut, and the artist is
told which. A silently corrected plan is a plan they cannot reason about — and
they are about to spend money on it.

**Mentions bridge names to positions.** Artists think in names; the models know
references only by position. `@bar_wide` is resolved in the panel to an asset,
shown to the director as a numbered candidate, and comes back as "Image 1" in
prose the provider will understand. The two vocabularies never have to meet.

The director is also shown the actual thumbnails, not just filenames. Reading
the artist's own footage is most of the value: the lighting, palette, and grade
in the frame are facts about the shot that no description repeats in full.

## Consequences

- Direction is optional. Without `ANTHROPIC_API_KEY` the service reports
  `director: false` and the panel does not offer the button, rather than
  presenting a control that fails when pressed.
- Provider selection prefers real providers over mocks. Planning a real shot
  onto a mock provider is a downgrade the artist would only discover from the
  result.
- The fitting rules are pure and separately testable (`planFromDraft`), so the
  decisions that matter are covered without a network round trip.
- Composition costs a model call of a few seconds. That is acceptable for an
  explicit button; it would not be acceptable on every keystroke, which is why
  direction is not wired into typing.
- This is Milestone 5's first slice and it deliberately stops short of the rest.
  There is no agent loop, no tool use, and nothing that edits the timeline. When
  that arrives it inherits this boundary: the agent produces a plan, the user
  approves the destructive step.
