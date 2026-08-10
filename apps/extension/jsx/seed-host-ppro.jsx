/**
 * SEED / AE — ExtendScript host for Premiere Pro.
 *
 * Deliberately exposes the *same function names* as the After Effects host
 * (seedPing, seedGetContext, seedCaptureFrame, seedImport, seedInsertAtPlayhead)
 * so the panel needs no host-specific code: it loads whichever file matches the
 * application and calls the same things.
 *
 * ExtendScript is ES3: no JSON, no const/let, no arrow functions.
 *
 * Premiere differs from After Effects in three ways that matter here:
 *   1. There are sequences, not compositions.
 *   2. Frame export lives on the QE DOM, which Adobe does not document and
 *      which is reported to be unreliable. Treated accordingly below.
 *   3. Media goes onto a track at a time, not onto a layer stack.
 */

// ---------------------------------------------------------------- utilities

/** Ticks per second in Premiere's Time objects. */
var SEED_TICKS_PER_SECOND = 254016000000;

function seedEscape(value) {
    var out = "";
    for (var i = 0; i < value.length; i++) {
        var c = value.charAt(i);
        var code = value.charCodeAt(i);
        if (c === '"') out += '\\"';
        else if (c === "\\") out += "\\\\";
        else if (c === "\n") out += "\\n";
        else if (c === "\r") out += "\\r";
        else if (c === "\t") out += "\\t";
        else if (code < 32 || code > 126) {
            var hex = code.toString(16);
            while (hex.length < 4) hex = "0" + hex;
            out += "\\u" + hex;
        } else out += c;
    }
    return out;
}

function seedJson(value) {
    if (value === null || value === undefined) return "null";
    var type = typeof value;
    if (type === "number") return isFinite(value) ? String(value) : "null";
    if (type === "boolean") return value ? "true" : "false";
    if (type === "string") return '"' + seedEscape(value) + '"';
    if (value instanceof Array) {
        var items = [];
        for (var i = 0; i < value.length; i++) items.push(seedJson(value[i]));
        return "[" + items.join(",") + "]";
    }
    var pairs = [];
    for (var key in value) {
        if (!value.hasOwnProperty(key)) continue;
        if (value[key] === undefined) continue;
        pairs.push('"' + seedEscape(key) + '":' + seedJson(value[key]));
    }
    return "{" + pairs.join(",") + "}";
}

function seedOk(payload) {
    return seedJson({ ok: true, result: payload });
}

function seedFail(message) {
    return seedJson({ ok: false, error: String(message) });
}

function seedNormalizePath(value) {
    return String(value).replace(/\\/g, "/");
}

function seedEnsureFolder(pathString) {
    var folder = new Folder(seedNormalizePath(pathString));
    if (folder.exists) return folder;

    var parts = seedNormalizePath(pathString).split("/");
    var current = "";
    for (var i = 0; i < parts.length; i++) {
        current = current === "" ? parts[i] : current + "/" + parts[i];
        if (current === "" || /^[A-Za-z]:$/.test(current)) continue;
        var step = new Folder(current);
        if (!step.exists) step.create();
    }
    return new Folder(seedNormalizePath(pathString));
}

function seedActiveSequence() {
    if (!app.project) return null;
    return app.project.activeSequence || null;
}

/** Sequence frame rate, derived from its timebase in ticks per frame. */
function seedSequenceFps(sequence) {
    try {
        var timebase = Number(sequence.timebase);
        if (timebase > 0) return SEED_TICKS_PER_SECOND / timebase;
    } catch (error) {
        // fall through
    }
    return 0;
}

function seedPlayheadSeconds(sequence) {
    var position = sequence.getPlayerPosition();
    if (!position) return 0;
    // `seconds` is present on modern builds; ticks is the durable fallback.
    if (position.seconds !== undefined) return Number(position.seconds);
    return Number(position.ticks) / SEED_TICKS_PER_SECOND;
}

// ------------------------------------------------------------------ context

function seedGetContext() {
    try {
        if (!app.project) return seedFail("no project is open");

        var context = {};
        if (app.project.path) {
            context.projectPath = app.project.path;
            var parts = seedNormalizePath(app.project.path).split("/");
            context.projectName = parts[parts.length - 1];
        }

        var sequence = seedActiveSequence();
        if (sequence) {
            // The panel calls this a comp; in Premiere it is the sequence.
            context.compName = sequence.name;
            context.compId = String(sequence.sequenceID || sequence.id || "");

            var width = Number(sequence.frameSizeHorizontal);
            var height = Number(sequence.frameSizeVertical);
            if (width > 0) context.width = width;
            if (height > 0) context.height = height;

            var fps = seedSequenceFps(sequence);
            if (fps > 0) context.fps = fps;

            var seconds = seedPlayheadSeconds(sequence);
            context.timeSeconds = seconds;
            if (fps > 0) context.frameNumber = Math.round(seconds * fps);
        }

        return seedOk({ context: context });
    } catch (error) {
        return seedFail(error);
    }
}

// ------------------------------------------------------------------ capture

/** Newest file in a folder, used to find what an exporter actually wrote. */
function seedNewestFile(folder, sinceMs) {
    var files = folder.getFiles(function (f) {
        return f instanceof File;
    });
    var best = null;
    for (var i = 0; i < files.length; i++) {
        var modified = files[i].modified ? files[i].modified.getTime() : 0;
        if (modified < sinceMs) continue;
        if (!best || modified > best.modified.getTime()) best = files[i];
    }
    return best;
}

/** Waits for a file to appear and stop growing. */
function seedAwaitFile(path) {
    var last = -1;
    for (var check = 0; check < 40; check++) {
        var probe = new File(path);
        if (probe.exists && probe.length > 0) {
            if (probe.length === last) return probe;
            last = probe.length;
        }
        $.sleep(50);
    }
    var settled = new File(path);
    return settled.exists && settled.length > 0 ? settled : null;
}

/**
 * Route 1: the QE DOM.
 *
 * Fast and needs no preset, but Adobe does not document it and it is reported
 * to fail on some builds. Returns a File, or null to let the caller fall back.
 */
function seedExportViaQE(sequence, targetPath) {
    if (typeof app.enableQE !== "function") return null;
    app.enableQE();
    if (typeof qe === "undefined" || !qe.project) return null;

    var qeSequence = qe.project.getActiveSequence();
    if (!qeSequence || typeof qeSequence.exportFramePNG !== "function") return null;

    try {
        qeSequence.exportFramePNG(qeSequence.CTI.timecode, targetPath);
    } catch (error) {
        return null;
    }
    return seedAwaitFile(targetPath);
}

/**
 * Route 2: exportAsMediaDirect with a still-image preset.
 *
 * This is the documented path — the same machinery behind the Program
 * Monitor's camera button — but it needs an .epr preset, which is per-install,
 * so SEED cannot ship one. Point SEED_PPRO_STILL_PRESET at a PNG still preset
 * exported from Premiere's Export Settings dialog.
 *
 * It renders the in-to-out range, so the playhead frame is isolated first and
 * the user's in/out points are restored afterwards.
 */
function seedExportViaPreset(sequence, folder, presetPath, seconds, fps) {
    var preset = new File(seedNormalizePath(presetPath));
    if (!preset.exists) return null;

    var previousIn = null;
    var previousOut = null;
    try {
        previousIn = sequence.getInPoint();
        previousOut = sequence.getOutPoint();
    } catch (error) {
        // Older builds may not expose these; we simply cannot restore them.
    }

    var startedAt = new Date().getTime() - 1000;
    var written = null;
    try {
        var frameSeconds = fps > 0 ? 1 / fps : 0.04;
        sequence.setInPoint(seconds);
        sequence.setOutPoint(seconds + frameSeconds);

        // The exporter names the file itself, so scan for what appeared.
        var stem = seedNormalizePath(folder.fsName) + "/seed_still";
        sequence.exportAsMediaDirect(stem, preset.fsName, "ENCODE_IN_TO_OUT");

        for (var wait = 0; wait < 60 && !written; wait++) {
            $.sleep(100);
            written = seedNewestFile(folder, startedAt);
        }
    } catch (error) {
        written = null;
    } finally {
        try {
            if (previousIn !== null) sequence.setInPoint(previousIn.seconds);
            if (previousOut !== null) sequence.setOutPoint(previousOut.seconds);
        } catch (restoreError) {
            // Nothing further we can do; the export already happened.
        }
    }
    return written;
}

/**
 * Exports the frame under the playhead.
 *
 * Premiere has no documented equivalent of After Effects' saveFrameToPng, so
 * this tries the undocumented-but-quick QE route first and falls back to the
 * documented preset-based export. Note that the Program Monitor's camera
 * button is "Export Frame" — it genuinely writes a file, unlike After Effects'
 * Take Snapshot, which only holds an image in memory for comparison.
 */
function seedCaptureFrame(outputDir, basename, presetPath) {
    try {
        var sequence = seedActiveSequence();
        if (!sequence) return seedFail("no active sequence");

        var folder = seedEnsureFolder(outputDir);
        if (!folder.exists) {
            return seedFail("could not create output folder: " + outputDir);
        }

        var fps = seedSequenceFps(sequence);
        var seconds = seedPlayheadSeconds(sequence);
        var frame = fps > 0 ? Math.round(seconds * fps) : 0;

        var safe = String(basename || sequence.name).replace(/[^A-Za-z0-9._-]+/g, "_");
        var stamp = String(frame);
        while (stamp.length < 5) stamp = "0" + stamp;

        // Never overwrite an existing capture: each one is an immutable source.
        var attempt = 1;
        var targetPath;
        do {
            var suffix = String(attempt);
            while (suffix.length < 3) suffix = "0" + suffix;
            targetPath =
                seedNormalizePath(folder.fsName) + "/" + safe + "_f" + stamp + "_" + suffix + ".png";
            attempt++;
        } while (new File(targetPath).exists && attempt < 1000);

        var written = seedExportViaQE(sequence, targetPath);
        var route = "qe";

        if (!written && presetPath) {
            written = seedExportViaPreset(sequence, folder, presetPath, seconds, fps);
            route = "preset";
        }

        if (!written) {
            return seedFail(
                "Premiere wrote no frame. The QE exporter is undocumented and " +
                    "unavailable on some builds" +
                    (presetPath
                        ? ", and the still preset at " + presetPath + " did not produce a file."
                        : ". Set SEED_PPRO_STILL_PRESET to a PNG still preset (.epr) " +
                          "exported from Premiere's Export Settings to enable the " +
                          "documented fallback.")
            );
        }

        return seedOk({
            path: written.fsName,
            bytes: written.length,
            route: route,
            width: Number(sequence.frameSizeHorizontal) || 0,
            height: Number(sequence.frameSizeVertical) || 0,
            frameNumber: frame,
            timeSeconds: seconds
        });
    } catch (error) {
        return seedFail(error);
    }
}

// ------------------------------------------------------------------- import

/** Finds, or makes, the bin generated media is kept in. */
function seedSeedBin() {
    var root = app.project.rootItem;
    for (var i = 0; i < root.children.numItems; i++) {
        var child = root.children[i];
        if (child && child.name === "SEED" && child.type === ProjectItemType.BIN) {
            return child;
        }
    }
    return root.createBin("SEED");
}

function seedFindByNodeId(item, nodeId) {
    if (!item) return null;
    if (String(item.nodeId) === String(nodeId)) return item;
    if (!item.children) return null;
    for (var i = 0; i < item.children.numItems; i++) {
        var found = seedFindByNodeId(item.children[i], nodeId);
        if (found) return found;
    }
    return null;
}

function seedImport(path) {
    try {
        var file = new File(seedNormalizePath(path));
        if (!file.exists) return seedFail("file not found: " + path);

        var bin = seedSeedBin();
        var before = bin.children.numItems;

        // (paths, suppressUI, targetBin, importAsNumberedStills)
        app.project.importFiles([file.fsName], true, bin, false);

        if (bin.children.numItems <= before) {
            return seedFail("Premiere did not import " + file.fsName);
        }
        var imported = bin.children[bin.children.numItems - 1];

        return seedOk({
            projectItemId: String(imported.nodeId),
            name: imported.name
        });
    } catch (error) {
        return seedFail(error);
    }
}

/**
 * Drops the clip onto the timeline at the playhead.
 *
 * Uses the lowest targeted video track when one is targeted, otherwise the
 * first — and overwrites rather than inserts, so nothing downstream shifts
 * under the editor without them asking for it.
 */
function seedInsertAtPlayhead(projectItemId) {
    try {
        var sequence = seedActiveSequence();
        if (!sequence) return seedFail("no active sequence");

        var item = seedFindByNodeId(app.project.rootItem, projectItemId);
        if (!item) return seedFail("project item " + projectItemId + " not found");

        var track = null;
        for (var i = 0; i < sequence.videoTracks.numTracks; i++) {
            if (sequence.videoTracks[i].isTargeted()) {
                track = sequence.videoTracks[i];
                break;
            }
        }
        if (!track && sequence.videoTracks.numTracks > 0) {
            track = sequence.videoTracks[0];
        }
        if (!track) return seedFail("the sequence has no video track");

        var seconds = seedPlayheadSeconds(sequence);
        track.overwriteClip(item, seconds);

        return seedOk({ trackIndex: track.id, name: item.name, atSeconds: seconds });
    } catch (error) {
        return seedFail(error);
    }
}

function seedPing() {
    try {
        return seedOk({
            host: "premiere-pro",
            version: app.version,
            hasProject: app.project ? true : false
        });
    } catch (error) {
        return seedFail(error);
    }
}
