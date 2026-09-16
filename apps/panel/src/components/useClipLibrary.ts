import { useEffect, useMemo, useRef, useState } from "react";
import type { Asset } from "@seed-ae/domain";

/**
 * The clips in the library, and which one the artist meant.
 *
 * Extracted so restoration and transformation cannot drift apart on it, and
 * because the rule it encodes was got wrong once and is not obvious.
 *
 * **Arrival wins.** The first version kept whatever was selected unless it
 * became invalid, reasoning that a deliberate choice should not be overwritten
 * by a capture landing behind it. That reasoning is backwards: pressing
 * *Capture work area as clip* **is** the deliberate choice. Johannes captured
 * a range, the banner confirmed it, and the dropdown quietly stayed on a clip
 * from the day before — so the thing on screen was not the thing about to be
 * rendered, and the first he knew of it was the result.
 *
 * So anything appearing in the library that was not there a moment ago is
 * selected. That covers the capture button and add-from-disk alike. A
 * generated result cannot trigger it: an output lands while the view is
 * showing its own job strip, and the newest *clip* is still the one the artist
 * chose to work on.
 */
export function useClipLibrary(assets: Asset[]): {
  clips: Asset[];
  sourceId: string;
  setSourceId: (id: string) => void;
  source: Asset | undefined;
} {
  /** Only clips. Working on a still is a different job with different tools. */
  const clips = useMemo(() => assets.filter((asset) => asset.kind === "video"), [assets]);
  const [sourceId, setSourceId] = useState("");

  const known = useRef<Set<string> | undefined>(undefined);
  useEffect(() => {
    const ids = new Set(clips.map((clip) => clip.id));

    // First pass: adopt the library as it stands, and start on the newest.
    if (!known.current) {
      known.current = ids;
      setSourceId((current) => current || clips[0]?.id || "");
      return;
    }

    const arrived = clips.filter((clip) => !known.current?.has(clip.id));
    known.current = ids;

    if (arrived[0]) setSourceId(arrived[0].id);
    else setSourceId((current) => (current && ids.has(current) ? current : clips[0]?.id || ""));
  }, [clips]);

  return { clips, sourceId, setSourceId, source: clips.find((clip) => clip.id === sourceId) };
}
