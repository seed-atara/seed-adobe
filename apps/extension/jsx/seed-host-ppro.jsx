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
    // Name the script: both hosts share one ExtendScript engine, so knowing
    // which one answered is the difference between a clear diagnosis and a
    // confusing message borrowed from the other application.
    return seedJson({ ok: false, error: "[premiere-pro] " + String(message) });
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

/** Premiere leaves activeSequence null until a sequence has been focused. */
function seedNoSequenceMessage() {
    return (
        "Premiere reports no active sequence. Click the Timeline or Program " +
        "Monitor to make one active, then try again."
    );
}

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
 * Newest file in a folder, once it has stopped growing.
 *
 * Media Encoder writes progressively, so returning as soon as a file appears
 * hands over a partial frame — and on Windows the writer still holds the lock,
 * which the service then hits as EBUSY.
 */
function seedNewestSettledFile(folder, sinceMs) {
    var candidate = seedNewestFile(folder, sinceMs);
    if (!candidate) return null;

    var last = -1;
    for (var check = 0; check < 40; check++) {
        var probe = new File(candidate.fsName);
        if (probe.exists && probe.length > 0 && probe.length === last) return probe;
        last = probe.exists ? probe.length : -1;
        $.sleep(250);
    }
    return new File(candidate.fsName);
}

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
function seedExportViaQE(sequence, targetPath, trace) {
    if (typeof app.enableQE !== "function") {
        trace.push("QE: app.enableQE is unavailable");
        return null;
    }
    app.enableQE();
    if (typeof qe === "undefined" || !qe.project) {
        trace.push("QE: the DOM did not initialise");
        return null;
    }

    var qeSequence = qe.project.getActiveSequence();
    if (!qeSequence) {
        trace.push("QE: no active sequence");
        return null;
    }
    if (typeof qeSequence.exportFramePNG !== "function") {
        trace.push("QE: exportFramePNG is not defined on this build");
        return null;
    }

    /*
     * The argument form is undocumented, and every attempt so far passed a
     * time first — which may be the whole problem. The QE exporter most likely
     * writes whatever the playhead is on and wants only a path; handing it a
     * timecode as the first argument would produce exactly the "Unknown error
     * exception" we kept getting.
     *
     * So the playhead is moved to the wanted frame first, and the path-only
     * form is tried before any form that passes a time.
     */
    var attempts = [];
    attempts.push(["path only", [targetPath]]);
    attempts.push([
        "path with size",
        [targetPath, Number(sequence.frameSizeHorizontal) || 1920,
            Number(sequence.frameSizeVertical) || 1080]
    ]);
    try {
        attempts.push(["CTI timecode first", [qeSequence.CTI.timecode, targetPath]]);
    } catch (ctiError) {
        trace.push("QE: could not read CTI timecode");
    }
    try {
        attempts.push([
            "ticks first",
            [String(sequence.getPlayerPosition().ticks), targetPath]
        ]);
    } catch (posError) {
        // optional
    }

    for (var a = 0; a < attempts.length; a++) {
        var label = attempts[a][0];
        var args = attempts[a][1];
        try {
            if (args.length === 1) qeSequence.exportFramePNG(args[0]);
            else if (args.length === 2) qeSequence.exportFramePNG(args[0], args[1]);
            else qeSequence.exportFramePNG(args[0], args[1], args[2]);
        } catch (error) {
            trace.push("QE: " + label + " threw: " + error);
            continue;
        }
        var file = seedAwaitFile(targetPath);
        if (file) {
            trace.push("QE: wrote via " + label);
            return file;
        }
        trace.push("QE: " + label + " reported no error but wrote no file");
    }
    return null;
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
/**
 * Premiere's work-area constants for exportAsMediaDirect.
 *
 * The parameter is an integer, not a name: "ENCODE_IN_TO_OUT" is rejected with
 * "Illegal Parameter type". Which integer a build accepts is undocumented, so
 * the candidates are tried in order.
 */
var SEED_WORK_AREA_TYPES = [1, 0, 2];

/** Sets in/out defensively — builds differ on whether they want a number. */
function seedSetInOut(sequence, inSeconds, outSeconds, trace) {
    /*
     * Premiere measures in ticks, not seconds — and setInPoint accepts a
     * number of seconds without complaint, treating it as ticks. Ten seconds
     * becomes ten ticks, which is 0.00000004s, which is frame zero. Every
     * capture came back as the first frame of the sequence and nothing ever
     * reported an error.
     *
     * So the value is written and then read back. Whichever form the build
     * actually wants is the one that survives the round trip; guessing is what
     * produced the silent failure in the first place.
     */
    // Some builds expose setters that name their unit; prefer those.
    if (typeof sequence.setInPointAsTicks === "function") {
        try {
            sequence.setInPointAsTicks(String(Math.round(inSeconds * SEED_TICKS_PER_SECOND)));
            sequence.setOutPointAsTicks(String(Math.round(outSeconds * SEED_TICKS_PER_SECOND)));
            trace.push("in/out set via setInPointAsTicks");
            return true;
        } catch (tickError) {
            trace.push("setInPointAsTicks threw: " + tickError);
        }
    }

    var forms = [
        ["ticks (string)", function (seconds) {
            return String(Math.round(seconds * SEED_TICKS_PER_SECOND));
        }],
        ["ticks (number)", function (seconds) {
            return Math.round(seconds * SEED_TICKS_PER_SECOND);
        }],
        ["seconds", function (seconds) { return seconds; }],
        ["seconds (string)", function (seconds) { return String(seconds); }]
    ];

    for (var i = 0; i < forms.length; i++) {
        var label = forms[i][0];
        var encode = forms[i][1];
        try {
            sequence.setInPoint(encode(inSeconds));
            sequence.setOutPoint(encode(outSeconds));
        } catch (error) {
            continue;
        }

        // Believe the sequence, not the call.
        try {
            var landed = Number(sequence.getInPoint().seconds);
            if (Math.abs(landed - inSeconds) < 0.05) {
                if (i > 0) trace.push("in/out set as " + label);
                return true;
            }
        } catch (readError) {
            // Cannot verify; assume the first form that did not throw.
            trace.push("in/out set as " + label + ", unverified");
            return true;
        }
    }

    trace.push(
        "could not set the in point to " + inSeconds.toFixed(2) + "s — the " +
            "export will cover the whole sequence rather than that frame"
    );
    return false;
}


/** Premiere reports failure by returning an error object, not by throwing. */
function seedExportRefused(returned) {
    if (returned === true) return null;
    var text = String(returned);
    return /error/i.test(text) ? text : null;
}

/**
 * Route 2: exportAsMediaDirect with a still-image preset.
 *
 * The documented path — the machinery behind the Program Monitor's camera
 * button. It renders in-to-out, so the playhead frame is isolated first and
 * the editor's own in/out points are put back afterwards.
 *
 * Both the output path form and the work-area constant are tried in
 * combination: "Unable to initialize export!" is Premiere's answer to a great
 * many different objections, and it does not say which one.
 */
function seedExportViaPreset(sequence, folder, presetPath, seconds, fps, trace) {
    var preset = new File(seedNormalizePath(presetPath));
    if (!preset.exists) {
        trace.push("preset file not found at " + presetPath);
        return null;
    }
    if (typeof sequence.exportAsMediaDirect !== "function") {
        trace.push("sequence.exportAsMediaDirect is not available on this build");
        return null;
    }

    var previousIn = null;
    var previousOut = null;
    try {
        previousIn = sequence.getInPoint();
        previousOut = sequence.getOutPoint();
    } catch (error) {
        trace.push("could not read existing in/out points");
    }

    var startedAt = new Date().getTime() - 2000;
    var base = seedNormalizePath(folder.fsName) + "/seed_still_" + startedAt;
    var written = null;

    try {
        var frameSeconds = fps > 0 ? 1 / fps : 0.04;
        seedSetInOut(sequence, seconds, seconds + frameSeconds, trace);

        // An exporter usually wants the extension; some builds add it itself.
        var paths = [base + ".png", base];

        for (var pi = 0; pi < paths.length && !written; pi++) {
            for (var ti = 0; ti < SEED_WORK_AREA_TYPES.length && !written; ti++) {
                var workAreaType = SEED_WORK_AREA_TYPES[ti];
                var label = "type " + workAreaType + (pi === 0 ? " +.png" : " no ext");
                var returned;
                try {
                    returned = sequence.exportAsMediaDirect(
                        paths[pi],
                        preset.fsName,
                        workAreaType
                    );
                } catch (callError) {
                    trace.push(label + " threw: " + callError);
                    continue;
                }

                var refused = seedExportRefused(returned);
                if (refused) {
                    // Refused outright, so there is nothing to wait for.
                    trace.push(label + ": " + refused);
                    continue;
                }

                for (var wait = 0; wait < 150 && !written; wait++) {
                    $.sleep(100);
                    written = seedNewestSettledFile(folder, startedAt);
                }
                trace.push(label + (written ? " wrote a file" : " returned ok but wrote nothing in 15s"));
            }
        }
    } catch (error) {
        trace.push("preset export failed: " + error);
        written = null;
    } finally {
        try {
            if (previousIn !== null && previousOut !== null) {
                seedSetInOut(
                    sequence,
                    Number(previousIn.seconds),
                    Number(previousOut.seconds),
                    trace
                );
            }
        } catch (restoreError) {
            trace.push("could not restore in/out points: " + restoreError);
        }
    }
    return written;
}

/**
 * Route 3: hand the job to Media Encoder.
 *
 * Slower and it launches AME, but it is a different code path from the direct
 * exporter and can succeed where that one refuses to initialise.
 */
function seedExportViaEncoder(sequence, folder, presetPath, seconds, fps, trace) {
    if (!app.encoder || typeof app.encoder.encodeSequence !== "function") {
        trace.push("AME: app.encoder.encodeSequence is unavailable");
        return null;
    }

    var startedAt = new Date().getTime() - 2000;
    var target = seedNormalizePath(folder.fsName) + "/seed_ame_" + startedAt + ".png";

    try {
        if (typeof app.encoder.launchEncoder === "function") app.encoder.launchEncoder();
        var frameSeconds = fps > 0 ? 1 / fps : 0.04;
        seedSetInOut(sequence, seconds, seconds + frameSeconds, trace);

        /*
         * The work-area constant is read from app.encoder where the build
         * exposes it. Assuming 1 means in-to-out is exactly the sort of guess
         * that produced a first-frame capture: if the constant is wrong, AME
         * encodes the whole sequence and a still exporter writes frame zero,
         * with nothing anywhere reporting a problem.
         */
        var inToOut = 1;
        if (typeof app.encoder.ENCODE_IN_TO_OUT === "number") {
            inToOut = app.encoder.ENCODE_IN_TO_OUT;
        }
        trace.push("AME: work area constant " + inToOut +
            (typeof app.encoder.ENCODE_IN_TO_OUT === "number" ? " (from app.encoder)" : " (assumed)"));

        // What the sequence is actually holding, as opposed to what we asked for.
        try {
            trace.push("AME: sequence in=" + Number(sequence.getInPoint().seconds).toFixed(3) +
                "s out=" + Number(sequence.getOutPoint().seconds).toFixed(3) +
                "s, wanted " + seconds.toFixed(3) + "s");
        } catch (readError) {
            trace.push("AME: could not read back in/out");
        }

        // (sequence, outputPath, presetPath, workAreaType, removeOnCompletion)
        var jobId = app.encoder.encodeSequence(sequence, target, presetPath, inToOut, 0);
        trace.push("AME: encodeSequence returned " + String(jobId));
        if (typeof app.encoder.startBatch === "function") app.encoder.startBatch();
    } catch (error) {
        trace.push("AME: encodeSequence threw: " + error);
        return null;
    }

    // AME is a separate application; give it longer than the direct exporter.
    var written = null;
    for (var wait = 0; wait < 600 && !written; wait++) {
        $.sleep(100);
        written = seedNewestSettledFile(folder, startedAt);
    }
    if (!written) trace.push("AME: nothing appeared within 60s");
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
        if (!sequence) return seedFail(seedNoSequenceMessage());

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

        var trace = [];

        /*
         * Put the playhead on the wanted frame before exporting.
         *
         * A path-only exporter writes whatever the playhead is on, so the time
         * has to be a fact about the sequence rather than an argument. It is
         * where the artist left it in the normal case; this only matters when
         * something else moved it.
         */
        try {
            sequence.setPlayerPosition(
                String(Math.round(seconds * SEED_TICKS_PER_SECOND))
            );
        } catch (moveError) {
            trace.push("could not move the playhead: " + moveError);
        }

        var written = seedExportViaQE(sequence, targetPath, trace);
        var route = "qe";

        if (!written && presetPath) {
            written = seedExportViaPreset(sequence, folder, presetPath, seconds, fps, trace);
            route = "preset";
        }

        if (!written && presetPath) {
            written = seedExportViaEncoder(sequence, folder, presetPath, seconds, fps, trace);
            route = "ame";
        }

        if (!written) {
            // Say what each route actually did, not merely that both failed.
            return seedFail(
                "Premiere wrote no frame. " +
                    (presetPath ? "" : "No still preset configured. ") +
                    "Details: " + trace.join("; ")
            );
        }

        var landedSeconds = null;
        try {
            landedSeconds = Number(sequence.getInPoint().seconds);
        } catch (readError) {
            landedSeconds = null;
        }

        return seedOk({
            path: written.fsName,
            bytes: written.length,
            route: route,
            width: Number(sequence.frameSizeHorizontal) || 0,
            height: Number(sequence.frameSizeVertical) || 0,
            frameNumber: frame,
            timeSeconds: seconds,
            // Success is not the same as correctness here: the export can
            // quietly cover the whole sequence and hand back frame zero.
            inPointSeconds: landedSeconds,
            trace: trace.join(" | ")
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

/** Seconds of media a project item represents, when it will say. */
function seedItemDuration(item) {
    try {
        var out = item.getOutPoint();
        var inn = item.getInPoint();
        if (out && inn) {
            var seconds = Number(out.seconds) - Number(inn.seconds);
            if (seconds > 0) return seconds;
        }
    } catch (error) {
        // Stills and some formats do not answer; fall through.
    }
    return 5;
}

/** True when nothing occupies the track across [from, to). */
function seedTrackIsFree(track, from, to) {
    try {
        for (var i = 0; i < track.clips.numItems; i++) {
            var clip = track.clips[i];
            var clipStart = Number(clip.start.seconds);
            var clipEnd = Number(clip.end.seconds);
            // Touching end-to-start is fine; genuine overlap is not.
            if (clipStart < to - 0.0001 && clipEnd > from + 0.0001) return false;
        }
    } catch (error) {
        // If a track will not report its clips, treat it as occupied rather
        // than risk overwriting an editor's work.
        return false;
    }
    return true;
}

/**
 * Places the clip at the playhead without destroying anything.
 *
 * `overwriteClip` does what its name says, so the track is chosen to be free
 * across the span first: a targeted track if it is clear, otherwise the lowest
 * clear one. If every track is occupied it refuses and says so — an editor's
 * existing shot is not ours to replace, and the earlier behaviour of falling
 * back to V1 overwrote a main track.
 */
function seedInsertAtPlayhead(projectItemId) {
    try {
        var sequence = seedActiveSequence();
        if (!sequence) return seedFail(seedNoSequenceMessage());

        var item = seedFindByNodeId(app.project.rootItem, projectItemId);
        if (!item) return seedFail("project item " + projectItemId + " not found");

        var from = seedPlayheadSeconds(sequence);
        var to = from + seedItemDuration(item);

        var chosen = null;
        var chosenIndex = -1;
        var targetedButBusy = null;

        // A targeted track is the editor's stated intention: honour it when free.
        for (var i = 0; i < sequence.videoTracks.numTracks; i++) {
            var track = sequence.videoTracks[i];
            var targeted = false;
            try {
                targeted = track.isTargeted();
            } catch (error) {
                targeted = false;
            }
            if (!targeted) continue;
            if (seedTrackIsFree(track, from, to)) {
                chosen = track;
                chosenIndex = i;
            } else if (!targetedButBusy) {
                targetedButBusy = "V" + (i + 1);
            }
            if (chosen) break;
        }

        if (!chosen) {
            for (var j = 0; j < sequence.videoTracks.numTracks; j++) {
                if (seedTrackIsFree(sequence.videoTracks[j], from, to)) {
                    chosen = sequence.videoTracks[j];
                    chosenIndex = j;
                    break;
                }
            }
        }

        if (!chosen) {
            return seedFail(
                "every video track already has a clip at the playhead. Add a video " +
                    "track, or move the playhead, so nothing is overwritten."
            );
        }

        chosen.overwriteClip(item, from);

        return seedOk({
            trackName: "V" + (chosenIndex + 1),
            trackIndex: chosenIndex,
            name: item.name,
            atSeconds: from,
            durationSeconds: to - from,
            movedFromTargeted: targetedButBusy
        });
    } catch (error) {
        return seedFail(error);
    }
}

/**
 * Adopts a frame Premiere itself exported.
 *
 * Premiere's own Export Frame button works perfectly and every scripted route
 * to the same result does not — four of them returned the first frame of the
 * sequence while reporting success. So this stops trying to replace the button
 * and picks up after it instead: the artist exports into the SEED folder with
 * Ctrl+Shift+E, and this finds what landed.
 *
 * Only files newer than the moment the panel started waiting are considered,
 * so an older export can never be adopted twice or mistaken for a new one.
 */
function seedPickupFrame(outputDir, sinceMs) {
    try {
        var folder = seedEnsureFolder(outputDir);
        if (!folder.exists) {
            return seedFail("could not open the SEED folder: " + outputDir);
        }

        var files = folder.getFiles();
        var newest = null;
        var since = Number(sinceMs) || 0;

        for (var i = 0; i < files.length; i++) {
            var file = files[i];
            if (!(file instanceof File)) continue;
            if (!/\.(png|jpg|jpeg|tif|tiff|tga|dpx)$/i.test(file.name)) continue;
            if (file.modified.getTime() < since) continue;
            if (!newest || file.modified.getTime() > newest.modified.getTime()) {
                newest = file;
            }
        }

        if (!newest) {
            return seedFail(
                "no exported frame found in " + outputDir + ". Use Export Frame " +
                    "(Ctrl+Shift+E) in the Program Monitor, save it there, then " +
                    "try again."
            );
        }

        var sequence = seedActiveSequence();
        var seconds = sequence ? seedPlayheadSeconds(sequence) : 0;
        var fps = sequence ? seedSequenceFps(sequence) : 0;

        return seedOk({
            path: newest.fsName,
            bytes: newest.length,
            width: sequence ? Number(sequence.frameSizeHorizontal) || 0 : 0,
            height: sequence ? Number(sequence.frameSizeVertical) || 0 : 0,
            frameNumber: fps > 0 ? Math.round(seconds * fps) : 0,
            timeSeconds: seconds,
            route: "export-frame"
        });
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

/*
 * Host-specific aliases.
 *
 * Both host scripts run in ONE shared ExtendScript engine, and CEP re-evaluates
 * whichever ScriptPath its manifest dispatch chose — on its own schedule, after
 * the panel has loaded the script it wants. With shared names the last writer
 * won, which is how a Premiere panel ended up running After Effects'
 * seedCaptureFrame and reporting "[after-effects] no active composition".
 *
 * Unique names per host end the fight: CEP can redefine the generic names as
 * often as it likes, and the panel calls these instead.
 */

var seedPpro_ping = seedPing;
var seedPpro_getContext = seedGetContext;
var seedPpro_captureFrame = seedCaptureFrame;
var seedPpro_pickupFrame = seedPickupFrame;
var seedPpro_import = seedImport;
var seedPpro_insertAtPlayhead = seedInsertAtPlayhead;
