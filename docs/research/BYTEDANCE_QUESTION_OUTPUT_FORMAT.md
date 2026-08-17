# For ByteDance: `output_format` / `file_format` and `bitrate_mode`

Draft reply to Mittul Madaan, 2026-08-18. Everything below is measured against
the live API from this account; the exact requests are reproducible with the
curls at the end.

---

## The short version

We send **no** format parameter today. When we tried, `output_format` appeared
to be ignored and `file_format` was **rejected on every model we have**:

```
the specified parameter file_format is not supported for model
dreamina-seedance-2-5 in r2v, must be empty
```

So the question is: **which model, and which mode, accepts it — and is our
account entitled to that model?**

---

## What we send now

Endpoint `POST {ARK_BASE_URL}/contents/generations/tasks`, base
`https://ark.ap-southeast.bytepluses.com/api/v3`.

```json
{
  "model": "dreamina-seedance-2-5-260628",
  "content": [
    { "type": "text", "text": "a slow push in" },
    { "type": "image_url",
      "image_url": { "url": "https://<presigned-r2-url>/plate.png" },
      "role": "first_frame" }
  ],
  "duration": 5,
  "resolution": "720p",
  "bitrate_mode": "high",
  "return_last_frame": true,
  "generate_audio": false
}
```

No `output_format` and no `file_format` — deliberately, because of the results
below.

## What we measured

Method, and its one important limitation: every probe carried `duration: 3`,
which this model rejects, **so validation always fails and no billable task is
created**. That means these results describe what the *request validator* reads.
If a parameter is only acted on later, at execution, our method cannot see it —
which may be exactly what is happening with `output_format`.

Eight repetitions per case, because the API names only one invalid parameter per
response and picks inconsistently.

### `file_format` — read, and refused everywhere

Tried across **all four models on our account** — `dreamina-seedance-2-5-260628`,
`dreamina-seedance-2-0-260128`, `dreamina-seedance-2-0-fast-260128`,
`dreamina-seedance-2-0-mini-260615` — and in **three modes**: `t2v`, `i2v`
(with a `first_frame`) and `r2v` (with two `reference_image` parts).

| Value | Result |
|---|---|
| `"banana"` | refused, named |
| `"mov"` | refused, named |
| `"mp4"` | refused, named |
| `"prores"` | refused, named |

Always the same wording: *"the specified parameter file_format is not supported
for model &lt;model&gt; in &lt;mode&gt;, must be empty"*. Note that even `mp4` — the
default — is refused, which is what makes us think this is an entitlement or a
model-support question rather than a value question.

### `output_format` — never named

`"banana"`, `"mov"` and `"mp4"` all passed unremarked, in `t2v` and `i2v`. A
nonsense value that is not rejected usually means the field is not read at that
stage. **But per the caveat above, we cannot distinguish "ignored" from
"validated later".** If `output_format` is the documented name for the same
thing `file_format` reports internally, then the `file_format` message is
probably the real answer.

Also never named: `container`, `video_format`, `codec`, `pix_fmt`,
`pixel_format`, `file_type`, `output_type`.

### `bitrate_mode` — read, and working

| Value | Result |
|---|---|
| `"standard"` | accepted |
| `"high"` | accepted |
| `"low"` | refused by name |
| `"banana"` | refused by name |

We now default to `"high"`. One thing worth confirming: `bitrate_mode` is
**not** read by `dreamina-seedance-2-0-mini-260615` — nonsense values pass
there — so we assume it is unsupported on mini.

---

## What we would like to know

1. Which **model** and which **mode** accept `output_format` / `file_format`,
   and is our account entitled to it?
2. Is `output_format` validated at request time or only at execution? Our
   probe method cannot see the latter.
3. With `output_format: "mov"`, what is the pixel format — is it `yuv444p` or
   `yuv444p10le`, i.e. genuinely no chroma subsampling?
4. Is `bitrate_mode` genuinely unsupported on `2-0-mini`, or just unvalidated?

The reason we care: the returned mp4 is 4:2:0 8-bit with **no colour signalling
at all** — no `colr` box in the container and no `video_signal_type` in the
H.264 SPS. Every consumer therefore assumes BT.709 limited range, while the
frame we send is full-range sRGB, so a returned frame never matches its input
plate. Range and transfer we can correct for. Chroma subsampling we cannot, and
that is the part a 4:4:4 MOV would fix. It matters most on the round trip:
these clips are re-referenced and re-encoded by later shots, so the loss
compounds.

---

## Reproducing it

Replace `$ARK_API_KEY` and `$ARK_BASE_URL`. Each of these fails validation on
`duration`, so nothing is billed.

```bash
# 1. file_format is read, and refused — even for "mp4"
curl -sS -X POST "$ARK_BASE_URL/contents/generations/tasks" \
  -H "authorization: Bearer $ARK_API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "model": "dreamina-seedance-2-5-260628",
    "content": [{ "type": "text", "text": "a slow push in" }],
    "duration": 3,
    "file_format": "mov"
  }'
# -> "the specified parameter file_format is not supported for model
#     dreamina-seedance-2-5 in t2v, must be empty"

# 2. output_format is not named, even with a nonsense value
curl -sS -X POST "$ARK_BASE_URL/contents/generations/tasks" \
  -H "authorization: Bearer $ARK_API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "model": "dreamina-seedance-2-5-260628",
    "content": [{ "type": "text", "text": "a slow push in" }],
    "duration": 3,
    "output_format": "banana"
  }'
# -> complains only about duration

# 3. bitrate_mode is read: "high" passes, "low" is refused by name
curl -sS -X POST "$ARK_BASE_URL/contents/generations/tasks" \
  -H "authorization: Bearer $ARK_API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "model": "dreamina-seedance-2-5-260628",
    "content": [{ "type": "text", "text": "a slow push in" }],
    "duration": 3,
    "bitrate_mode": "low"
  }'
# -> "the parameter bitrate_mode specified in the request is not valid for
#     model dreamina-seedance-2-5 in t2v"
```

Our probe scripts are `scripts/probe-output-format.ts` in the SEED repo, if it
is easier to read the method than the curls.
