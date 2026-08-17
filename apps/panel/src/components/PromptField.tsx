import { useEffect, useMemo, useRef, useState } from "react";
import type { Asset } from "@seed-ae/domain";
import type { SeedClient } from "../api/client.ts";
import {
  assetToken,
  completeItemMention,
  completeMention,
  matchAssets,
  matchItems,
  mentionQueryAt,
  type ItemLike,
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
  /**
   * The items already added to this shot.
   *
   * Only those, never the whole library: membership is decided by the picker,
   * so `@` is for placing something already chosen rather than for summoning
   * one. That also keeps this list short enough to be worth reading.
   */
  items?: ItemLike[];
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
}

/** The text split into runs, so known mentions can be marked up. */
export interface Run {
  text: string;
  asset?: Asset;
  item?: ItemLike;
}

export function splitRuns(
  text: string,
  assets: Asset[],
  items: ItemLike[] = [],
): Run[] {
  const byToken = new Map(assets.map((asset) => [assetToken(asset), asset]));
  const byHandle = new Map(items.map((item) => [item.handle.toLowerCase(), item]));
  const runs: Run[] = [];
  let cursor = 0;

  for (const match of text.matchAll(/@([A-Za-z0-9_-]+)/g)) {
    const at = match.index ?? 0;
    const token = match[1] as string;
    // An item wins a name it shares with a file: the artist added it on purpose.
    const item = byHandle.get(token.toLowerCase());
    const asset = item ? undefined : byToken.get(token);
    // An @ that names nothing is prose, not a mention, and stays unmarked.
    if (!item && !asset) continue;
    if (at > cursor) runs.push({ text: text.slice(cursor, at) });
    runs.push({ text: match[0], ...(item ? { item } : { asset }) });
    cursor = at + match[0].length;
  }

  if (cursor < text.length) runs.push({ text: text.slice(cursor) });
  return runs;
}

export function PromptField({
  client,
  assets,
  items = [],
  value,
  placeholder,
  onChange,
}: Props) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const [mentionQuery, setMentionQuery] = useState<string>();
  const [hovered, setHovered] = useState<{ asset: Asset; top: number }>();

  const runs = useMemo(() => splitRuns(value, assets, items), [value, assets, items]);

  /*
   * Items lead. They are the things that have to stay the same across shots,
   * there are few of them because they were added deliberately, and a file
   * whose name happens to start the same way is almost never what was meant.
   */
  const itemMatches =
    mentionQuery === undefined ? [] : matchItems(items, mentionQuery);
  const matches =
    mentionQuery === undefined ? [] : matchAssets(assets, mentionQuery);

  /** Tracks the `@…` being typed so the library can be offered inline. */
  const syncMentionQuery = (element: HTMLTextAreaElement) =>
    setMentionQuery(mentionQueryAt(element.value, element.selectionStart ?? 0)?.query);

  const insertItem = (item: ItemLike) => {
    const element = inputRef.current;
    if (!element) return;
    const next = completeItemMention(
      value,
      element.selectionStart ?? value.length,
      item,
    );
    onChange(next.text);
    setMentionQuery(undefined);
    requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(next.caret, next.caret);
    });
  };

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
          run.item ? (
            <span key={index} className="mention item">
              {run.text}
            </span>
          ) : run.asset ? (
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

      {itemMatches.length + matches.length > 0 ? (
        <ul className="mention-menu">
          {itemMatches.map((item) => (
            <li key={item.id}>
              <button
                onMouseDown={(event) => {
                  event.preventDefault();
                  insertItem(item);
                }}
              >
                <span className="badge">{item.kind}</span>
                <span className="mono">@{item.handle}</span>
                <span className="faint">{item.name}</span>
              </button>
            </li>
          ))}
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
