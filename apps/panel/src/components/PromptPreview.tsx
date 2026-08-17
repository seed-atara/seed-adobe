import { useEffect, useRef, useState } from "react";
import type { Item, ItemMention, ResolvedBundle } from "@seed-ae/domain";
import type { SeedClient } from "../api/client.ts";
import { SectionLabel } from "./primitives.tsx";

/**
 * What the prompt will actually send.
 *
 * The direct answer to "the important parts get blurry and hard to control".
 * Everything an item adds is shown, attributed to the handle that added it, and
 * adjustable in place — nothing an item contributes to a prompt is invisible or
 * unremovable. That is the part that decides whether artists trust this at all.
 */

interface Props {
  client: SeedClient;
  prompt: string;
  providerId: string;
  mentions: ItemMention[];
  items: Item[];
  attachedAssetIds: string[];
  attachedRoles?: Array<"first" | "last" | "reference">;
  allowBeyondStable: boolean;
  onMentionsChange: (mentions: ItemMention[]) => void;
  onAllowBeyondStable: (allow: boolean) => void;
}

export function PromptPreview({
  client,
  prompt,
  providerId,
  mentions,
  items,
  attachedAssetIds,
  attachedRoles,
  allowBeyondStable,
  onMentionsChange,
  onAllowBeyondStable,
}: Props) {
  const [bundle, setBundle] = useState<ResolvedBundle | undefined>();
  const [open, setOpen] = useState(true);
  const latest = useRef(0);

  /*
   * Debounced: resolution is a round trip and this runs while the artist is
   * typing. Cheap on the service — no provider is called — but a request per
   * keystroke would still be silly.
   */
  useEffect(() => {
    if (mentions.length === 0) {
      setBundle(undefined);
      return;
    }
    const token = ++latest.current;
    const timer = setTimeout(() => {
      void client
        .resolvePrompt({
          prompt,
          providerId,
          itemMentions: mentions,
          attachedAssetIds,
          ...(attachedRoles ? { attachedRoles } : {}),
          allowBeyondStable,
        })
        .then((result) => {
          // Ignore a reply that a later keystroke has already superseded.
          if (token === latest.current) setBundle(result.bundle);
        })
        .catch(() => {
          if (token === latest.current) setBundle(undefined);
        });
    }, 250);
    return () => clearTimeout(timer);
  }, [
    client,
    prompt,
    providerId,
    JSON.stringify(mentions),
    JSON.stringify(attachedAssetIds),
    JSON.stringify(attachedRoles),
    allowBeyondStable,
  ]);

  if (mentions.length === 0) return null;

  const update = (itemId: string, patch: Partial<ItemMention>) => {
    onMentionsChange(
      mentions.map((mention) =>
        mention.itemId === itemId ? { ...mention, ...patch } : mention,
      ),
    );
  };

  const overStable =
    bundle !== undefined && bundle.budget.referencesUsed > bundle.budget.referencesStable;

  return (
    <div className="promptPreview">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <SectionLabel>What will be sent</SectionLabel>
        <button className="btn" onClick={() => setOpen(!open)}>
          {open ? "Hide" : "Show"}
        </button>
      </div>

      {bundle ? (
        <>
          <div className="row" style={{ gap: 8, marginBottom: 6 }}>
            <span className="badge">
              {bundle.budget.referencesUsed}/{bundle.budget.referencesStable} refs
            </span>
            <span className="badge">{bundle.budget.promptWords} words</span>
            {overStable ? <span className="badge warn">beyond stable range</span> : null}
          </div>

          {open ? (
            <pre className="promptOut">{bundle.prompt}</pre>
          ) : null}

          {bundle.negativePrompt ? (
            <p className="hint">
              <b>Avoid:</b> {bundle.negativePrompt}
            </p>
          ) : null}

          {bundle.items.map((resolved) => {
            const mention = mentions.find((entry) => entry.itemId === resolved.itemId);
            const item = items.find((entry) => entry.id === resolved.itemId);
            return (
              <div key={resolved.itemId} className="itemChip">
                <div className="row" style={{ gap: 6 }}>
                  <b>@{resolved.handle}</b>
                  {item ? <span className="badge">{item.kind}</span> : null}
                  <span className="dim">
                    {resolved.plateAssetIds.length} plate
                    {resolved.plateAssetIds.length === 1 ? "" : "s"}
                    {resolved.droppedPlateAssetIds.length > 0
                      ? `, ${resolved.droppedPlateAssetIds.length} dropped`
                      : ""}
                  </span>
                  <span className="badge">{resolved.tier}</span>
                </div>

                <div className="row" style={{ gap: 6 }}>
                  <label className="dim" htmlFor={`inf-${resolved.itemId}`}>
                    influence
                  </label>
                  <input
                    id={`inf-${resolved.itemId}`}
                    type="range"
                    min={0}
                    max={100}
                    step={10}
                    value={mention?.influence ?? 70}
                    onChange={(event) =>
                      update(resolved.itemId, { influence: Number(event.target.value) })
                    }
                  />
                  <span className="dim">{mention?.influence ?? 70}</span>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={mention?.muteText ?? false}
                      onChange={(event) =>
                        update(resolved.itemId, { muteText: event.target.checked })
                      }
                    />
                    plates only
                  </label>
                </div>
              </div>
            );
          })}

          {bundle.warnings.map((warning, index) => (
            <p key={index} className="hint warn">
              {warning}
            </p>
          ))}

          {overStable || bundle.items.some((item) => item.droppedPlateAssetIds.length > 0) ? (
            <label className="check">
              <input
                type="checkbox"
                checked={allowBeyondStable}
                onChange={(event) => onAllowBeyondStable(event.target.checked)}
              />
              Send more references than the provider works reliably with
            </label>
          ) : null}
        </>
      ) : (
        <p className="hint">Working out what these items add…</p>
      )}
    </div>
  );
}
