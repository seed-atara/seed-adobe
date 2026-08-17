import { useEffect, useState } from "react";
import type { Item, ItemKind } from "@seed-ae/domain";
import type { SeedClient } from "../api/client.ts";

/**
 * Choosing which identities are in this shot.
 *
 * Items are added deliberately rather than summoned by typing `@`. With a
 * studio's worth of characters, locations, props and looks in one library,
 * matching every `@` in a prompt against all of them is both slow to search and
 * easy to trigger by accident — and, worse, it hides the cost: every item added
 * spends part of a small reference budget. A chip you added is a cost you can
 * see and remove.
 *
 * Typing `@handle` still matters. It positions an item inside the sentence.
 * What it no longer does is decide membership.
 */

const KINDS: Array<ItemKind | "all"> = ["all", "character", "location", "prop", "style"];

interface Props {
  client: SeedClient;
  /** Already in the shot, so the picker can show them as added. */
  chosenIds: string[];
  onChoose: (item: Item) => void;
  onClose: () => void;
  onError: (message: string) => void;
}

export function ItemPicker({ client, chosenIds, onChoose, onClose, onError }: Props) {
  const [items, setItems] = useState<Item[]>([]);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<ItemKind | "all">("all");
  const [loading, setLoading] = useState(true);

  /*
   * Fetched every time the picker opens, not once when the panel mounts. An
   * item created in the Items tab a moment ago has to be here, and a list
   * loaded at mount would not have it — which is exactly how a freshly made
   * character became unreferenceable.
   */
  useEffect(() => {
    setLoading(true);
    void client
      .listItems({ ...(kind !== "all" ? { kind } : {}), ...(query ? { query } : {}) })
      .then((result) => setItems(result.items))
      .catch((error: unknown) =>
        onError(error instanceof Error ? error.message : String(error)),
      )
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, kind, query]);

  return (
    <div className="picker">
      <div className="head">
        <b>Add an item</b>
        <button className="btn" onClick={onClose}>
          Close
        </button>
      </div>

      <div className="row" style={{ gap: 6, marginBottom: 6 }}>
        <input
          className="text"
          autoFocus
          placeholder="Search characters, locations, props, looks"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <select
          className="select"
          value={kind}
          onChange={(event) => setKind(event.target.value as ItemKind | "all")}
        >
          {KINDS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </div>

      {loading ? (
        <p className="hint">Looking…</p>
      ) : items.length === 0 ? (
        <p className="hint">
          {query || kind !== "all"
            ? "Nothing matches."
            : "No items yet. Make one in the Items tab from frames you have already captured."}
        </p>
      ) : (
        <div className="list">
          {items.map((item) => {
            const chosen = chosenIds.includes(item.id);
            return (
              <button
                key={item.id}
                className="listRow"
                disabled={chosen}
                onClick={() => onChoose(item)}
              >
                <span className="badge">{item.kind}</span>
                <b>@{item.handle}</b>
                <span className="dim">{item.name}</span>
                {item.realPerson && item.authorisation !== "authorised" ? (
                  <span className="badge warn">{item.authorisation}</span>
                ) : null}
                {chosen ? <span className="dim">added</span> : null}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
