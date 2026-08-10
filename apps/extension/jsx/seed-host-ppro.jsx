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

/**
 * Exports the frame under the playhead.
 *
 * Premiere has no documented equivalent of After Effects' saveFrameToPng. The
 * working route is the QE DOM, which Adobe does not document and which is
 * reported to fail silently in some builds — so this checks hard for the file
 * afterwards and says exactly what happened rather than assuming success.
 */
function seedCaptureFrame(outputDir, basename) {
    try {
        var sequence = seedActiveSequence();
        if (!sequence) return seedFail("no active sequence");

        var folder = seedEnsureFolder(outputDir);
        if (!folder.exists) {
            return seedFail("could not create output folder: " + outputDir);
        }

        if (typeof app.enableQE !== "function") {
            return seedFail(
                "this Premiere version does not expose the QE DOM, which frame export needs"
            );
        }
        app.enableQE();
        if (typeof qe === "undefined" || !qe.project) {
            return seedFail("the QE DOM did not initialise");
        }
        var qeSequence = qe.project.getActiveSequence();
        if (!qeSequence) return seedFail("QE could not see the active sequence");
        if (typeof qeSequence.exportFramePNG !== "function") {
            return seedFail(
                "this Premiere version has no QE exportFramePNG; frame capture is unavailable"
            );
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

        try {
            // QE wants the playhead's timecode string, not a Time object.
            qeSequence.exportFramePNG(qeSequence.CTI.timecode, targetPath);
        } catch (writeError) {
            return seedFail("QE exportFramePNG failed: " + writeError);
        }

        /*
         * Re-stat through a new File each time. An ExtendScript File caches
         * what it knew at construction, so the same instance can answer with a
         * stale "no" straight after a write — the exact trap that made the
         * After Effects host report working captures as failures.
         */
        var written = null;
        for (var check = 0; check < 40; check++) {
            var probe = new File(targetPath);
            if (probe.exists && probe.length > 0) {
                written = probe;
                break;
            }
            $.sleep(50);
        }

        if (!written) {
            return seedFail(
                "Premiere reported no error but no file appeared at " +
                    targetPath +
                    ". QE frame export is undocumented and does not work on every " +
                    "build; try a different sequence or export the frame manually."
            );
        }

        return seedOk({
            path: written.fsName,
            bytes: written.length,
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
