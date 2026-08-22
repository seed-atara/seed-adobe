import { useMemo, useState } from "react";
import type { Asset } from "@seed-ae/domain";
import type { ExpandCoverage, SeedClient } from "../api/client.ts";
import { AssetImage, Field, SectionLabel } from "./primitives.tsx";

/**
 * Expand — a shot into another aspect, portrait to landscape and back.
 *
 * The order on screen is the argument. Every reframing tool on the market
 * starts by generating; this one starts by *measuring*, because on a shot that
 * moves most of the new edge was already photographed and paying a model to
 * imagine it is paying for a worse version of something you already own.
 *
 *   1. **Sample** the shot. Stills across the work area, straight out of the
 *      comp — the service has no decoder and does not need one.
 *   2. **Measure** how much of the wider frame the footage can pay for.
 *      Free, and it decides whether step 3 is worth anything.
 *   3. **Recover** those pixels into a plate, with a mask of what is left.
 *   4. **Generate** the remainder — the plate goes to Seedance as its first
 *      frame, which is what sets the output shape.
 *   5. **Assemble** in After Effects, with the original put back on top.
 *
 * Step 5 is the one no web tool can do, and it is what makes the whole thing
 * safe: only the invented margins reach the result, so the performance in the
 * middle of frame is untouched rather than re-rendered and hoped over.
 */

interface Props {
  client: SeedClient;
  activeProject?: string;
  onRefresh: () => Promise<void> | void;
  /** Samples the comp through the host. Absent outside After Effects. */
  onSample?: (count: number) => Promise<Asset[]>;
  /** Hands the plate to the Generate tab as an anchoring first frame. */
  onSendToGenerate?: (plate: Asset, aspect: string) => void;
  busy?: boolean;
}

/**
 * The aspects offered.
 *
 * Free text is accepted by the service, but a list is what an artist reaches
 * for — and these are the deliveries that actually get asked for.
 */
const ASPECTS = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"];

/**
 * Where the original sits in the wider frame.
 *
 * Not decoration. A pan that travels right has photographed the ground to the
 * right of frame one and nothing to the left, so pinning the source left can
 * take an expansion from half-recoverable to entirely recoverable — the
 * measurement below shows exactly that, and it is the reason this control is
 * next to the aspect rather than hidden in an advanced panel.
 */
const PLACEMENTS = [
  { id: "centre", label: "Centred" },
  { id: "left", label: "Pinned left" },
  { id: "right", label: "Pinned right" },
] as const;

type Placement = (typeof PLACEMENTS)[number]["id"];

function rectFor(
  placement: Placement,
  aspect: string,
  frame: { width: number; height: number },
): { x: number; y: number; width: number; height: number } | undefined {
  if (placement === "centre") return undefined;

  const [w, h] = aspect.split(":").map(Number);
  if (!w || !h) return undefined;
  const target = w / h;
  const current = frame.width / frame.height;
  // Only a widening leaves room to slide along; a taller canvas does not.
  if (current >= target) return undefined;

  const width = current / target;
  return {
    x: placement === "left" ? 0 : 1 - width,
    y: 0,
    width,
    height: 1,
  };
}

export function ExpandView({
  client,
  activeProject,
  onRefresh,
  onSample,
  onSendToGenerate,
  busy,
}: Props) {
  const [count, setCount] = useState(12);
  const [aspect, setAspect] = useState("16:9");
  const [placement, setPlacement] = useState<Placement>("centre");
  const [frames, setFrames] = useState<Asset[]>([]);
  const [coverage, setCoverage] = useState<
    { coverage: ExpandCoverage; verdict: string } | undefined
  >();
  const [recovered, setRecovered] = useState<
    { plate: Asset; residual: Asset; coverage: ExpandCoverage } | undefined
  >();
  const [note, setNote] = useState<string>();
  const [working, setWorking] = useState<string>();

  const shape = useMemo(
    () =>
      frames[0]?.width && frames[0]?.height
        ? { width: frames[0].width, height: frames[0].height }
        : undefined,
    [frames],
  );

  const rect = shape ? rectFor(placement, aspect, shape) : undefined;
  const frameIds = frames.map((frame) => frame.id);

  async function run(label: string, work: () => Promise<void>) {
    setWorking(label);
    setNote(undefined);
    try {
      await work();
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error));
    } finally {
      setWorking(undefined);
    }
  }

  const disabled = busy || working !== undefined;

  return (
    <section className="stack">
      <SectionLabel>1 — Sample the shot</SectionLabel>
      <p className="hint">
        Stills across the work area, in order. The tracker matches each to the
        one before it, so this needs a single continuous move — one shot, not a
        cut.
      </p>
      <div className="row">
        <Field label="Samples">
          <input
            type="number"
            min={2}
            max={60}
            value={count}
            onChange={(event) => setCount(Number(event.target.value))}
            disabled={disabled}
          />
        </Field>
        <button
          type="button"
          disabled={disabled || !onSample}
          onClick={() =>
            run("Sampling", async () => {
              const sampled = await onSample?.(count);
              setFrames(sampled ?? []);
              setCoverage(undefined);
              setRecovered(undefined);
              await onRefresh();
            })
          }
        >
          {working === "Sampling" ? "Sampling…" : "Sample work area"}
        </button>
      </div>
      {!onSample ? (
        <p className="hint">
          Sampling reads frames out of the open composition, so it needs After
          Effects. The rest of this works on any frames already in the library.
        </p>
      ) : null}
      {frames.length > 0 ? (
        <p className="hint">
          {frames.length} frames
          {shape ? `, ${shape.width}x${shape.height}` : ""} — sampled and in the
          library.
        </p>
      ) : null}

      <SectionLabel>2 — Measure what the footage can pay for</SectionLabel>
      <div className="row">
        <Field label="Aspect">
          <select
            value={aspect}
            onChange={(event) => setAspect(event.target.value)}
            disabled={disabled}
          >
            {ASPECTS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Original sits">
          <select
            value={placement}
            onChange={(event) => setPlacement(event.target.value as Placement)}
            disabled={disabled}
          >
            {PLACEMENTS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
        <button
          type="button"
          disabled={disabled || frameIds.length < 2}
          onClick={() =>
            run("Measuring", async () => {
              setCoverage(
                await client.expandCoverage({
                  frameAssetIds: frameIds,
                  aspect,
                  ...(rect ? { sourceRect: rect } : {}),
                }),
              );
            })
          }
        >
          {working === "Measuring" ? "Measuring…" : "Measure coverage"}
        </button>
      </div>
      {coverage ? <Coverage {...coverage} /> : null}

      <SectionLabel>3 — Recover the real pixels</SectionLabel>
      <p className="hint">
        Projects every sample into the wider canvas and takes a per-pixel
        median, so a subject walking through the background is outvoted rather
        than smeared. What comes back is a plate and a mask of what nobody
        photographed.
      </p>
      <button
        type="button"
        disabled={disabled || frameIds.length < 2}
        onClick={() =>
          run("Recovering", async () => {
            const result = await client.expandRecover({
              frameAssetIds: frameIds,
              aspect,
              ...(rect ? { sourceRect: rect } : {}),
              ...(activeProject ? { project: activeProject } : {}),
            });
            setRecovered(result);
            setCoverage({ coverage: result.coverage, verdict: result.verdict });
            await onRefresh();
          })
        }
      >
        {working === "Recovering" ? "Recovering…" : "Recover plate"}
      </button>

      {recovered ? (
        <>
          <div className="row">
            <figure className="stack">
              <AssetImage client={client} asset={recovered.plate} variant="thumbnail" />
              <figcaption className="hint">Recovered plate</figcaption>
            </figure>
            <figure className="stack">
              <AssetImage client={client} asset={recovered.residual} variant="thumbnail" />
              <figcaption className="hint">
                White is what has to be generated
              </figcaption>
            </figure>
          </div>

          <SectionLabel>4 — Generate the remainder</SectionLabel>
          <p className="hint">
            The plate goes to Seedance as the shot's <strong>first frame</strong>
            , which is what sets the output shape: Ark takes the ratio from the
            first frame and refuses a stated one. So a plate that is already
            {` ${aspect} `}
            is the instruction — and the model is finishing a picture rather
            than being asked to make one wider.
          </p>
          <button
            type="button"
            disabled={disabled || !onSendToGenerate}
            onClick={() => onSendToGenerate?.(recovered.plate, aspect)}
          >
            Send plate to Generate
          </button>

          <SectionLabel>5 — Assemble in After Effects</SectionLabel>
          <p className="hint">
            When the wide clip comes back, build the comp from the Library with
            the original composited back over it. Only the invented margins
            survive, so the performance in the middle of frame is untouched
            rather than re-rendered — which is the part no browser tool can do.
          </p>
        </>
      ) : null}

      {note ? <p className="error">{note}</p> : null}
    </section>
  );
}

/** The measurement, said in numbers and then in words. */
function Coverage({
  coverage,
  verdict,
}: {
  coverage: ExpandCoverage;
  verdict: string;
}) {
  const percent = Math.round(coverage.coverage * 100);
  const edges = Object.entries(coverage.edges).filter(([, value]) => value > 0.01);

  return (
    <div className="stack">
      <p>
        <strong>{percent}%</strong> of the new area is recoverable from the
        footage — {coverage.canvas.width}x{coverage.canvas.height} canvas, from{" "}
        {coverage.framesUsed} frames
        {coverage.framesRejected > 0
          ? ` (${coverage.framesRejected} too weak to match)`
          : ""}
        .
      </p>
      {edges.length > 0 ? (
        <p className="hint">
          {edges
            .map(([edge, value]) => `${edge} ${Math.round(value * 100)}%`)
            .join(" · ")}
        </p>
      ) : null}
      <p className="hint">{verdict}</p>
    </div>
  );
}
