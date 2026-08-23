import { useMemo, useState } from "react";
import type { Asset } from "@seed-ae/domain";
import type { ExpandCoverage, SeedClient } from "../api/client.ts";
import { AssetImage, Field, SectionLabel } from "./primitives.tsx";

/** A sampled shot: scratch stills on disk, plus the shape they were taken at. */
export interface SampledShot {
  paths: string[];
  /** When each sample was taken, in seconds — the plate's keyframe times. */
  times?: number[];
  width: number;
  height: number;
}

/**
 * Expand — a shot into another aspect, portrait or square to landscape.
 *
 * **Generating is the front door.** An earlier version led with measurement:
 * sample the shot, track it, see how much of the new edge the footage could
 * pay for, and only then generate. That is the right order for a locked-off
 * pan, and the wrong order for everything else — most shots do not travel far
 * enough sideways for recovery to matter, and a shot with parallax (a dolly,
 * most handheld) cannot be recovered at all. Leading with it made the common
 * case slow, and made a low number look like a failure rather than an answer.
 *
 * So: press one button and get an expanded shot. The frame is cropped out of
 * whatever padding the delivery carries, placed in the new canvas, and handed
 * to Seedance with a prompt that names the margins and says the middle must not
 * move. Recovery is still here, underneath, for the shots that earn it.
 */

interface Props {
  client: SeedClient;
  activeProject?: string;
  onRefresh: () => Promise<void> | void;
  /**
   * Samples the comp through the host. Absent outside After Effects.
   *
   * Returns scratch file paths rather than assets: these frames exist to be
   * measured, and putting a dozen of them in the library per attempt buries the
   * work the artist came for.
   */
  onSample?: (count: number) => Promise<SampledShot>;
  /** Hands the plate to the Generate tab as an anchoring first frame. */
  /**
   * Fills the plate's empty margins and returns the finished frame.
   *
   * Runs here rather than handing the artist over to the Generate tab: the
   * result has to come back to build the comp with, and a round trip through
   * another view loses it.
   */
  onFill?: (input: {
    plate: Asset;
    prompt: string;
    size: { width: number; height: number };
  }) => Promise<Asset>;
  /**
   * Builds the comp: the plate animated along the shot's track, original over.
   *
   * Absent outside After Effects. This is the step no browser tool can do, and
   * the one that makes the expansion safe — only the invented margins survive.
   */
  onAssemble?: (input: {
    plate: Asset;
    delivery: { width: number; height: number };
    world: { width: number; height: number };
    windows: Array<{ frame: number; x: number; y: number; time?: number }>;
    rect: { x: number; y: number; width: number; height: number };
  }) => Promise<{ compName: string; keyframes: number }>;
  busy?: boolean;
}

const ASPECTS = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"];

/**
 * Where the original sits in the wider frame.
 *
 * Kept because it is the one control that changes what the footage can pay for
 * when recovery *is* used — a pan that travels right has photographed the
 * ground to the right of frame one and nothing to the left.
 */
const PLACEMENTS = [
  { id: "centre", label: "Centred" },
  { id: "left", label: "Pinned left" },
  { id: "right", label: "Pinned right" },
] as const;

type Placement = (typeof PLACEMENTS)[number]["id"];

function aspectValue(aspect: string): number | undefined {
  const [w, h] = aspect.split(":").map(Number);
  return w && h ? w / h : undefined;
}

/** The canvas an aspect implies. Mirrors `canvasFor` on the service. */
function canvasFor(
  frame: { width: number; height: number },
  aspect: string,
): { width: number; height: number } | undefined {
  const target = aspectValue(aspect);
  if (!target) return undefined;
  const current = frame.width / frame.height;
  if (Math.abs(current - target) < 1e-6) return { ...frame };
  return current < target
    ? { width: Math.round(frame.height * target), height: frame.height }
    : { width: frame.width, height: Math.round(frame.width / target) };
}

function rectFor(
  placement: Placement,
  aspect: string,
  frame: { width: number; height: number },
) {
  const canvas = canvasFor(frame, aspect);
  if (!canvas || canvas.width === frame.width) return undefined;
  const width = frame.width / canvas.width;
  if (placement === "centre") return undefined;
  return { x: placement === "left" ? 0 : 1 - width, y: 0, width, height: 1 };
}

/**
 * The shape of the job, drawn.
 *
 * Two boxes: what the frame is, and what it has to become. It replaces a
 * paragraph of arithmetic, and it makes the placement control mean something
 * before anything has been measured.
 */
function ShapePreview({
  frame,
  aspect,
  placement,
}: {
  frame: { width: number; height: number };
  aspect: string;
  placement: Placement;
}) {
  const canvas = canvasFor(frame, aspect);
  if (!canvas) return null;

  const scale = 180 / canvas.width;
  const outer = { width: canvas.width * scale, height: canvas.height * scale };
  const inner = { width: frame.width * scale, height: frame.height * scale };
  const left =
    placement === "left"
      ? 0
      : placement === "right"
        ? outer.width - inner.width
        : (outer.width - inner.width) / 2;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "6px 0" }}>
      <div
        style={{
          position: "relative",
          width: outer.width,
          height: outer.height,
          border: "1px solid #888",
          background:
            "repeating-linear-gradient(45deg,#e8e8e8,#e8e8e8 4px,#dcdcdc 4px,#dcdcdc 8px)",
        }}
      >
        <div
          style={{
            position: "absolute",
            left,
            top: (outer.height - inner.height) / 2,
            width: inner.width,
            height: inner.height,
            background: "#3a3a3a",
            border: "1px solid #222",
          }}
        />
      </div>
      <div className="hint">
        {frame.width}×{frame.height} → {canvas.width}×{canvas.height}
        <br />
        the hatched margins are what gets generated
      </div>
    </div>
  );
}

export function ExpandView({
  client,
  activeProject,
  onRefresh,
  onSample,
  onFill,
  onAssemble,
  busy,
}: Props) {
  const [aspect, setAspect] = useState("16:9");
  const [placement, setPlacement] = useState<Placement>("centre");
  const [shape, setShape] = useState<{ width: number; height: number }>();
  const [plate, setPlate] = useState<
    | {
        plate: Asset;
        residual: Asset;
        prompt: string;
        delivery: { width: number; height: number };
        world: { width: number; height: number };
        windows: Array<{ frame: number; x: number; y: number; time?: number }>;
        rect: { x: number; y: number; width: number; height: number };
      }
    | undefined
  >();

  const [count, setCount] = useState(12);
  const [frames, setFrames] = useState<SampledShot | undefined>();
  const [coverage, setCoverage] = useState<
    { coverage: ExpandCoverage; verdict: string } | undefined
  >();
  const [recovered, setRecovered] = useState<
    { plate: Asset; residual: Asset; coverage: ExpandCoverage; prompt: string } | undefined
  >();
  const [showRecovery, setShowRecovery] = useState(false);
  /** The plate with its margins filled — what the comp is actually built from. */
  const [filled, setFilled] = useState<Asset>();

  const [note, setNote] = useState<string>();
  const [working, setWorking] = useState<string>();
  const disabled = busy || working !== undefined;
  const framePaths = frames?.paths ?? [];

  const rect = useMemo(
    () => (shape ? rectFor(placement, aspect, shape) : undefined),
    [placement, aspect, shape],
  );

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

  /**
   * The whole simple path, in one press.
   *
   * One frame is enough: nothing is being tracked, so the plate is the picture
   * placed in the new canvas with the margins left empty for the model. The
   * padding a delivery carries is found and cropped on the service side, which
   * is why a square shot inside an HD file behaves like a square shot.
   */
  const expandNow = () =>
    run("Expanding", async () => {
      /*
       * The whole shot, not one frame of it. The plate has to hold everywhere
       * the camera went, and the track is what lets the comp move it in step —
       * a single still would have to be generated into a clip, and the model's
       * invented camera move is exactly what drifts against the original.
       */
      const sampled = await onSample?.(count);
      if (!sampled) return;
      setFrames(sampled);
      setShape({ width: sampled.width, height: sampled.height });

      const result = await client.expandRecover({
        framePaths: sampled.paths,
        aspect,
        ...(rect ? { sourceRect: rect } : {}),
        ...(activeProject ? { project: activeProject } : {}),
      });

      const windows = result.windows.map((window) => ({
        ...window,
        ...(sampled.times?.[window.frame] !== undefined
          ? { time: sampled.times[window.frame] as number }
          : {}),
      }));
      const source = result.coverage.source;
      setPlate({
        plate: result.plate,
        residual: result.residual,
        prompt: result.suggestedPrompt,
        delivery: result.delivery,
        world: result.coverage.canvas,
        windows,
        rect: {
          x: source.x / result.delivery.width,
          y: source.y / result.delivery.height,
          width: source.width / result.delivery.width,
          height: source.height / result.delivery.height,
        },
      });
      setCoverage({ coverage: result.coverage, verdict: result.verdict });
      setFilled(undefined);
      await onRefresh();
    });

  return (
    <>
      <SectionLabel>Expand to</SectionLabel>
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
      </div>

      {shape ? (
        <ShapePreview frame={shape} aspect={aspect} placement={placement} />
      ) : null}

      <button
        type="button"
        className="primary"
        disabled={disabled || !onSample}
        onClick={expandNow}
      >
        {working === "Expanding" ? "Preparing…" : `Expand to ${aspect}`}
      </button>
      {!onSample ? (
        <p className="hint">This reads the open composition, so it needs After Effects.</p>
      ) : null}

      {plate ? (
        <>
          <div style={{ display: "flex", gap: 8, margin: "8px 0" }}>
            <figure style={{ margin: 0 }}>
              <AssetImage
                client={client}
                asset={filled ?? plate.plate}
                variant="thumbnail"
              />
              <figcaption className="hint">
                {filled ? "Filled — ready to comp" : "Plate — the model fills the margins"}
              </figcaption>
            </figure>
          </div>
          <Field label="Prompt">
            <textarea
              rows={4}
              value={plate.prompt}
              onChange={(event) =>
                setPlate({ ...plate, prompt: event.target.value })
              }
              disabled={disabled}
            />
          </Field>
          <div className="row">
            <button
              type="button"
              className="primary"
              disabled={disabled || !onFill || filled !== undefined}
              onClick={() =>
                run("Filling", async () => {
                  const result = await onFill?.({
                    plate: plate.plate,
                    prompt: plate.prompt,
                    size: plate.world,
                  });
                  if (result) setFilled(result);
                  await onRefresh();
                })
              }
            >
              {working === "Filling"
                ? "Filling…"
                : filled
                  ? "Margins filled"
                  : "Fill the margins"}
            </button>
            <button
              type="button"
              disabled={disabled || !onAssemble || !filled}
              onClick={() =>
                run("Assembling", async () => {
                  const built = await onAssemble?.({
                    // The filled plate, not the one with holes in it.
                    plate: filled as Asset,
                    delivery: plate.delivery,
                    world: plate.world,
                    windows: plate.windows,
                    rect: plate.rect,
                  });
                  if (built) {
                    setNote(
                      `Built "${built.compName}" — plate tracked over ${built.keyframes} keyframes.`,
                    );
                  }
                })
              }
            >
              {working === "Assembling" ? "Building…" : "Build comp"}
            </button>
          </div>

          <p className="hint">
            The plate is {plate.world.width}×{plate.world.height} against a{" "}
            {plate.delivery.width}×{plate.delivery.height} delivery — wider, because it
            holds everywhere the camera went. <strong>Build comp now</strong> animates it
            along the shot's own track with the original fixed over the top, so the
            margins travel exactly as far as the picture does.
          </p>
          <p className="hint">
            The plate goes as the shot's <strong>first frame</strong>, which is what
            sets the output shape. When the wide clip comes back, build the comp with
            the original composited over it — only the invented margins survive, so
            the middle of frame is untouched rather than re-rendered.
          </p>
        </>
      ) : null}

      {note ? <p className="hint">{note}</p> : null}

      <hr style={{ margin: "16px 0", border: 0, borderTop: "1px solid #bbb" }} />

      <button
        type="button"
        onClick={() => setShowRecovery((open) => !open)}
        disabled={disabled}
      >
        {showRecovery ? "Hide" : "Recover real pixels first (advanced)"}
      </button>
      <p className="hint">
        Worth it only when the camera <em>pans or tilts</em> far enough that the new
        edge was genuinely photographed. A dolly or a handheld drift cannot be
        recovered — the camera saw different geometry, not the same scene shifted —
        and the measurement will say so.
      </p>

      {showRecovery ? (
        <>
          <SectionLabel>1 — Sample the shot</SectionLabel>
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
                  setFrames(sampled);
                  if (sampled) setShape({ width: sampled.width, height: sampled.height });
                  setCoverage(undefined);
                  setRecovered(undefined);
                })
              }
            >
              {working === "Sampling" ? "Sampling…" : "Sample work area"}
            </button>
          </div>
          {framePaths.length > 0 ? (
            <p className="hint">
              {framePaths.length} frames — scratch, not added to the library.
            </p>
          ) : null}

          <SectionLabel>2 — Measure what the footage can pay for</SectionLabel>
          <button
            type="button"
            disabled={disabled || framePaths.length < 2}
            onClick={() =>
              run("Measuring", async () => {
                const result = await client.expandCoverage({
                  framePaths,
                  aspect,
                  ...(rect ? { sourceRect: rect } : {}),
                });
                setCoverage(result);
              })
            }
          >
            {working === "Measuring" ? "Measuring…" : "Measure coverage"}
          </button>

          {coverage ? (
            <>
              <p>
                <strong>
                  {Math.round(coverage.coverage.coverage * 100)}% of the new area is
                  recoverable
                </strong>{" "}
                — {coverage.coverage.canvas.width}×{coverage.coverage.canvas.height},
                from {coverage.coverage.framesUsed} frames
                {coverage.coverage.framesRejected > 0
                  ? ` (${coverage.coverage.framesRejected} too weak to match)`
                  : ""}
                .
              </p>
              <p className="hint">{coverage.verdict}</p>
            </>
          ) : null}

          <SectionLabel>3 — Recover</SectionLabel>
          <button
            type="button"
            disabled={disabled || framePaths.length < 2}
            onClick={() =>
              run("Recovering", async () => {
                const result = await client.expandRecover({
                  framePaths,
                  aspect,
                  ...(rect ? { sourceRect: rect } : {}),
                  ...(activeProject ? { project: activeProject } : {}),
                });
                setRecovered({
                  plate: result.plate,
                  residual: result.residual,
                  coverage: result.coverage,
                  prompt: result.suggestedPrompt,
                });
                await onRefresh();
              })
            }
          >
            {working === "Recovering" ? "Recovering…" : "Recover plate"}
          </button>

          {recovered ? (
            <>
              <div style={{ display: "flex", gap: 8, margin: "8px 0" }}>
                <figure style={{ margin: 0 }}>
                  <AssetImage client={client} asset={recovered.plate} variant="thumbnail" />
                  <figcaption className="hint">Recovered plate</figcaption>
                </figure>
                <figure style={{ margin: 0 }}>
                  <AssetImage
                    client={client}
                    asset={recovered.residual}
                    variant="thumbnail"
                  />
                  <figcaption className="hint">White is still generated</figcaption>
                </figure>
              </div>
              <button
                type="button"
                disabled={disabled || !onFill}
                onClick={() =>
                  run("Filling", async () => {
                    const result = await onFill?.({
                      plate: recovered.plate,
                      prompt: recovered.prompt,
                      size: {
                        width: recovered.coverage.canvas.width,
                        height: recovered.coverage.canvas.height,
                      },
                    });
                    if (result) setFilled(result);
                    await onRefresh();
                  })
                }
              >
                Fill the recovered plate
              </button>
            </>
          ) : null}
        </>
      ) : null}
    </>
  );
}
