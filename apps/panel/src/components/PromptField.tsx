import { useEffect, useMemo, useRef, useState } from "react";
import type { Asset } from "@seed-ae/domain";
import type { SeedClient } from "../api/client.ts";
import {
  assetToken,
  completeMention,
  matchAssets,
  mentionQueryAt,
} from "../mentions.ts";
import { AssetImage } from "./primitives.tsx";

/**
 * The prompt box, with `@mentions` shown as links.
 *
 * A textarea cannot style ranges inside itself, so the text is drawn twice: a
 * mirror underneath carries the highlighting, and the real textarea sits on
 * top of it with a transparent background. The two must agree on every metric
 * that affects wrapping — font, size, line height, padding, border — or the
 * highlight drifts away from the words it is marking. That is why the mirror
 * takes its type from the same custom properties the input does rather than
 * restating any of it.
 */

interface Props {
  client: SeedClient;
  assets: Asset[];
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
}

/** The text split into runs, so known mentions can be marked up. */
export interface Run {
  text: string;
  asset?: Asset;
}

export function splitRuns(text: string, assets: Asset[]): Run[] {
  const byToken = new Map(assets.map((asset) => [assetToken(asset), asset]));
  const runs: Run[] = [];
  let cursor = 0;

  for (const match of text.matchAll(/@([A-Za-z0-9_-]+)/g)) {
    const at = match.index ?? 0;
    const asset = byToken.get(match[1] as string);
    // An @ that names nothing is prose, not a mention, and stays unmarked.
    if (!asset) continue;
    if (at > cursor) runs.push({ text: text.slice(cursor, at) });
    runs.push({ text: match[0], asset });
    cursor = at + match[0].length;
  }

  if (cursor < text.length) runs.push({ text: text.slice(cursor) });
  return runs;
}

export function PromptField({
  client,
  assets,
  value,
  placeholder,
  onChange,
}: Props) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const [mentionQuery, setMentionQuery] = useState<string>();
  const [hovered, setHovered] = useState<{ asset: Asset; top: number }>();

  const runs = useMemo(() => splitRuns(value, assets), [value, assets]);

  const matches =
    mentionQuery === undefined ? [] : matchAssets(assets, mentionQuery);

  /** Tracks the `@…` being typed so the library can be offered inline. */
  const syncMentionQuery = (element: HTMLTextAreaElement) =>
    setMentionQuery(mentionQueryAt(element.value, element.selectionStart ?? 0)?.query);

  const insertMention = (asset: Asset) => {
    const element = inputRef.current;
    if (!element) return;
    const next = completeMention(
      value,
      element.selectionStart ?? value.length,
      asset,
    );
    onChange(next.text);
    setMentionQuery(undefined);
    // The caret has to be restored after React re-renders the value.
    requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(next.caret, next.caret);
    });
  };

  // The mirror scrolls with the text, or long prompts drift out of register.
  useEffect(() => {
    const element = inputRef.current;
    const mirror = mirrorRef.current;
    if (!element || !mirror) return;
    const sync = () => {
      mirror.scrollTop = element.scrollTop;
      mirror.scrollLeft = element.scrollLeft;
    };
    element.addEventListener("scroll", sync);
    return () => element.removeEventListener("scroll", sync);
  }, []);

  return (
    <div className="prompt-field">
      <div className="prompt-mirror" ref={mirrorRef} aria-hidden="true">
        {runs.map((run, index) =>
          run.asset ? (
            <span
              key={index}
              className="mention"
              onMouseEnter={(event) =>
                setHovered({
                  asset: run.asset as Asset,
                  top: event.currentTarget.offsetTop,
                })
              }
              onMouseLeave={() => setHovered(undefined)}
            >
              {run.text}
            </span>
          ) : (
            <span key={index}>{run.text}</span>
          ),
        )}
        {/* A trailing newline is not laid out without something after it. */}
        {"​"}
      </div>

      <textarea
        ref={inputRef}
        value={value}
        placeholder={placeholder}
        onChange={(event) => {
          onChange(event.target.value);
          syncMentionQuery(event.target);
        }}
        onKeyUp={(event) => syncMentionQuery(event.currentTarget)}
        onClick={(event) => syncMentionQuery(event.currentTarget)}
        onBlur={() => setMentionQuery(undefined)}
      />

      {matches.length > 0 ? (
        <ul className="mention-menu">
          {matches.map((asset) => (
            <li key={asset.id}>
              {/* onMouseDown fires before the textarea's blur closes this. */}
              <button
                onMouseDown={(event) => {
                  event.preventDefault();
                  insertMention(asset);
                }}
              >
                <AssetImage client={client} asset={asset} variant="thumbnail" />
                <span className="mono">@{assetToken(asset)}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {hovered ? (
        <div className="mention-card" style={{ top: hovered.top }}>
          <AssetImage
            client={client}
            asset={hovered.asset}
            variant="thumbnail"
          />
          <div className="mention-card-text">
            <div className="mono">{hovered.asset.filename}</div>
            <div className="faint">
              {hovered.asset.kind}
              {hovered.asset.width && hovered.asset.height
                ? ` · ${hovered.asset.width}x${hovered.asset.height}`
                : ""}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
