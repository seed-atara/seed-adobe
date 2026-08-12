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
/**
 * Renames `frame.png.png` to `frame.png`.
 *
 * Premiere 25.3 and later append the format's extension to whatever path they
 * are given, so a request for `frame.png` produces `frame.png.png`. The file
 * is correct; only its name is wrong, and a library full of doubled extensions
 * is a lasting reminder of a bug that took one line to undo.
 */
function seedDropDoubledExtension(file, extension, trace) {
    var doubled = extension + extension;
    var name = file.name;
    if (name.length <= doubled.length) return file;
    if (name.substr(name.length - doubled.length).toLowerCase() !== doubled) return file;

    var wanted = name.substr(0, name.length - extension.length);
    try {
        var target = new File(file.path + "/" + wanted);
        // The intended name was chosen to be free, but never overwrite blindly.
        if (target.exists) return file;
        if (file.rename(wanted)) {
            var renamed = new File(file.path + "/" + wanted);
            if (renamed.exists) return renamed;
        }
        trace.push("could not rename " + name);
    } catch (error) {
        trace.push("could not rename " + name + ": " + error);
    }
    return file;
}

/**
 * Route 0: a frame exporter on the sequence itself.
 *
 * Reported to exist as `sequence.exportFrameAsPNG(time, path)` — no QE DOM, no
 * Media Encoder, an explicit time, and a boolean back. If it is real on this
 * build it is exactly the right call: every other route either ignores the time
 * it is given or has to be guessed at.
 *
 * It is not in the scripting guide, so rather than trust it or dismiss it the
 * build is asked directly. Whatever happens, the trace names which of these
 * methods exist here — which is the inventory that would have saved the last
 * six attempts.
 */
function seedExportViaSequenceApi(sequence, folder, targetPath, seconds, trace) {
    var candidates = [
        ["exportFrameAsPNG", ".png"],
        ["exportFramePNG", ".png"],
        ["exportFrameAsJPEG", ".jpg"],
        ["exportFrameJPEG", ".jpg"],
        ["exportFrameAsTIFF", ".tif"],
        ["exportFrameAsDPX", ".dpx"]
    ];

    var present = [];
    for (var c = 0; c < candidates.length; c++) {
        if (typeof sequence[candidates[c][0]] === "function") present.push(candidates[c][0]);
    }
    trace.push("sequence frame exporters: " + (present.length ? present.join(", ") : "none"));
    if (present.length === 0) return null;

    var playhead = null;
    try {
        playhead = sequence.getPlayerPosition();
    } catch (error) {
        trace.push("could not read the playhead as a Time object");
    }

    for (var i = 0; i < candidates.length; i++) {
        var method = candidates[i][0];
        var extension = candidates[i][1];
        if (typeof sequence[method] !== "function") continue;

        var base = targetPath.replace(/\.[^.]+$/, "") + extension;

        // The reported form passes the Time object; the others cost nothing.
        var times = [];
        if (playhead) times.push(["Time object", playhead]);
        times.push(["seconds", seconds]);
        times.push(["ticks", String(Math.round(seconds * SEED_TICKS_PER_SECOND))]);

        for (var t = 0; t < times.length; t++) {
            var label = method + " with " + times[t][0];
            var startedAt = new Date().getTime() - 1000;
            var returned;
            try {
                returned = sequence[method](times[t][1], base);
            } catch (error) {
                trace.push(label + " threw: " + error);
                continue;
            }

            // The double-extension bug applies here too, so look around.
            var written = seedAwaitFile(base);
            if (!written) written = seedAwaitFile(base + extension);
            if (!written) written = seedNewestSettledFile(folder, startedAt);

            if (written) {
                written = seedDropDoubledExtension(written, extension, trace);
                trace.push(label + " wrote " + written.name);
                return written;
            }
            trace.push(label + " returned " + String(returned) + ", no file");
        }
    }

    return null;
}

/** A path in the form the host operating system writes natively. */
function seedNativePath(value) {
    var text = String(value);
    if ($.os && $.os.indexOf("Windows") !== -1) return text.replace(/\//g, "\\");
    return text;
}

/**
 * Route 1: the QE DOM frame exporters.
 *
 * These are the scripted equivalent of the Export Frame button, and they are
 * undocumented, so every assumption about them has to be tested rather than
 * believed. Three were wrong at once, which is why this tries a matrix instead
 * of a call:
 *
 *   - the path separator. SEED normalises paths to forward slashes, which most
 *     of the API tolerates. The QE DOM predates that tolerance, and a path it
 *     cannot open is reported as "Unknown error exception" — the same message
 *     as everything else it dislikes.
 *   - the directory. The workspace lives under a dot-prefixed folder, which is
 *     ordinary on disk and unusual for a 2003-era API.
 *   - the format. If PNG is broken and JPEG is not, a JPEG frame is a perfectly
 *     good reference and worth having.
 *
 * Every attempt records what it was and what it got, so a failure narrows the
 * matrix instead of restarting the guessing.
 */
function seedExportViaQE(sequence, folder, targetPath, trace) {
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

    var timecode = null;
    try {
        timecode = qeSequence.CTI.timecode;
    } catch (ctiError) {
        trace.push("QE: could not read the playhead timecode");
    }

    // Somewhere with no dot-folder in the path, as a control.
    var plain = seedNormalizePath(Folder.temp.fsName) + "/seed_frame_" +
        new Date().getTime();

    var formats = [
        ["PNG", "exportFramePNG", ".png"],
        ["JPEG", "exportFrameJPEG", ".jpg"],
        ["Targa", "exportFrameTarga", ".tga"]
    ];

    for (var f = 0; f < formats.length; f++) {
        var label = formats[f][0];
        var method = formats[f][1];
        var extension = formats[f][2];

        if (typeof qeSequence[method] !== "function") {
            trace.push("QE: " + method + " is not defined on this build");
            continue;
        }

        var base = targetPath.replace(/\.[^.]+$/, "") + extension;
        var control = plain + extension;

        var candidates = [
            ["native path", seedNativePath(base), base],
            ["forward path", base, base],
            ["native temp", seedNativePath(control), control],
            ["forward temp", control, control]
        ];

        for (var c = 0; c < candidates.length; c++) {
            var how = candidates[c][0];
            var handed = candidates[c][1];
            var onDisk = candidates[c][2];

            var forms = timecode === null
                ? [["path only", [handed]]]
                : [
                    ["timecode first", [timecode, handed]],
                    ["path only", [handed]]
                ];

            for (var a = 0; a < forms.length; a++) {
                var shape = forms[a][0];
                var args = forms[a][1];
                var what = label + " " + how + " " + shape;
                var attemptedAt = new Date().getTime() - 1000;

                try {
                    if (args.length === 1) qeSequence[method](args[0]);
                    else qeSequence[method](args[0], args[1]);
                } catch (error) {
                    trace.push("QE " + what + ": " + error);
                    continue;
                }

                /*
                 * Look for what landed rather than for what was asked for. On
                 * Premiere 25.3 and later this exporter appends a second
                 * extension, so a check against the exact path reports a
                 * silent failure for a file that is sitting right there.
                 */
                var written = seedAwaitFile(onDisk);
                if (!written) written = seedAwaitFile(onDisk + extension);
                if (!written && onDisk.indexOf(seedNormalizePath(folder.fsName)) === 0) {
                    written = seedNewestSettledFile(folder, attemptedAt);
                }
                if (written) {
                    written = seedDropDoubledExtension(written, extension, trace);
                    trace.push("QE wrote via " + what);
                    // A control write lands outside the workspace; the service
                    // only registers media it owns, so bring it home.
                    if (onDisk !== base) {
                        try {
                            written.copy(base);
                            var moved = seedAwaitFile(base);
                            if (moved) {
                                try { written.remove(); } catch (cleanupError) {}
                                return moved;
                            }
                        } catch (copyError) {
                            trace.push("QE: could not copy into the workspace: " + copyError);
                        }
                    }
                    return written;
                }
                trace.push("QE " + what + ": no error, no file");
            }
        }
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
/**
 * Sets the sequence in/out, in seconds.
 *
 * Seconds is what the API wants, on the authority of Adobe's own PProPanel
 * sample, which writes `seq.setInPoint(currentTime.seconds)`. An earlier guess
 * here that the call took ticks was wrong and made things worse.
 */
function seedSetInOut(sequence, inSeconds, outSeconds, trace) {
    try {
        sequence.setInPoint(inSeconds);
        sequence.setOutPoint(outSeconds);
        return true;
    } catch (error) {
        trace.push("could not set in/out: " + error);
        return false;
    }
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
/**
 * Route 1: Media Encoder, the way Adobe's own panel does it.
 *
 * This mirrors `exportCurrentFrameAsPNG` in the PProPanel sample, which is the
 * sanctioned way to get one frame out of a sequence and the reference the
 * Adobe forums point at. Earlier attempts here differed from it in three ways,
 * each enough on its own to produce a first-frame export that reported
 * success:
 *
 *   - in/out were set in ticks after a wrong guess about the units. The sample
 *     passes seconds.
 *   - encodeSequence was called with five arguments. It takes six; the missing
 *     one says whether to start the queue.
 *   - the in/out were restored in a `finally`, which on the direct route runs
 *     before Media Encoder has read the sequence.
 *
 * The range is restored immediately after the call, exactly as the sample
 * does — the encoder has taken what it needs by then.
 */
function seedExportViaEncoder(sequence, folder, presetPath, seconds, fps, trace) {
    if (!app.encoder || typeof app.encoder.encodeSequence !== "function") {
        trace.push("AME: app.encoder.encodeSequence is unavailable");
        return null;
    }

    var startedAt = new Date().getTime() - 2000;
    var target = seedNormalizePath(folder.fsName) + "/seed_ame_" + startedAt + ".png";

    var previousIn = null;
    var previousOut = null;
    try {
        previousIn = sequence.getInPointAsTime();
        previousOut = sequence.getOutPointAsTime();
    } catch (error) {
        trace.push("AME: could not read the existing in/out");
    }

    try {
        if (typeof app.encoder.launchEncoder === "function") app.encoder.launchEncoder();

        // One frame long. The sample uses a flat 0.033s; the sequence's own
        // frame duration is the same idea without assuming 30fps.
        var frameSeconds = fps > 0 ? 1 / fps : 0.033;
        seedSetInOut(sequence, seconds, seconds + frameSeconds, trace);

        /*
         * Report the constants rather than assume them. If ENCODE_IN_TO_OUT is
         * not exposed, the fallback of 1 is a guess — and if 1 happens to mean
         * "entire sequence" on this build, Media Encoder renders the whole
         * thing and a still exporter writes frame zero, which is exactly the
         * symptom we cannot otherwise explain.
         */
        trace.push("AME constants: entire=" + String(app.encoder.ENCODE_ENTIRE) +
            " inToOut=" + String(app.encoder.ENCODE_IN_TO_OUT) +
            " workArea=" + String(app.encoder.ENCODE_WORK_AREA));

        var inToOut = typeof app.encoder.ENCODE_IN_TO_OUT === "number"
            ? app.encoder.ENCODE_IN_TO_OUT
            : 1;

        try {
            trace.push("AME: in=" + Number(sequence.getInPointAsTime().seconds).toFixed(3) +
                "s out=" + Number(sequence.getOutPointAsTime().seconds).toFixed(3) +
                "s (wanted " + seconds.toFixed(3) + "s), mode " + inToOut);
        } catch (readError) {
            trace.push("AME: could not read back the range");
        }

        // (sequence, outputPath, preset, workAreaType, removeUponCompletion,
        //  startQueueImmediately) — six, not five.
        var jobId = app.encoder.encodeSequence(
            sequence,
            target,
            presetPath,
            inToOut,
            1,
            true
        );
        trace.push("AME: encodeSequence returned " + String(jobId));
    } catch (error) {
        trace.push("AME: encodeSequence threw: " + error);
        return null;
    } finally {
        // Put the editor's own range back straight away, as the sample does.
        if (previousIn !== null && previousOut !== null) {
            try {
                sequence.setInPoint(Number(previousIn.seconds));
                sequence.setOutPoint(Number(previousOut.seconds));
            } catch (restoreError) {
                trace.push("AME: could not restore the in/out");
            }
        }
    }

    // Media Encoder is a separate application, and it may add its own
    // extension, so the folder is watched rather than one exact path.
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

        /*
         * Media Encoder goes last, despite being what Adobe's own sample uses.
         *
         * On this build it is verifiably given the right range — in=10.000s,
         * out=10.040s, mode ENCODE_IN_TO_OUT as the encoder itself defines it
         * — and returns the first frame of the sequence anyway. Its still
         * exporter ignores the range. Nothing in the call can fix that, and a
         * route that confidently returns the wrong frame is worse than one
         * that returns nothing, because it also stops every other route from
         * being tried.
         */
        // The sequence's own exporter first: an explicit time, no encoder.
        var written = seedExportViaSequenceApi(
            sequence, folder, targetPath, seconds, trace
        );
        var route = "sequence";

        if (!written) {
            written = seedExportViaQE(sequence, folder, targetPath, trace);
            route = "qe";
        }

        if (!written && presetPath) {
            written = seedExportViaPreset(sequence, folder, presetPath, seconds, fps, trace);
            route = "preset";
        }

        if (!written && presetPath) {
            trace.push("falling back to Media Encoder, which on some builds " +
                "returns the first frame regardless of the range");
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
function seedInsertAtPlayhead(projectItemId, insertedWidth) {
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

        /*
         * Fit the frame, for the same reason After Effects does: a generated
         * clip is rarely the sequence's exact size, and left alone it sits in
         * the middle of it with black around the edges.
         */
        var placed = seedFindPlaceholderClip(sequence, chosenIndex, from, null);
        if (placed) {
            var frameWidth = Number(sequence.frameSizeHorizontal) || 0;
            var mediaWidth = Number(insertedWidth) || 0;
            if (frameWidth > 0 && mediaWidth > 0 && frameWidth !== mediaWidth) {
                seedSetClipScale(placed, (frameWidth / mediaWidth) * 100);
            }
        }

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

// -------------------------------------------------------------- placeholders

/*
 * Holding a cut open while a video renders.
 *
 * Each reservation imports the placeholder card *again*, so it gets its own
 * project item. That matters: the swap is `changeMediaPath`, which changes what
 * a project item points at — share one item between two placeholders and
 * filling one would fill both.
 *
 * Swapping rather than replacing the clip means the artist can trim, move or
 * effect the placeholder while they wait and keep all of it.
 */

var SEED_PENDING_PREFIX = "SEED pending";

/**
 * Imports a file into SEED's bin and returns the item that arrived.
 *
 * The bin is counted before and after rather than trusting a return value:
 * importFiles reports nothing useful, and the last child is only the new one
 * if something was actually added.
 */
function seedImportIntoBin(file) {
    var bin = seedSeedBin();
    var before = bin.children.numItems;
    app.project.importFiles([file.fsName], true, bin, false);
    if (bin.children.numItems <= before) return null;
    return bin.children[bin.children.numItems - 1];
}

/**
 * Sets a clip's Motion scale, as a percentage.
 *
 * `setScaleToFrameSize` governs what happens when media is *next* placed; it
 * does not retouch a clip already on the timeline. Swapping media underneath
 * one therefore leaves the scale that suited the old media, and the only way
 * to correct it is to write the property.
 *
 * Matched on matchName where possible — a display name is localised, and this
 * should work in a Premiere that is not in English.
 */
function seedSetClipScale(clip, percent) {
    try {
        for (var i = 0; i < clip.components.numItems; i++) {
            var component = clip.components[i];
            var isMotion =
                String(component.matchName) === "AE.ADBE Motion" ||
                String(component.displayName) === "Motion";
            if (!isMotion) continue;

            for (var p = 0; p < component.properties.numItems; p++) {
                var property = component.properties[p];
                if (String(property.displayName) !== "Scale") continue;
                property.setValue(percent, true);
                return true;
            }
        }
    } catch (error) {
        // Framing is recoverable by hand; the swap is not.
    }
    return false;
}

/**
 * The clip a placeholder was reserved as.
 *
 * Found by name first, across every track. Reserved space is there to be
 * worked with — moved, trimmed, slid against the shot before it — and a
 * placeholder identified by where it was originally put stops being findable
 * the moment the artist does any of that. The project item carries the label,
 * and dragging a clip does not rename it.
 *
 * Position is the fallback, for a placeholder made before this and for anything
 * that has lost its name.
 */
function seedFindPlaceholderClip(sequence, trackIndex, startSeconds, label) {
    if (label) {
        for (var t = 0; t < sequence.videoTracks.numTracks; t++) {
            var searched = sequence.videoTracks[t];
            for (var c = 0; c < searched.clips.numItems; c++) {
                var candidate = searched.clips[c];
                try {
                    var name = String(candidate.projectItem.name);
                    if (name.indexOf(SEED_PENDING_PREFIX) === 0 &&
                        name.indexOf(label) !== -1) {
                        return candidate;
                    }
                } catch (error) {
                    // A clip without a readable item is not the one.
                }
            }
        }
    }

    if (trackIndex < 0 || trackIndex >= sequence.videoTracks.numTracks) return null;
    var track = sequence.videoTracks[trackIndex];
    for (var i = 0; i < track.clips.numItems; i++) {
        var clip = track.clips[i];
        if (Math.abs(Number(clip.start.seconds) - startSeconds) < 0.25) return clip;
    }
    return null;
}

/*
 * Iterating on a shot that is already in the sequence.
 *
 * Same intent as After Effects, different mechanics. There the layer's source
 * is swapped and everything built on the layer survives; here the clip's media
 * cannot be swapped, because `changeMediaPath` acts on the *project item* and
 * that item is the library's copy of the render — pointing it at a striped card
 * would change every clip using it, and corrupt the library entry besides.
 *
 * So Premiere adopts by overwriting the clip's own span with a placeholder and
 * carrying the framing across by hand. Effects on the old clip do not survive
 * that, which is the honest cost of the route Premiere leaves open; the scale
 * does, because losing it is what makes a swap look broken.
 */

/** Reads a clip's Motion scale, as a percentage. */
function seedClipScale(clip) {
    try {
        for (var i = 0; i < clip.components.numItems; i++) {
            var component = clip.components[i];
            if (String(component.matchName) !== "AE.ADBE Motion" &&
                String(component.displayName) !== "Motion") continue;
            for (var p = 0; p < component.properties.numItems; p++) {
                if (String(component.properties[p].displayName) !== "Scale") continue;
                return Number(component.properties[p].getValue()) || 100;
            }
        }
    } catch (error) {
        // Reported as the default; the swap matters more than the framing.
    }
    return 100;
}

/** Whether a clip is backed by media of this name. */
function seedClipHasFile(clip, filename) {
    try {
        var item = clip.projectItem;
        if (!item) return false;
        var media = new File(String(item.getMediaPath()));
        return String(media.name) === String(filename);
    } catch (error) {
        return false;
    }
}

/** The clip the artist has selected, wherever it sits. */
function seedSelectedClip(sequence) {
    for (var t = 0; t < sequence.videoTracks.numTracks; t++) {
        var track = sequence.videoTracks[t];
        for (var c = 0; c < track.clips.numItems; c++) {
            var clip = track.clips[c];
            try {
                if (clip.isSelected()) return { clip: clip, trackIndex: t };
            } catch (error) {
                // Older builds without isSelected: treated as not selected.
            }
        }
    }
    return null;
}

/** Describes the media under the selection, so the panel can find its recipe. */
function seedSelectedMedia() {
    try {
        var sequence = seedActiveSequence();
        if (!sequence) return seedFail(seedNoSequenceMessage());

        var found = seedSelectedClip(sequence);
        if (!found) return seedFail("select the clip you want to iterate on");

        var clip = found.clip;
        var item = clip.projectItem;
        if (!item) return seedFail(clip.name + " is not backed by a project item");

        var mediaPath = "";
        try {
            mediaPath = String(item.getMediaPath());
        } catch (pathError) {
            mediaPath = "";
        }
        if (!mediaPath) return seedFail(clip.name + " has no file on disk");

        var file = new File(mediaPath);

        return seedOk({
            path: file.fsName,
            filename: file.name,
            layerName: String(clip.name),
            trackIndex: found.trackIndex,
            trackName: "V" + (found.trackIndex + 1),
            startSeconds: Number(clip.start.seconds),
            endSeconds: Number(clip.end.seconds),
            durationSeconds: Number(clip.end.seconds) - Number(clip.start.seconds),
            scalePercent: seedClipScale(clip),
            inRegion: false,
            regionName: null
        });
    } catch (error) {
        return seedFail(error);
    }
}

/**
 * Turns a clip already in the sequence into the pending placeholder.
 *
 * The old clip's project item goes back to the caller so a failed render can
 * put the take back where it was — iterating must not cost the artist the
 * version they already had.
 */
function seedAdoptPlaceholder(placeholderPath, label, trackIndex, startSeconds, expectedFile) {
    try {
        var sequence = seedActiveSequence();
        if (!sequence) return seedFail(seedNoSequenceMessage());

        var index = Number(trackIndex);
        if (index < 0 || index >= sequence.videoTracks.numTracks) {
            return seedFail("track V" + (index + 1) + " is no longer in the sequence");
        }

        var clip = seedFindPlaceholderClip(sequence, index, Number(startSeconds), null);
        if (!clip) {
            return seedFail("the clip to iterate on is no longer where it was");
        }

        /*
         * Confirm it is still the same shot before overwriting anything.
         *
         * Clips are found by where they sit, and a clip that has been nudged
         * along the track since it was selected leaves a different one at that
         * time. Overwriting whatever is now there would destroy unrelated
         * work, so the media is checked before the card goes down.
         */
        if (expectedFile && !seedClipHasFile(clip, expectedFile)) {
            return seedFail(
                "the clip at that point is no longer " + expectedFile +
                    " — select the shot again so there is no doubt which one " +
                    "to replace"
            );
        }

        var file = new File(seedNormalizePath(placeholderPath));
        if (!file.exists) return seedFail("placeholder media not found");

        var from = Number(clip.start.seconds);
        var to = Number(clip.end.seconds);
        var scalePercent = seedClipScale(clip);
        var restoreItem = clip.projectItem;
        var restoreName = String(clip.name);
        var restoreNodeId = null;
        try {
            restoreNodeId = String(restoreItem.nodeId);
        } catch (idError) {
            restoreNodeId = null;
        }

        // Imported per reservation, for the reason reserve gives: changeMediaPath
        // acts on the item, so a shared card would swap every placeholder at once.
        var card = seedImportIntoBin(file);
        if (!card) return seedFail("could not import the placeholder card");
        try {
            card.name = SEED_PENDING_PREFIX + " " + label;
        } catch (nameError) {
            // A name is a convenience; the clip is found by position.
        }

        sequence.videoTracks[index].overwriteClip(card, from);

        var placed = seedFindPlaceholderClip(sequence, index, from, label);
        if (placed) {
            try {
                var end = placed.end;
                end.seconds = to;
                placed.end = end;
            } catch (endError) {
                // A still's default length stands if the end cannot be set.
            }
            if (scalePercent > 0 && scalePercent !== 100) {
                seedSetClipScale(placed, scalePercent);
            }
        }

        return seedOk({
            label: label,
            trackIndex: index,
            trackName: "V" + (index + 1),
            atSeconds: from,
            durationSeconds: to - from,
            scalePercent: scalePercent,
            restoreNodeId: restoreNodeId,
            restoreName: restoreName
        });
    } catch (error) {
        return seedFail(error);
    }
}

/** Puts a placeholder at the playhead for the length the render will be. */
function seedReservePlaceholder(placeholderPath, durationSeconds, label) {
    try {
        var sequence = seedActiveSequence();
        if (!sequence) return seedFail(seedNoSequenceMessage());

        var file = new File(seedNormalizePath(placeholderPath));
        if (!file.exists) return seedFail("placeholder media not found");

        var seconds = Number(durationSeconds) > 0 ? Number(durationSeconds) : 5;
        var from = seedPlayheadSeconds(sequence);
        var to = from + seconds;

        // A free track, on the same terms as any other insert: never overwrite.
        var chosen = null;
        var chosenIndex = -1;
        for (var i = 0; i < sequence.videoTracks.numTracks; i++) {
            if (seedTrackIsFree(sequence.videoTracks[i], from, to)) {
                chosen = sequence.videoTracks[i];
                chosenIndex = i;
                break;
            }
        }
        if (!chosen) {
            return seedFail(
                "every video track already has a clip at the playhead, so there " +
                    "is nowhere to hold the space without overwriting something"
            );
        }

        // Imported per reservation: changeMediaPath acts on the project item,
        // so a shared one would swap every placeholder at once.
        var item = seedImportIntoBin(file);
        if (!item) return seedFail("could not import the placeholder card");
        try {
            item.name = SEED_PENDING_PREFIX + " " + label;
        } catch (nameError) {
            // A name is a convenience; the clip is found by position.
        }

        chosen.overwriteClip(item, from);
        var clip = seedFindPlaceholderClip(sequence, chosenIndex, from, null);
        if (clip) {
            try {
                // Clip ends are Time objects; ticks is the durable unit.
                var end = clip.end;
                end.seconds = to;
                clip.end = end;
            } catch (endError) {
                // A still's default length stands if the end cannot be set.
            }
        }

        return seedOk({
            label: label,
            trackIndex: chosenIndex,
            trackName: "V" + (chosenIndex + 1),
            atSeconds: from,
            durationSeconds: seconds
        });
    } catch (error) {
        return seedFail(error);
    }
}

/**
 * Swaps the finished render in underneath the placeholder.
 *
 * `changeMediaPath` returns 0 on success and keeps the timeline clip, so the
 * artist's trims and effects survive. It is a still becoming a video, which is
 * a media type change the API may refuse — so a refusal falls back to replacing
 * the clip, which is certain but forgets any trimming.
 */
function seedFillPlaceholder(trackIndex, startSeconds, mediaPath, label, cardWidth, mediaWidth) {
    try {
        var sequence = seedActiveSequence();
        if (!sequence) return seedFail(seedNoSequenceMessage());

        var file = new File(seedNormalizePath(mediaPath));
        if (!file.exists) return seedFail("file not found: " + mediaPath);

        var clip = seedFindPlaceholderClip(
            sequence, trackIndex, Number(startSeconds), label
        );
        if (!clip) {
            return seedFail(
                "could not find the placeholder for " + label + " — it may have " +
                    "been deleted, or its clip renamed"
            );
        }

        var swapped = false;
        try {
            if (clip.projectItem &&
                typeof clip.projectItem.changeMediaPath === "function") {
                // The second argument overrides the compatibility checks, which
                // a still-to-video change would otherwise fail.
                var result = clip.projectItem.changeMediaPath(file.fsName, true);
                swapped = (result === 0 || result === true);
                if (swapped) {
                    try { clip.projectItem.name = file.name; } catch (nameError) {}
                    /*
                     * The clip keeps the scale that suited the card, and the
                     * render is rarely the same size — the card could only ever
                     * be a prediction of what the model would return. Correct
                     * it by exactly the ratio between the two, which fixes the
                     * swap and keeps any scaling the artist did while waiting.
                     */
                    var card = Number(cardWidth);
                    var media = Number(mediaWidth);
                    if (card > 0 && media > 0 && card !== media) {
                        var current = 100;
                        try {
                            for (var ci = 0; ci < clip.components.numItems; ci++) {
                                var comp = clip.components[ci];
                                if (String(comp.matchName) !== "AE.ADBE Motion" &&
                                    String(comp.displayName) !== "Motion") continue;
                                for (var pi = 0; pi < comp.properties.numItems; pi++) {
                                    if (String(comp.properties[pi].displayName) !== "Scale") continue;
                                    current = Number(comp.properties[pi].getValue()) || 100;
                                    break;
                                }
                                break;
                            }
                        } catch (readError) {
                            current = 100;
                        }
                        seedSetClipScale(clip, (current * card) / media);
                    }
                }
            }
        } catch (swapError) {
            swapped = false;
        }

        if (!swapped) {
            // Certain, but it forgets any trimming the artist did while waiting.
            var track = sequence.videoTracks[trackIndex];
            var at = Number(clip.start.seconds);
            try { clip.remove(false, true); } catch (removeError) {}
            var item = seedImportIntoBin(file);
            if (!item) return seedFail("could not import the finished render");
            track.overwriteClip(item, at);
        }

        return seedOk({
            name: file.name,
            trackName: "V" + (trackIndex + 1),
            atSeconds: Number(startSeconds),
            swapped: swapped,
            cardWidth: Number(cardWidth) || null,
            mediaWidth: Number(mediaWidth) || null
        });
    } catch (error) {
        return seedFail(error);
    }
}

/**
 * Marks a placeholder as failed.
 *
 * Renamed rather than removed: the artist may have built around it, and
 * deleting something they were relying on is a worse answer than leaving it
 * there saying what went wrong.
 */
function seedFailPlaceholder(trackIndex, startSeconds, message, label, restoreNodeId) {
    try {
        var sequence = seedActiveSequence();
        if (!sequence) return seedFail(seedNoSequenceMessage());

        var clip = seedFindPlaceholderClip(
            sequence, trackIndex, Number(startSeconds), label
        );
        if (!clip) return seedOk({ name: null });

        /*
         * An adopted clip had a take in it before this attempt. Put it back: a
         * failed iteration should cost the artist the wait and nothing else,
         * and a striped card where their shot used to be is a worse outcome
         * than the take they already had.
         */
        if (restoreNodeId) {
            var previous = seedFindByNodeId(app.project.rootItem, String(restoreNodeId));
            if (previous) {
                var from = Number(clip.start.seconds);
                var to = Number(clip.end.seconds);
                var scalePercent = seedClipScale(clip);
                try {
                    sequence.videoTracks[Number(trackIndex)].overwriteClip(previous, from);
                    var back = seedFindPlaceholderClip(
                        sequence, Number(trackIndex), from, null
                    );
                    if (back) {
                        try {
                            var end = back.end;
                            end.seconds = to;
                            back.end = end;
                        } catch (endError) {
                            // The restored clip's own length stands.
                        }
                        if (scalePercent > 0 && scalePercent !== 100) {
                            seedSetClipScale(back, scalePercent);
                        }
                    }
                    return seedOk({ name: String(previous.name), restored: true });
                } catch (restoreError) {
                    // Fall through to naming: saying what happened beats
                    // leaving the artist with neither take nor explanation.
                }
            }
        }

        try {
            clip.projectItem.name =
                "SEED failed - " + String(message || "generation failed").substr(0, 60);
        } catch (nameError) {
            // Naming is a courtesy; the clip staying put is the point.
        }
        return seedOk({ name: label, restored: false });
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
var seedPpro_reservePlaceholder = seedReservePlaceholder;
var seedPpro_fillPlaceholder = seedFillPlaceholder;
var seedPpro_failPlaceholder = seedFailPlaceholder;
var seedPpro_selectedMedia = seedSelectedMedia;
var seedPpro_adoptPlaceholder = seedAdoptPlaceholder;
var seedPpro_import = seedImport;
var seedPpro_insertAtPlayhead = seedInsertAtPlayhead;
