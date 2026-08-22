import { useEffect, useState } from "react";
import type { Asset } from "@seed-ae/domain";
import type { SeedClient } from "../api/client.ts";
import { AssetImage, Field, SectionLabel } from "./primitives.tsx";

/**
 * ROO — switcharoo. Taking a shot apart and putting it back together.
 *
 * Two very different ways of getting a pass sit side by side here, and the
 * distinction is the honest part of this screen:
 *
 *   **Measured** — depth comes from a real model running locally, and normals
 *   are arithmetic on that depth. Free, instant, offline, and correct in the
 *   sense that it is derived rather than imagined.
 *
 *   **Asked for** — albedo, specular, occlusion and a relight come from
 *   Seedance, given the plate as a reference and a prompt insisting the result
 *   match it exactly. This costs a generation each and can drift, but it is
 *   the only route that produces albedo today.
 *
 * The panel says which is which rather than presenting six equal buttons,
 * because an artist choosing between a free measurement and a paid guess
 * should know which one they are pressing.
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
  onUseAsPlate?: (asset: Asset) => void;
  busy?: boolean;
}

/** The passes that come from arithmetic rather than a provider. */
const MEASURED = new Set(["depth", "normal"]);

export function RooView({
  client,
  assets,
  selectedId,
  onSelect,
  providers,
  activeProject,
  onRefresh,
  onUseAsPlate,
  busy,
}: Props) {
  const [presets, setPresets] = useState<PassPreset[]>([]);
  const [chosen, setChosen] = useState<Set<string>>(new Set(["depth", "normal"]));
  const [lighting, setLighting] = useState("");
  const [strength, setStrength] = useState("4");
  const [providerId, setProviderId] = useState("");
  const [derived, setDerived] = useState<Array<{ kind: string; asset: Asset }>>([]);
  const [note, setNote] = useState<string>();
  const [error, setError] = useState<string>();
  const [working, setWorking] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const { presets: list } = await client.passPresets();
        setPresets(list);
      } catch {
        // The catalogue is a convenience; the buttons below still work.
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
  const measured = presets.filter((preset) => MEASURED.has(preset.kind));
  const asked = presets.filter((preset) => !MEASURED.has(preset.kind));

  const toggle = (kind: string) => {
    setChosen((current) => {
      const next = new Set(current);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  };

  const report = (cause: unknown) => {
    setError(cause instanceof Error ? cause.message : String(cause));
  };

  /** Depth and normals, here and now. */
  const derive = async () => {
    if (!source) return;
    setWorking(true);
    setError(undefined);
    setNote(undefined);
    try {
      const kinds = [...chosen].filter((kind) => MEASURED.has(kind));
      if (kinds.length === 0) {
        setNote("Choose depth or normals — the rest are generated, below.");
        return;
      }
      const result = await client.derivePasses({
        sourceAssetId: source.id,
        kinds: kinds as Array<"depth" | "normal">,
        strength: Number(strength) || 4,
        ...(activeProject ? { project: activeProject } : {}),
      });
      setDerived(result.made);
      await onRefresh();
      setNote(
        `Measured ${result.made.map((entry) => entry.kind).join(" and ")} from ` +
          `${source.filename}. No generation, no cost.`,
      );
    } catch (cause) {
      report(cause);
    } finally {
      setWorking(false);
    }
  };

  /** Albedo and the rest, from the provider. */
  const request = async () => {
    if (!source || !providerId) return;
    setWorking(true);
    setError(undefined);
    setNote(undefined);
    try {
      const kinds = [...chosen].filter((kind) => !MEASURED.has(kind));
      if (kinds.length === 0) {
        setNote("Choose albedo, specular, occlusion or relight first.");
        return;
      }
      const { started } = await client.startPasses({
        sourceAssetId: source.id,
        kinds,
        providerId,
        ...(lighting ? { lighting } : {}),
        ...(activeProject ? { project: activeProject } : {}),
      });
      setNote(
        `Started ${started.length} pass${started.length === 1 ? "" : "es"}. ` +
          "They arrive in the library like any other generation.",
      );
    } catch (cause) {
      report(cause);
    } finally {
      setWorking(false);
    }
  };

  return (
    <>
      <section className="section">
        <SectionLabel>source</SectionLabel>
        <div className="hint faint" style={{ marginBottom: 6 }}>
          Pick the shot to take apart. A clip is read through its poster frame.
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
            Nothing selected. Choose a shot in the library and come back.
          </div>
        )}
      </section>

      <section className="section">
        <SectionLabel>measured — free, instant, offline</SectionLabel>
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
          onClick={() => void derive()}
          disabled={busy || working || !source}
          style={{ marginTop: 8 }}
        >
          {working ? "Measuring…" : "Measure passes"}
        </button>
      </section>

      <section className="section">
        <SectionLabel>asked for — one generation each</SectionLabel>
        <div className="hint faint" style={{ marginBottom: 6 }}>
          These come from the model, given your shot as a reference and a prompt
          insisting the result match it exactly. Albedo is the one worth having:
          surface colour with the lighting removed makes the best identity plate
          there is.
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
          onClick={() => void request()}
          disabled={busy || working || !source || !providerId}
          style={{ marginTop: 8 }}
        >
          Generate passes
        </button>
      </section>

      {derived.length > 0 ? (
        <section className="section">
          <SectionLabel>measured just now</SectionLabel>
          <div className="ref-strip">
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
          {onUseAsPlate ? (
            <div className="hint faint" style={{ marginTop: 6 }}>
              Select an albedo in the library and use it as an identity plate on
              an item — lighting removed is what stops a plate teaching the model
              the lamp along with the face.
            </div>
          ) : null}
        </section>
      ) : null}

      {note ? <div className="notice">{note}</div> : null}
      {error ? <div className="notice danger">{error}</div> : null}
    </>
  );
}
