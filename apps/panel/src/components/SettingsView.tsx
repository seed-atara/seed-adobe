import { useEffect, useMemo, useState } from "react";
import type { SeedClient, SettingState } from "../api/client.ts";
import { SectionLabel } from "./primitives.tsx";

/**
 * Credentials, set from the panel.
 *
 * The service has always read keys from `.env`, which is right for whoever
 * built it and wrong for everyone else: it makes a text editor and a terminal
 * a prerequisite for using After Effects. This is the surface that removes
 * that, and it is deliberately a dialog rather than a tab — keys are something
 * you set on day one and then forget, not a place you work.
 *
 * Three things it refuses to do:
 *
 *   - **Show a key.** The service never sends one. A set secret renders as its
 *     last four characters, which is enough to answer "is that the right key"
 *     and useless to a screen recording.
 *   - **Pretend a save worked.** Saving returns the provider list the service
 *     rebuilt, so what appears is measured, not predicted.
 *   - **Hide where a value came from.** A key in `.env` and a key typed here
 *     are different things, and a panel value wins. Saying so is the whole
 *     difference between "the override is working" and "my edit did nothing".
 */

const GROUP_ORDER = [
  "Generating",
  "References",
  "Direction",
  "Premiere",
  "Hosting",
] as const;

const GROUP_BLURB: Record<(typeof GROUP_ORDER)[number], string> = {
  Generating: "The minimum for the panel to make anything at all.",
  References: "Optional. Lets a reference be sent by id rather than inline.",
  Direction: "Optional. Each one adds a button; without it nothing is offered.",
  Premiere: "Export presets. Premiere cannot ship these — they are made on your machine.",
  Hosting: "Needed only for video references — Ark refuses an inline clip.",
};

export function SettingsView({
  client,
  bridge,
  onClose,
  onProvidersChanged,
}: {
  client: SeedClient;
  /** Absent in a browser, where there is no host to open a file dialog. */
  bridge?: { pickPath(prompt: string, filter: string): Promise<string | undefined> };
  onClose: () => void;
  /** So the rest of the panel can re-read what is now available. */
  onProvidersChanged: () => void;
}) {
  const [settings, setSettings] = useState<SettingState[]>([]);
  const [storedAt, setStoredAt] = useState("");
  const [reloadable, setReloadable] = useState(true);
  /** Only what the artist actually typed — an untouched field is not sent. */
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await client.settings();
        if (cancelled) return;
        setSettings(result.settings);
        setStoredAt(result.storedAt);
        setReloadable(result.reloadable);
      } catch (cause) {
        if (!cancelled) setError(describe(cause));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client]);

  const grouped = useMemo(() => {
    return GROUP_ORDER.map((group) => ({
      group,
      rows: settings.filter((setting) => setting.group === group),
    })).filter((section) => section.rows.length > 0);
  }, [settings]);

  const dirty = Object.keys(edits).length > 0;

  function onChangeRow(key: string, next: string): void {
    setEdits((current) => {
      const copy = { ...current };
      // Typing and then clearing the box is not the same as asking to delete
      // the key — it is a cancelled edit.
      if (next === "") delete copy[key];
      else copy[key] = next;
      return copy;
    });
  }

  async function save() {
    setBusy(true);
    setError("");
    setSaved("");
    try {
      const result = await client.saveSettings(edits);
      setSettings(result.settings);
      setEdits({});
      setSaved(
        result.providers.length > 0
          ? `Saved. Available now: ${result.providers.join(", ")}.`
          : "Saved. No provider is configured yet — an Ark key and a Seedream model id are the two that matter.",
      );
      onProvidersChanged();
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="settings-backdrop" role="dialog" aria-label="Settings">
      <div className="settings-dialog">
        <div className="titlebar">
          <span className="label">Settings — keys and presets</span>
          <span className="controls">
            <button className="ctl" onClick={onClose} aria-label="Close">
              &times;
            </button>
          </span>
        </div>

        <div className="settings-body">
          {error ? <div className="notice error">{error}</div> : null}
          {saved ? <div className="notice">{saved}</div> : null}
          {!reloadable ? (
            <div className="notice">
              This service was started with a fixed provider set, so a save is
              stored but will not take effect until it restarts.
            </div>
          ) : null}

          <p className="settings-intro">
            Stored outside the project, in <code>{storedAt || "…"}</code>, so a
            workspace can be zipped and shared without the keys going with it.
            Anything set here overrides <code>.env</code>.
          </p>

          {grouped.map(({ group, rows }) => (
            <section key={group} className="settings-group">
              <SectionLabel>{group}</SectionLabel>
              <p className="settings-blurb">{GROUP_BLURB[group]}</p>
              {rows.map((row) => (
                <SettingRow
                  key={row.key}
                  setting={row}
                  value={edits[row.key]}
                  onChange={(next) => onChangeRow(row.key, next)}
                  onClear={() =>
                    setEdits((current) => ({ ...current, [row.key]: "" }))
                  }
                  clearing={edits[row.key] === ""}
                  {...(bridge && row.kind === "path"
                    ? {
                        onBrowse: async () => {
                          const picked = await bridge.pickPath(
                            `Choose the ${row.label.toLowerCase()}`,
                            row.filter ?? "All files:*.*",
                          );
                          if (picked) onChangeRow(row.key, picked);
                        },
                      }
                    : {})}
                />
              ))}
            </section>
          ))}
        </div>

        <div className="settings-actions">
          <button onClick={onClose}>Close</button>
          <button className="primary" disabled={!dirty || busy} onClick={() => void save()}>
            {busy ? "Saving…" : dirty ? `Save ${Object.keys(edits).length}` : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

function SettingRow({
  setting,
  value,
  onChange,
  onClear,
  clearing,
  onBrowse,
}: {
  setting: SettingState;
  value: string | undefined;
  onChange: (next: string) => void;
  onClear: () => void;
  clearing: boolean;
  /** Present only for file settings, and only inside a host. */
  onBrowse?: () => void | Promise<void>;
}) {
  const set = setting.source !== "unset";
  return (
    <label className="field settings-row">
      <span>
        {setting.label}
        <span className={`badge settings-source ${setting.source}`}>
          {setting.source === "panel"
            ? "set here"
            : setting.source === "env"
              ? "from .env"
              : "not set"}
        </span>
      </span>

      <input
        // A secret is masked; a model id is not. Masking a model id makes it
        // impossible to spot the typo that is the usual reason it is wrong.
        type={setting.secret ? "password" : "text"}
        value={value ?? ""}
        spellCheck={false}
        autoComplete="off"
        placeholder={
          clearing
            ? "will be cleared on save"
            : set
              ? `${setting.hint} — type to replace`
              : (setting.placeholder ?? "not set")
        }
        onChange={(event) => onChange(event.target.value)}
      />

      {onBrowse ? (
        <button
          type="button"
          className="settings-browse"
          onClick={() => void onBrowse()}
        >
          Choose a file…
        </button>
      ) : null}

      <span className="hint">
        {setting.help}
        {set && !clearing ? (
          <>
            {" "}
            <button type="button" className="linkish" onClick={onClear}>
              clear
            </button>
          </>
        ) : null}
      </span>
    </label>
  );
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
