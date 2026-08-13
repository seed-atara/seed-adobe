# 0010 — A reference travels as a link, not as an asset id

Status: accepted
Date: 2026-08-13

Supersedes ADR 0005 §2 and §3.

## Context

ADR 0005 built a reference policy on a route that does not exist.

Its `asset` policy — register the frame in the Ark asset library, reference it
as `asset://<Asset_Id>` — came from research notes rather than a live call, and
it could never be tested because registration needed a public URL publisher
that had not been written. The publisher exists now (ADR 0009), so the policy
could finally be switched on. It failed in nine seconds:

```
InvalidParameter: The parameter `image` specified in the request is not valid:
invalid url specified.
```

All three candidate forms were then tried against the live endpoint with the
same registered asset:

| `image` value | images/generations |
| --- | --- |
| presigned https URL | **accepted** — a real image came back |
| `asset://<id>` | 400, invalid url |
| bare `<id>` | 400, invalid url |

Registration itself works and the ids are real. Nothing at image inference will
take one.

The video endpoint is not the same service and does not behave the same way:
`asset://<id>` in a `video_url` part **is** accepted, and the task ran to a
completed clip. A bare id is refused there too. So the asset library is a real
route — for video.

## Decision

**The reference policy is about hosting, not registration.**

`ReferencePolicy` is now:

- `hosted` — publish the frame and send its presigned link; **fail** rather
  than fall back
- `hosted-or-inline` — publish if possible, otherwise a data URL (default)
- `inline` — always a data URL

The old `asset` and `asset-or-inline` spellings are accepted and mean the
hosted ones, so an existing `.env` keeps working. They are not kept as
aliases out of politeness: renaming them silently would leave a setting whose
name describes something the product does not do.

ADR 0005's *reason* survives intact — a pipeline carrying recognisable real
people must not silently post raw pixels, so the strict option exists and is
loud when it cannot be honoured. Only the mechanism was wrong.

**The asset library stays.** It is verified, deduped by content hash, and it is
the accepted reference form for video. It is not wired into the video path yet:
registration costs ten to thirty seconds before a job can even start, against
half a second to publish a link, and the link is what a demo wants. The choice
is now a real one to make later rather than a missing capability.

## Consequences

**Image references stop being base64.** A 1.5MB frame travelled as ~2MB of
inline base64 on every request, including every retry and every variant. It is
now a URL, and the bytes upload once per content hash.

**`hosted` is verified end to end.** A real Seedream edit ran with the policy
forced on, and the stored request carries `"image": "https://…r2.cloudflare…"`
with no data URL anywhere in it.

**Raw requests are persisted, which is how the above was checked.** Every
adapter returned a `rawRequest` with credentials stripped, and nothing stored
it — so a generation recorded what was asked for and nothing about what was
sent. `setRawRequest` fills that in at submission. The repository principle
said this was already true; it was not.

**A research claim that was never verified became an ADR, and then a feature.**
The note in MODEL_API_NOTES.md said `asset://<Asset_Id>` plainly enough to be
believed. It is now marked with what was measured. Claims in that file carry a
verification date for this reason; this one did not, and the gap between "read
somewhere" and "seen working" is exactly the width of this ADR.
