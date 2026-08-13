# 0009 — Media a provider must fetch goes through a private bucket

Status: accepted
Date: 2026-08-13

## Context

Every reference SEED has ever sent travelled inline, as a data URL. That works
for stills and it is a genuinely good property: nothing is hosted, nothing
outlives the request, and the only party who ever sees the pixels is the model
being asked to work from them.

Video breaks it. Seedance answers a data URL with

```
InvalidParameter: reference_video must be provided as a web url.
```

and the two ways around it are both closed: Ark's asset library fetches from a
URL too, and there is no Ark-hosted upload endpoint at all — probed action by
action, see `docs/research/MODEL_API_NOTES.md`. So a motion reference requires
somewhere ByteDance's servers can fetch from, and that requirement is not
negotiable at our end.

This is the `PublicUrlPublisher` seam ADR 0005 left open, now that something
actually needs it.

## Decision

**A private S3-compatible bucket, written with SigV4, read through short-lived
presigned links.** Configured through `SEED_R2_*`; Cloudflare R2 is what SEED
uses, and the same four settings drive S3, B2 or MinIO.

Four properties matter, in this order:

1. **The bucket is never public.** A presigned GET grants read of exactly one
   object for exactly as long as the signature lives. That is the same trust
   boundary the data URLs already had — the provider can see what we asked it
   to work from, and nobody else can see anything — rather than a step down
   from it. Verified: an unsigned request for the same object is refused.
2. **Keys are content hashes.** The same clip referenced twice is one object
   and one upload, and a re-run of a recipe costs nothing. It also means a key
   leaks nothing about the project, the comp or the shot.
3. **The link is minted per request, not stored.** Signing is local arithmetic,
   so there is no cache to expire and no state to be wrong. Ark fetches the
   media when the task is submitted, not while it renders, so an hour is
   already generous.
4. **Absent is a working configuration.** With no bucket, images travel inline
   exactly as before and video references are refused with a message naming the
   four settings. Hosting is not made a precondition for the parts that never
   needed it.

Uploading is per-kind rather than per-provider: images stay inline because Ark
accepts them inline, and only video pays for a round trip. That rule lives in
the materializer, which is the one place that already knew the difference
between a local file and something a provider will accept.

## Consequences

**`asset://` registration is unblocked.** `CreateAsset` needed the same thing
and now has it, so the reference policy ADR 0005 wanted for recognisable real
people is a configuration change rather than a missing component. One ordering
bug was fixed on the way: the temporary link was disposed of immediately after
`CreateAsset` returned, but Ark fetches the file while the asset preprocesses,
so disposal now waits until the asset is Active.

**Objects accumulate.** Nothing deletes them: disposal cannot be safely tied to
the request that created them, because the provider is still fetching. A bucket
lifecycle rule is the right tool and it belongs to whoever owns the bucket, not
to this code.

**The fast path is deliberately not built.** A clip SEED generated in the last
day is still served from Volcengine's own storage and could be referenced by
its original URL for free. It was measured and it works — until it does not,
403 about a day later, with no way to tell from the URL which case you are in.
That means a liveness probe before every use and a second code path that ends
in the publisher anyway, to save one upload of a few megabytes. Not worth it.
Recorded rather than forgotten: `scripts/probe-video-ref-url.ts` still measures
the expiry if it becomes interesting.
