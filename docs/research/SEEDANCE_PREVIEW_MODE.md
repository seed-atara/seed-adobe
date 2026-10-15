# Seedance draft mode: a preview that upgrades to the real thing

**Resolved 2026-10-15.** An earlier version of this note said no preview mode
existed. **That was wrong**, and the correction is the useful part of the story:
the evidence was in our own stored payloads the whole time.

## It exists, and the API had been telling us so

Every Seedance task response this project has ever stored echoes, at the top
level, beside `resolution` and `seed`:

```json
"service_tier": "default",
"generate_audio": false,
"draft": false,
"priority": 0,
"output_format": "mov"
```

`draft` is a request field we were defaulting off. The first search for a
"preview mode" looked at documentation and at the account's model list, found
neither a flag nor a `seedance-2-5-fast`, and concluded there was nothing. The
answer was in `rawResponse` on every generation. **Read the payloads before
reading the docs.**

## The contract, from the official page

Source: [Dreamina Seedance 2.5 tutorial](https://docs.byteplus.com/en/docs/ModelArk/2607688),
§ Draft mode. The page renders its prose from a JSON blob in the HTML, so a
normal fetch returns only navigation; `curl` plus extracting the `insert`
strings gets the text. Quoted verbatim:

> Draft mode is a two-step video generation method that lets you quickly
> validate the result before generating a high-quality final video. After you
> enable this feature, you can quickly generate a low-resolution preview video
> to validate key elements such as the scene structure, shot scheduling, subject
> motion, and prompt intent. After confirming that the result meets
> expectations, use the Draft video task ID to generate a high-quality final
> video.

**Step 1 — the draft.** `POST /contents/generations/tasks` with `draft=true`.
- "Only 480p Draft videos can be generated. Setting another resolution causes an error."
- "The token consumption and token rate for a 480p Draft video are the same as those for a normal 480p video."

**Step 2 — the final.** "use the Draft video task ID returned in Step 1 to call
`POST /contents/generations/tasks` again and generate the final video."
- "Dreamina Seedance 2.5 currently supports only 1080p output. Setting another resolution causes an error."
- "A Draft video task ID is valid for seven days from its `created_at` timestamp."
- "Step 1 and Step 2 tasks are billed independently."

## Measured, on this account

One real draft: the 15s art-directed party-city transition, `draft: true`, 480p.

| | draft | the same shot without draft |
|---|---|---|
| latency | **80s** | 345s at 720p, 430s at 480p |
| billed | **150,886 tokens ≈ $0.92** | 326,486 ≈ $2.00 at 720p |
| returned | `cgt-20261015121117-91ene`, seed 76322 | — |

**80 seconds against 345.** That is the finding. The earlier note observed that
dropping resolution did not reduce latency (480p/10s came back slower than
720p/20s) and concluded latency was queue-bound. Draft mode is a different
queue, and it is four to five times faster.

## What is still unverified

**The field name that carries the draft id in Step 2.** The official page says
to call the same endpoint with the draft task ID but the code examples live in
a separate tab zone that is not in the page HTML. A third-party reference calls
it `source_task_id`, but that reference documents its own wrapper API — it names
the resolution field `quality` and the aspect `aspect_ratio` where Ark uses
`resolution` and `ratio` — so its field names cannot be trusted here.

Probing cannot settle it either: **Ark silently ignores unknown top-level
fields.** `source_task_id`, `draft_task_id` and `zzz_not_a_field` all produce
the identical error when `content` is empty, so a wrong name is indistinguishable
from a right one. Sub-paths were ruled out — `/tasks/{id}/convert` and
`/tasks/{id}/upscale` both return `InvalidAction`.

**Why this costs nothing to resolve.** Sending both candidate names on the Step
2 request is free: if one is honoured we get the draft's content at 1080p, and
if neither is we get a fresh 1080p render — which is the render we were going to
pay for anyway. The result is self-diagnosing, because a response whose `seed`
matches the draft's (76322) came from the draft and one with a new seed did not.

## How to use it

```
# preview — 480p, ~80s, ~$0.06/s of clip
npx tsx scripts/animate-night-to-party.ts ... --size 480p --draft

# the real one, after approval — 1080p only
npx tsx scripts/animate-night-to-party.ts ... --size 1080p
```

Draft mode is now wired through `VideoGenerationRequest.draft`, the
`/v1/generations` schema and `seedanceProvider`, and is sent only when asked
for, because the API defaults it off and echoes that.

**Use it for every iteration from here.** A 480p draft at $0.92 and 80 seconds
is the right unit for judging choreography; a 1080p render at $4.49 and six
minutes is for the one that has been approved.
