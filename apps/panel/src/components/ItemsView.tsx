import { useEffect, useMemo, useState } from "react";
import type {
  Asset,
  Item,
  ItemDetail,
  ItemKind,
  ItemTrait,
  PlateRole,
} from "@seed-ae/domain";
import type { SeedClient } from "../api/client.ts";
import { AssetImage, SectionLabel, formatStamp } from "./primitives.tsx";

/**
 * Items: the identities that keep a character, a place, a prop or a look the
 * same across shots.
 *
 * Everything here is host-agnostic on purpose. The same component is the Items
 * tab inside After Effects and the whole of the standalone authoring tool, so
 * nothing in it may assume a host is present.
 */

const KINDS: ItemKind[] = ["character", "location", "prop", "style", "other"];

/** Ark's own recommendation leads for a character: full body plus a neutral face. */
const SUGGESTED_ROLES: Record<ItemKind, PlateRole[]> = {
  character: ["full-body", "face", "three-quarter", "profile", "back", "wardrobe", "detail"],
  location: ["establishing", "wide", "reference", "detail", "texture"],
  prop: ["three-quarter", "detail", "texture", "in-situ", "reference"],
  style: ["style-plate", "reference"],
  other: ["reference", "detail"],
};

interface Props {
  client: SeedClient;
  assets: Asset[];
  activeProject?: string;
  onError: (message: string) => void;
}

export function ItemsView({ client, assets, activeProject, onError }: Props) {
  const [items, setItems] = useState<Item[]>([]);
  const [selected, setSelected] = useState<ItemDetail | undefined>();
  const [kindFilter, setKindFilter] = useState<ItemKind | "all">("all");
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    try {
      const { items: listed } = await client.listItems({
        ...(kindFilter !== "all" ? { kind: kindFilter } : {}),
        ...(query ? { query } : {}),
      });
      setItems(listed);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kindFilter, query]);

  const open = async (id: string) => {
    try {
      const { item } = await client.getItem(id);
      setSelected(item);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  };

  if (creating) {
    return (
      <NewItem
        client={client}
        assets={assets}
        activeProject={activeProject}
        busy={busy}
        onCancel={() => setCreating(false)}
        onCreate={async (request) => {
          setBusy(true);
          try {
            const { item } = await client.adoptItem(request);
            setCreating(false);
            setSelected(item);
            await refresh();
          } catch (error) {
            onError(error instanceof Error ? error.message : String(error));
          } finally {
            setBusy(false);
          }
        }}
      />
    );
  }

  if (selected) {
    return (
      <ItemDetailView
        client={client}
        assets={assets}
        detail={selected}
        onBack={() => {
          setSelected(undefined);
          void refresh();
        }}
        onChanged={(item) => setSelected(item)}
        onError={onError}
      />
    );
  }

  return (
    <div>
      <div className="row" style={{ gap: 6, marginBottom: 8 }}>
        <input
          className="text"
          placeholder="Search items"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          style={{ flex: 1 }}
        />
        <select
          className="select"
          value={kindFilter}
          onChange={(event) => setKindFilter(event.target.value as ItemKind | "all")}
        >
          <option value="all">All kinds</option>
          {KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {kind}
            </option>
          ))}
        </select>
        <button className="btn" onClick={() => setCreating(true)}>
          New
        </button>
      </div>

      {items.length === 0 ? (
        <p className="hint">
          No items yet. Select frames in the Library and make one — a character,
          a location, a prop or a look. Then write <code>@handle</code> in a
          prompt and it comes back the same every time.
        </p>
      ) : (
        <div className="list">
          {items.map((item) => (
            <button key={item.id} className="listRow" onClick={() => void open(item.id)}>
              <span className="badge">{item.kind}</span>
              <b>@{item.handle}</b>
              <span className="dim">{item.name}</span>
              {item.realPerson && item.authorisation !== "authorised" ? (
                <span className="badge warn">{item.authorisation}</span>
              ) : null}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Creating
 * ------------------------------------------------------------------ */

interface NewItemProps {
  client: SeedClient;
  assets: Asset[];
  activeProject?: string;
  busy: boolean;
  onCancel: () => void;
  onCreate: (request: {
    handle: string;
    kind: ItemKind;
    name: string;
    project?: string;
    realPerson: boolean;
    plates: Array<{ assetId: string; role: PlateRole }>;
    traits: ItemTrait[];
  }) => void;
}

function NewItem({ client, assets, activeProject, busy, onCancel, onCreate }: NewItemProps) {
  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");
  const [kind, setKind] = useState<ItemKind>("character");
  const [realPerson, setRealPerson] = useState(false);
  const [studioWide, setStudioWide] = useState(true);
  const [plates, setPlates] = useState<Array<{ assetId: string; role: PlateRole }>>([]);

  const roles = SUGGESTED_ROLES[kind];
  const suggestedHandle = useMemo(
    () => name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, ""),
    [name],
  );
  const effectiveHandle = handle || suggestedHandle;
  const images = assets.filter((asset) => asset.kind === "image" && asset.status === "ready");

  const toggle = (assetId: string) => {
    setPlates((current) =>
      current.some((plate) => plate.assetId === assetId)
        ? current.filter((plate) => plate.assetId !== assetId)
        : [...current, { assetId, role: roles[current.length] ?? "reference" }],
    );
  };

  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
        <SectionLabel>New item</SectionLabel>
        <button className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>

      <label className="field">
        Name
        <input
          className="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Sara Kim"
        />
      </label>

      <label className="field">
        Handle
        <input
          className="text"
          value={effectiveHandle}
          onChange={(event) => setHandle(event.target.value.toLowerCase())}
          placeholder="sara"
        />
        <span className="hint">
          What you type after <code>@</code>. Renaming later keeps old prompts
          working.
        </span>
      </label>

      <label className="field">
        Kind
        <select
          className="select"
          value={kind}
          onChange={(event) => setKind(event.target.value as ItemKind)}
        >
          {KINDS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>

      <label className="check">
        <input
          type="checkbox"
          checked={realPerson}
          onChange={(event) => setRealPerson(event.target.checked)}
        />
        A real person
      </label>
      {realPerson ? (
        <p className="hint warn">
          A real likeness needs that person to authorise it themselves before the
          provider will generate with it. The item is created either way, and
          says so until it is authorised.
        </p>
      ) : null}

      {activeProject ? (
        <label className="check">
          <input
            type="checkbox"
            checked={studioWide}
            onChange={(event) => setStudioWide(event.target.checked)}
          />
          Available to every project
        </label>
      ) : null}

      <SectionLabel>Plates</SectionLabel>
      <p className="hint">
        {kind === "character"
          ? "A full-body front shot and a neutral-expression face close-up is the pairing the provider recommends. Order matters: the first is kept when the budget is tight."
          : "Order matters: the first plate is kept when the reference budget is tight."}
      </p>

      <div className="grid">
        {images.map((asset) => {
          const index = plates.findIndex((plate) => plate.assetId === asset.id);
          return (
            <button
              key={asset.id}
              className={`card ${index >= 0 ? "selected" : ""}`}
              onClick={() => toggle(asset.id)}
            >
              <AssetImage client={client} asset={asset} />
              {index >= 0 ? <span className="badge">{index + 1}</span> : null}
              <span className="dim">{asset.filename}</span>
            </button>
          );
        })}
      </div>

      {plates.length > 0 ? (
        <div style={{ marginTop: 8 }}>
          <SectionLabel>Roles</SectionLabel>
          {plates.map((plate, index) => (
            <div key={plate.assetId} className="row" style={{ gap: 6, marginBottom: 4 }}>
              <span className="dim">{index + 1}</span>
              <select
                className="select"
                value={plate.role}
                onChange={(event) =>
                  setPlates((current) =>
                    current.map((entry, at) =>
                      at === index
                        ? { ...entry, role: event.target.value as PlateRole }
                        : entry,
                    ),
                  )
                }
              >
                {roles.map((role) => (
                  <option key={role} value={role}>
                    {role}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
      ) : null}

      <button
        className="btn primary"
        disabled={busy || !name || !effectiveHandle || plates.length === 0}
        onClick={() =>
          onCreate({
            handle: effectiveHandle,
            kind,
            name,
            ...(activeProject && !studioWide ? { project: activeProject } : {}),
            realPerson,
            plates,
            traits: [],
          })
        }
        style={{ marginTop: 10 }}
      >
        {busy ? "Creating…" : "Create item"}
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Editing
 * ------------------------------------------------------------------ */

interface DetailProps {
  client: SeedClient;
  assets: Asset[];
  detail: ItemDetail;
  onBack: () => void;
  onChanged: (item: ItemDetail) => void;
  onError: (message: string) => void;
}

function ItemDetailView({ client, assets, detail, onBack, onChanged, onError }: DetailProps) {
  const [busy, setBusy] = useState(false);
  const [traitText, setTraitText] = useState("");
  const [driftProne, setDriftProne] = useState(true);

  const variant =
    detail.variants.find((entry) => entry.id === detail.item.defaultVariantId) ??
    detail.variants[0];
  const revisions = detail.revisions.filter((entry) => entry.variantId === variant?.id);
  const latest = revisions.at(-1);

  const addTrait = async () => {
    if (!latest || !traitText.trim()) return;
    setBusy(true);
    try {
      const { item } = await client.addRevision(detail.item.id, {
        variantId: variant?.id,
        message: `added trait: ${traitText.trim()}`,
        traits: [
          ...latest.traits,
          {
            text: traitText.trim(),
            facet: "other",
            priority: latest.traits.length,
            driftProne,
          },
        ],
        plates: latest.plates,
        avoid: latest.avoid,
        attributes: latest.attributes,
      });
      setTraitText("");
      onChanged(item);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
        <div>
          <b>@{detail.item.handle}</b> <span className="dim">{detail.item.name}</span>
          <span className="badge" style={{ marginLeft: 6 }}>
            {detail.item.kind}
          </span>
        </div>
        <button className="btn" onClick={onBack}>
          Back
        </button>
      </div>

      {detail.item.realPerson && detail.item.authorisation !== "authorised" ? (
        <p className="hint warn">
          Real likeness, {detail.item.authorisation}. The provider is likely to
          refuse a generation until the person authorises it themselves.
        </p>
      ) : null}

      <SectionLabel>Plates — revision {latest?.revision ?? 0}</SectionLabel>
      <div className="grid">
        {(latest?.plates ?? []).map((plate, index) => {
          const asset = assets.find((entry) => entry.id === plate.assetId);
          return (
            <div key={`${plate.assetId}-${index}`} className="card">
              {asset ? <AssetImage client={client} asset={asset} /> : null}
              <span className="badge">{plate.role}</span>
              <span className="dim">weight {plate.weight}</span>
            </div>
          );
        })}
      </div>

      <SectionLabel>Traits</SectionLabel>
      <p className="hint">
        Only what a reference loses. A plate already carries the face and the
        palette; a sentence is for the scar, the logo, the exact colour.
      </p>
      {(latest?.traits ?? []).map((trait, index) => (
        <div key={index} className="row" style={{ gap: 6 }}>
          {trait.driftProne ? <span className="badge">drift</span> : null}
          <span>{trait.text}</span>
        </div>
      ))}
      <div className="row" style={{ gap: 6, marginTop: 6 }}>
        <input
          className="text"
          placeholder="faint scar through the left eyebrow"
          value={traitText}
          onChange={(event) => setTraitText(event.target.value)}
          style={{ flex: 1 }}
        />
        <label className="check">
          <input
            type="checkbox"
            checked={driftProne}
            onChange={(event) => setDriftProne(event.target.checked)}
          />
          drifts
        </label>
        <button className="btn" disabled={busy || !traitText.trim()} onClick={() => void addTrait()}>
          Add
        </button>
      </div>

      <SectionLabel>History</SectionLabel>
      <p className="hint">
        Every revision is kept. A shot generated against revision 2 still
        reopens as revision 2, whatever the item has become since.
      </p>
      <div className="list">
        {revisions
          .slice()
          .reverse()
          .map((revision) => (
            <div key={revision.id} className="listRow">
              <span className="badge">r{revision.revision}</span>
              <span className="dim">{formatStamp(revision.createdAt)}</span>
              <span>{revision.message ?? ""}</span>
            </div>
          ))}
      </div>
    </div>
  );
}
