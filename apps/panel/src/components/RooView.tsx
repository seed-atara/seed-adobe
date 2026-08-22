import { useEffect, useMemo, useState } from "react";
import type { Asset } from "@seed-ae/domain";
import type { CameraSignatureDto, MeasuredDto, SeedClient } from "../api/client.ts";
import { AssetImage, Field, SectionLabel } from "./primitives.tsx";

/**
 * ROO — switcharoo. Taking a shot apart, and putting it back together.
 *
 * The whole loop lives here, in the order it is used:
 *
 *   1. **Measure** depth and normals. Free, instant, offline, derived.
 *   2. **Generate** albedo and the rest. One generation each, and the only
 *      route that produces an albedo today.
 *   3. **Relight** from albedo and normals. Arithmetic; no model runs.
 *   4. **Match** another shot — solve its lighting and take its camera.
 *
 * Steps 1 and 2 are kept visibly apart throughout. An artist choosing between
 * a free measurement and a paid guess should know which one they are pressing,
 * and six identical buttons would hide exactly that.
 *
 * Step 4 is the part no single-image tool can do. Beeble relights one frame to
 * a light rig you author; here the lighting and the camera are *measured off a
 * second shot*, which is what "make these two cut together" actually asks for.
 */

interface PassPreset {
  kind: string;
  label: string;
  purpose: string;
  usableAsIdentity: boolean;
  prompt: string;
}

interface Props {
  client: SeedClient;
  assets: Asset[];
  selectedId?: string;
  onSelect: (id: string) => void;
  providers: Array<{ id: string; displayName: string }>;
  activeProject?: string;
  onRefresh: () => Promise<void> | void;
  busy?: boolean;
}

/** The passes that come from arithmetic rather than a provider. */
const MEASURED = new Set(["depth", "normal"]);

/**
 * A light direction from two angles rather than three numbers.
 *
 * Azimuth is where the light sits around the subject, elevation how high. An
 * artist can picture both; nobody can picture a normalised vector.
 */
function directionFrom(azimuth: number, elevation: number): { x: number; y: number; z: number } {
  const a = (azimuth * Math.PI) / 180;
  const e = (elevation * Math.PI) / 180;
  return {
    x: Math.cos(e) * Math.sin(a),
    // Screen space: +y is down, so a light above the subject is negative.
    y: -Math.sin(e),
    z: Math.cos(e) * Math.cos(a),
  };
}

/** One measured number, with how far to trust it said plainly. */
function Reading({ label, measured }: { label: string; measured?: MeasuredDto }) {
  if (!measured) return null;
  const trusted = measured.confidence >= 0.3;
  return (
    <div className="row" style={{ justifyContent: "space-between", fontSize: 11 }}>
      <span className={trusted ? undefined : "faint"}>{label}</span>
      <span className="mono">
        {measured.value.toFixed(3)}{" "}
        <span className="faint">
          {trusted ? `· ${(measured.confidence * 100).toFixed(0)}%` : "· not measurable here"}
        </span>
      </span>
    </div>
  );
}

export function RooView({
  client,
  assets,
  selectedId,
  onSelect,
  providers,
  activeProject,
  onRefresh,
  busy,
}: Props) {
  const [presets, setPresets] = useState<PassPreset[]>([]);
  const [chosen, setChosen] = useState<Set<string>>(new Set(["depth", "normal"]));
  const [lighting, setLighting] = useState("");
  const [strength, setStrength] = useState("4");
  const [providerId, setProviderId] = useState("");

  const [albedoId, setAlbedoId] = useState("");
  const [normalId, setNormalId] = useState("");
  const [roughnessId, setRoughnessId] = useState("");
  const [occlusionId, setOcclusionId] = useState("");

  const [azimuth, setAzimuth] = useState("-35");
  const [elevation, setElevation] = useState("35");
  const [ambient, setAmbient] = useState("0.25");
  const [specular, setSpecular] = useState("0.2");

  const [matchId, setMatchId] = useState("");
  const [matchAlbedoId, setMatchAlbedoId] = useState("");
  const [matchNormalId, setMatchNormalId] = useState("");
  const [matchAmount, setMatchAmount] = useState("1");
  const [camera, setCamera] = useState<{
    settings: Record<string, number>;
    skipped: string[];
    reference: CameraSignatureDto;
    target?: CameraSignatureDto;
    note: string;
  }>();

  const [derived, setDerived] = useState<Array<{ kind: string; asset: Asset }>>([]);
  const [note, setNote] = useState<string>();
  const [error, setError] = useState<string>();
  const [working, setWorking] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        setPresets((await client.passPresets()).presets);
      } catch {
        // The catalogue is a convenience; every button below still works.
      }
    })();
  }, [client]);

  useEffect(() => {
    if (!providerId && providers.length > 0) {
      const seedance = providers.find((item) => item.id.startsWith("seedance"));
      setProviderId((seedance ?? providers[0])?.id ?? "");
    }
  }, [providers, providerId]);

  const source = assets.find((asset) => asset.id === selectedId);

  /*
   * Passes are found by name. It is not elegant, but the alternative is asking
   * the artist to remember which of forty stills was the normal map, and the
   * derive route names what it writes.
   */
  const guess = (suffix: string): string | undefined =>
    assets.find(
      (asset) =>
        asset.kind === "image" &&
        asset.filename.toLowerCase().includes(suffix) &&
        (!source || asset.filename.startsWith(source.filename.replace(/\.[^.]+$/, ""))),
    )?.id;

  // Fill the recombine pickers from whatever exists, without overwriting a choice.
  useEffect(() => {
    if (!normalId) setNormalId(guess("_normal") ?? "");
    if (!albedoId) setAlbedoId(guess("albedo") ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assets, source?.id]);

  const stills = useMemo(
    () => assets.filter((asset) => asset.kind === "image"),
    [assets],
  );

  const measured = presets.filter((preset) => MEASURED.has(preset.kind));
  const asked = presets.filter((preset) => !MEASURED.has(preset.kind));

  const toggle = (kind: string) =>
    setChosen((current) => {
      const next = new Set(current);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });

  const run = async (what: string, action: () => Promise<string | undefined>) => {
    setWorking(true);
    setError(undefined);
    setNote(undefined);
    try {
      const message = await action();
      if (message) setNote(message);
      await onRefresh();
    } catch (cause) {
      setError(
        cause instanceof Error ? `${what}: ${cause.message}` : `${what}: ${String(cause)}`,
      );
    } finally {
      setWorking(false);
    }
  };

  const AssetPicker = ({
    label,
    hint,
    value,
    onChange,
    optional,
  }: {
    label: string;
    hint?: string;
    value: string;
    onChange: (id: string) => void;
    optional?: boolean;
  }) => (
    <Field label={label} {...(hint ? { hint } : {})}>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{optional ? "none" : "choose…"}</option>
        {stills.map((asset) => (
          <option key={asset.id} value={asset.id}>
            {asset.filename}
          </option>
        ))}
      </select>
    </Field>
  );

  return (
    <>
      {/* ---------------------------------------------------------- source */}
      <section className="section">
        <SectionLabel>1 · source</SectionLabel>
        <div className="hint faint" style={{ marginBottom: 6 }}>
          The shot to take apart. A clip is read through its poster frame.
        </div>
        {source ? (
          <div className="row" style={{ gap: 8, alignItems: "center" }}>
            <div style={{ width: 96 }}>
              <AssetImage client={client} asset={source} variant="thumbnail" />
            </div>
            <div className="mono" style={{ fontSize: 11 }}>
              {source.filename}
              <div className="faint">
                {source.width}x{source.height} · {source.kind}
              </div>
            </div>
          </div>
        ) : (
          <div className="notice">
            Nothing selected. Pick a shot in the library and come back.
          </div>
        )}
      </section>

      {/* -------------------------------------------------------- measured */}
      <section className="section">
        <SectionLabel>2 · measure — free, instant, offline</SectionLabel>
        <div className="hint faint" style={{ marginBottom: 6 }}>
          Depth comes from a real model running here, not from a provider.
          Normals are arithmetic on that depth, which makes them a measurement
          rather than a drawing. The first run downloads the weights.
        </div>

        {measured.map((preset) => (
          <label className="check" key={preset.kind} title={preset.purpose}>
            <input
              type="checkbox"
              checked={chosen.has(preset.kind)}
              onChange={() => toggle(preset.kind)}
            />
            {preset.label} — <span className="faint">{preset.purpose}</span>
          </label>
        ))}

        <div className="row" style={{ marginTop: 8 }}>
          <Field label="Relief" hint="normal map strength">
            <input
              type="number"
              min={0.25}
              max={16}
              step={0.5}
              value={strength}
              onChange={(event) => setStrength(event.target.value)}
            />
          </Field>
        </div>

        <button
          className="btn primary wide"
          disabled={busy || working || !source}
          style={{ marginTop: 8 }}
          onClick={() =>
            void run("Measuring", async () => {
              const kinds = [...chosen].filter((kind) => MEASURED.has(kind));
              if (kinds.length === 0) return "Choose depth or normals first.";
              const result = await client.derivePasses({
                sourceAssetId: source!.id,
                kinds: kinds as Array<"depth" | "normal">,
                strength: Number(strength) || 4,
                ...(activeProject ? { project: activeProject } : {}),
              });
              setDerived(result.made);
              for (const entry of result.made) {
                if (entry.kind === "normal") setNormalId(entry.asset.id);
              }
              return `Measured ${result.made.map((e) => e.kind).join(" and ")}. No cost.`;
            })
          }
        >
          {working ? "Working…" : "Measure passes"}
        </button>

        {derived.length > 0 ? (
          <div className="ref-strip" style={{ marginTop: 8 }}>
            {derived.map((entry) => (
              <div
                key={entry.asset.id}
                className="ref-card"
                onClick={() => onSelect(entry.asset.id)}
                title={entry.kind}
              >
                <AssetImage client={client} asset={entry.asset} variant="thumbnail" />
                <span className="ref-index mono">{entry.kind}</span>
              </div>
            ))}
          </div>
        ) : null}
      </section>

      {/* ------------------------------------------------------- generated */}
      <section className="section">
        <SectionLabel>3 · generate — one generation each</SectionLabel>
        <div className="hint faint" style={{ marginBottom: 6 }}>
          These come from the model, given your shot as a reference and a prompt
          insisting the result match it exactly. Albedo is the one worth having:
          surface colour with the lighting removed is the best identity plate
          there is, and the only input relighting needs that nothing else makes.
        </div>

        {asked.map((preset) => (
          <label className="check" key={preset.kind} title={preset.prompt}>
            <input
              type="checkbox"
              checked={chosen.has(preset.kind)}
              onChange={() => toggle(preset.kind)}
            />
            {preset.label}
            {preset.usableAsIdentity ? <b> · identity plate</b> : null} —{" "}
            <span className="faint">{preset.purpose}</span>
          </label>
        ))}

        {chosen.has("relight") ? (
          <Field label="Light" hint="describe the lighting you want">
            <input
              type="text"
              value={lighting}
              placeholder="hard low sun from the left, long shadows"
              onChange={(event) => setLighting(event.target.value)}
            />
          </Field>
        ) : null}

        <Field label="Provider">
          <select value={providerId} onChange={(event) => setProviderId(event.target.value)}>
            {providers.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.displayName}
              </option>
            ))}
          </select>
        </Field>

        <button
          className="btn wide"
          disabled={busy || working || !source || !providerId}
          style={{ marginTop: 8 }}
          onClick={() =>
            void run("Generating", async () => {
              const kinds = [...chosen].filter((kind) => !MEASURED.has(kind));
              if (kinds.length === 0) return "Choose albedo, specular, occlusion or relight.";
              const { started } = await client.startPasses({
                sourceAssetId: source!.id,
                kinds,
                providerId,
                ...(lighting ? { lighting } : {}),
                ...(activeProject ? { project: activeProject } : {}),
              });
              return `Started ${started.length} pass${started.length === 1 ? "" : "es"}. They arrive in the library like any other generation.`;
            })
          }
        >
          Generate passes
        </button>
      </section>

      {/* --------------------------------------------------------- relight */}
      <section className="section">
        <SectionLabel>4 · relight — arithmetic, no model</SectionLabel>
        <div className="hint faint" style={{ marginBottom: 6 }}>
          Albedo lit by your own key. Instant and free — nothing generates here.
        </div>

        <AssetPicker
          label="Albedo"
          hint="surface colour, lighting removed"
          value={albedoId}
          onChange={setAlbedoId}
        />
        <AssetPicker label="Normals" value={normalId} onChange={setNormalId} />
        <AssetPicker label="Roughness" value={roughnessId} onChange={setRoughnessId} optional />
        <AssetPicker label="Occlusion" value={occlusionId} onChange={setOcclusionId} optional />

        <div className="row">
          <Field label="Azimuth" hint="degrees around the subject">
            <input
              type="number"
              step={5}
              value={azimuth}
              onChange={(event) => setAzimuth(event.target.value)}
            />
          </Field>
          <Field label="Elevation" hint="degrees above">
            <input
              type="number"
              step={5}
              value={elevation}
              onChange={(event) => setElevation(event.target.value)}
            />
          </Field>
        </div>
        <div className="row">
          <Field label="Ambient" hint="light from everywhere">
            <input
              type="number"
              step={0.05}
              min={0}
              max={2}
              value={ambient}
              onChange={(event) => setAmbient(event.target.value)}
            />
          </Field>
          <Field label="Specular" hint="highlight strength">
            <input
              type="number"
              step={0.05}
              min={0}
              max={2}
              value={specular}
              onChange={(event) => setSpecular(event.target.value)}
            />
          </Field>
        </div>

        <button
          className="btn primary wide"
          disabled={busy || working || !albedoId || !normalId}
          style={{ marginTop: 8 }}
          onClick={() =>
            void run("Relighting", async () => {
              const { asset } = await client.relightPasses({
                albedoAssetId: albedoId,
                normalAssetId: normalId,
                ...(roughnessId ? { roughnessAssetId: roughnessId } : {}),
                ...(occlusionId ? { occlusionAssetId: occlusionId } : {}),
                light: directionFrom(Number(azimuth) || 0, Number(elevation) || 0),
                ambient: Number(ambient) || 0,
                specular: Number(specular) || 0,
                ...(activeProject ? { project: activeProject } : {}),
              });
              onSelect(asset.id);
              return `Relit into ${asset.filename}.`;
            })
          }
        >
          Relight
        </button>
      </section>

      {/* ----------------------------------------------------------- match */}
      <section className="section">
        <SectionLabel>5 · match another shot</SectionLabel>
        <div className="hint faint" style={{ marginBottom: 6 }}>
          The part a single image cannot do. The lighting and the camera are
          <b> measured off a reference shot</b> rather than described by you —
          which is what "make these two cut together" actually asks for.
        </div>

        <AssetPicker
          label="Reference shot"
          hint="the look to match"
          value={matchId}
          onChange={setMatchId}
        />

        <button
          className="btn wide"
          disabled={busy || working || !matchId}
          style={{ marginTop: 4 }}
          onClick={() =>
            void run("Reading the camera", async () => {
              const result = await client.transferCamera({
                referenceAssetId: matchId,
                ...(source ? { targetAssetId: source.id } : {}),
              });
              setCamera(result);
              return undefined;
            })
          }
        >
          Read its camera
        </button>

        {camera ? (
          <div style={{ marginTop: 8 }}>
            <div className="hint faint">{camera.note}</div>
            <div style={{ marginTop: 6 }}>
              <Reading label="Vignette" measured={camera.reference.vignette} />
              <Reading label="Aberration" measured={camera.reference.aberration} />
              <Reading label="Grain" measured={camera.reference.grain} />
              <Reading label="Grain size" measured={camera.reference.grainSize} />
              <Reading label="Halation" measured={camera.reference.halation} />
            </div>
            {Object.keys(camera.settings).length > 0 ? (
              <>
                <div className="hint faint" style={{ marginTop: 8 }}>
                  Film look settings — set these on a SEED Film Look effect:
                </div>
                <pre
                  className="mono"
                  style={{ fontSize: 11, whiteSpace: "pre-wrap", margin: "4px 0 0" }}
                >
                  {Object.entries(camera.settings)
                    .map(([name, value]) => `${name} = ${value}`)
                    .join("\n")}
                </pre>
              </>
            ) : null}
            {camera.skipped.length > 0 ? (
              <div className="hint faint" style={{ marginTop: 6 }}>
                Not measurable from these frames:
                <ul style={{ margin: "2px 0 0 14px", padding: 0 }}>
                  {camera.skipped.map((entry) => (
                    <li key={entry}>{entry}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="hint faint" style={{ marginTop: 10 }}>
          Transferring its <b>lighting</b> needs an albedo and normals for both
          shots — the reference's, to solve what lit it, and this shot's, to
          light it the same way.
        </div>
        <AssetPicker
          label="Reference albedo"
          value={matchAlbedoId}
          onChange={setMatchAlbedoId}
        />
        <AssetPicker
          label="Reference normals"
          value={matchNormalId}
          onChange={setMatchNormalId}
        />
        <Field label="Amount" hint="0–1; a full transfer imposes its key outright">
          <input
            type="number"
            step={0.1}
            min={0}
            max={1}
            value={matchAmount}
            onChange={(event) => setMatchAmount(event.target.value)}
          />
        </Field>

        <button
          className="btn wide"
          disabled={
            busy || working || !matchId || !matchAlbedoId || !matchNormalId || !albedoId || !normalId
          }
          onClick={() =>
            void run("Transferring light", async () => {
              const result = await client.transferLight({
                referenceAssetId: matchId,
                referenceAlbedoId: matchAlbedoId,
                referenceNormalId: matchNormalId,
                targetAlbedoId: albedoId,
                targetNormalId: normalId,
                amount: Number(matchAmount) || 1,
                ...(activeProject ? { project: activeProject } : {}),
              });
              onSelect(result.asset.id);
              return `${result.note} Solved from ${result.samples} samples, residual ${result.residual}.`;
            })
          }
        >
          Transfer its lighting
        </button>
      </section>

      {note ? <div className="notice">{note}</div> : null}
      {error ? <div className="notice error">{error}</div> : null}
    </>
  );
}
