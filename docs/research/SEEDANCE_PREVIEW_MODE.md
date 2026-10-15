# Is there a "preview mode" on BytePlus / Seedance?

**Asked 2026-10-15**, because a 15s 720p generation takes minutes and the GYG
party-city transition needs several iterations of art direction.

**Short answer: no preview parameter exists, and dropping resolution does not
make it faster. The only real lever is a different model.**

## What was checked

1. **BytePlus ModelArk documentation.** Searched for a preview, draft, fast,
   low-quality or test parameter on the video generation API. Nothing of the
   kind appears. The third-party parameter tables that do exist list `model`,
   `prompt`, `resolution`, `duration`, `ratio`, `audio`, `seed` and
   `negative_prompt` — no preview flag among them.
   - [Create a video generation task](https://docs.byteplus.com/en/docs/ModelArk/1520757)
   - [Video generation API](https://docs.byteplus.com/en/docs/ModelArk/Video_Generation_API)
   - [Dreamina Seedance 2.5 tutorial](https://docs.byteplus.com/en/docs/ModelArk/2607688)
   - [Dreamina Seedance 2.0 series tutorial](https://docs.byteplus.com/en/docs/modelark/2291680)

   **Caveat, stated rather than hidden:** the docs pages render their parameter
   tables with JavaScript, so a fetch returns only navigation. The absence of a
   preview flag is therefore from search results and third-party tables, **not**
   from reading the official table directly. It is not proof.

2. **The account's own model list**, which *is* authoritative for what can
   actually be called — `npx tsx --env-file=.env scripts/ark-models.ts`:

   | model id | name |
   |---|---|
   | `dreamina-seedance-2-5-260628` | Dreamina-Seedance-2.5 |
   | `dreamina-seedance-2-0-260128` | Dreamina-Seedance-2.0 |
   | `dreamina-seedance-2-0-fast-260128` | Dreamina-Seedance-2.0-**fast** |
   | `dreamina-seedance-2-0-mini-260615` | Dreamina-Seedance-2.0-**mini** |
   | `seedance-1-0-pro-fast-251015` | ByteDance-Seedance-1.0-pro-fast |
   | `seedance-1-5-pro-251215` | ByteDance-Seedance-1.5-pro |
   | `seedance-1-0-lite-i2v-250428` / `-t2v-250428` | Seedance 1.0 lite |

   **There is no `seedance-2-5-fast` and no `seedance-2-5-mini`.** The fast and
   mini variants stop at 2.0. So "preview mode" on this platform is a *model*,
   and taking it means leaving 2.5.

## The measurement that matters

Four real jobs from one session, wall-clock from submit to succeeded:

| job | what | latency |
|---|---|---|
| `a93ebc38` | 720p, 20s, first+last | **236s** |
| `e3dc498d` | 720p, 15s, first+last | **345s** |
| `d983edbc` | **480p**, 10s, first+last | **430s** |
| `a9dd50e9` | 1080p, 20s, first+last | **616s** |

The 480p ten-second job was **slower than the 720p twenty-second job**, by a
wide margin. Latency on this account is dominated by queueing, not by the
amount of pixels asked for, so **asking for less does not get an answer
sooner**. Only the 1080p job is clearly slow, and one sample is not a trend.

This is worth knowing because it inverts the obvious tactic. Dropping to 480p
to iterate faster buys nothing on time; it only buys money
(15s: $0.89 at 480p against $2.00 at 720p and $4.49 at 1080p), at the cost of
not being able to see detail — and on a brief whose first beat is "a single
festoon bulb", a bulb at 480p is one pixel.

## What the fast variants actually offer

From the provider capabilities this service already reports:

| provider | sizes | duration | start/end frames |
|---|---|---|---|
| `seedance-2-5` | 480p, 720p, 1080p | 4–30s | yes |
| `seedance-2-0` | 480p, 720p, 1080p, **4K** | 4–30s | yes |
| `seedance-2-0-fast` | 480p, 720p | 4–30s | yes |
| `seedance-2-0-mini` | 480p, 720p | 4–30s | yes |

Both fast variants keep `startEndFrames`, which is the capability this project's
transitions depend on. So they are usable for iteration. Two costs:

- **A different model is a different look.** Iterating choreography on 2.0-fast
  and rendering finals on 2.5 means tuning against something that is not the
  thing being bought. Useful for timing and blocking; not for judging the look.
- **Speed is claimed, not measured.** Nothing here has run a 2.0-fast job. The
  name is marketing until a job on this account proves it, and given that 480p
  came back slower than 720p, latency on this account should be assumed
  queue-bound until a measurement says otherwise.

## Recommendation

For iterating art direction, the cheapest *true* preview is still the
deterministic composite (`scripts/light_spread_blend.py`), which renders a full
10s pass in about a minute locally and costs nothing. Use the generative passes
for the look, not for the timing.

If a generative preview loop is wanted, the honest next step is **one measured
480p job on `seedance-2-0-fast`** to find out whether it is actually faster on
this account. One job, $0.59 or less, answers it; the docs will not.
