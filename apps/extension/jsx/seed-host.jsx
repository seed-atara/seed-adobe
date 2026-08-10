/**
 * SEED / AE — ExtendScript host.
 *
 * This is the only code in the product that touches After Effects objects.
 * It is called from the CEP panel through evalScript, and every function
 * returns a JSON string so the panel never has to parse ExtendScript values.
 *
 * ExtendScript is ES3: no JSON, no Array.prototype.map, no const/let, no
 * arrow functions. Keep it plain.
 */

// ---------------------------------------------------------------- utilities

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

/** Minimal JSON serialiser — ExtendScript has none. */
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
    return seedJson({ ok: false, error: "[after-effects] " + String(message) });
}

function seedActiveComp() {
    var item = app.project ? app.project.activeItem : null;
    if (!item || !(item instanceof CompItem)) return null;
    return item;
}

// ------------------------------------------------------------------ context

/** Everything the panel needs to describe "what AE is showing right now". */
function seedGetContext() {
    try {
        if (!app.project) return seedFail("no project is open");

        var context = {};
        var file = app.project.file;
        if (file) {
            context.projectName = file.name;
            context.projectPath = file.fsName;
        }

        var comp = seedActiveComp();
        if (comp) {
            context.compName = comp.name;
            context.compId = String(comp.id);
            context.width = comp.width;
            context.height = comp.height;
            context.fps = comp.frameRate;
            context.timeSeconds = comp.time;
            context.frameNumber = Math.round(comp.time * comp.frameRate);
            context.durationSeconds = comp.duration;
            context.workAreaStartSeconds = comp.workAreaStart;
            context.workAreaDurationSeconds = comp.workAreaDuration;

            var selected = [];
            for (var i = 0; i < comp.selectedLayers.length; i++) {
                var layer = comp.selectedLayers[i];
                selected.push({ id: String(layer.index), name: layer.name });
            }
            if (selected.length > 0) context.selectedLayers = selected;
        }

        return seedOk({ context: context });
    } catch (error) {
        return seedFail(error);
    }
}

// ------------------------------------------------------------------ capture

/** ExtendScript paths are happiest with forward slashes. */
function seedNormalizePath(value) {
    return String(value).replace(/\\/g, "/");
}

/** Folder.create() only makes the leaf, so build the chain ourselves. */
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

/**
 * Renders the frame under the playhead to a PNG.
 *
 * `saveFrameToPng` is a direct still export — it does not touch the render
 * queue, so it neither disturbs the user's queue nor requires a template.
 */
function seedCaptureFrame(outputDir, basename) {
    // A third argument (the Premiere still preset) is accepted and ignored,
    // so the panel can call both hosts identically.
    try {
        var comp = seedActiveComp();
        if (!comp) return seedFail("no active composition");
        if (typeof comp.saveFrameToPng !== "function") {
            return seedFail(
                "this After Effects version has no CompItem.saveFrameToPng"
            );
        }

        var folder = seedEnsureFolder(outputDir);
        if (!folder.exists) {
            return seedFail("could not create output folder: " + outputDir);
        }

        var frame = Math.round(comp.time * comp.frameRate);
        var safe = String(basename || comp.name).replace(/[^A-Za-z0-9._-]+/g, "_");
        var stamp = String(frame);
        while (stamp.length < 5) stamp = "0" + stamp;

        // Never overwrite an existing capture: each one is an immutable source.
        var attempt = 1;
        var target;
        do {
            var suffix = String(attempt);
            while (suffix.length < 3) suffix = "0" + suffix;
            target = new File(
                seedNormalizePath(folder.fsName) + "/" + safe + "_f" + stamp + "_" + suffix + ".png"
            );
            attempt++;
        } while (target.exists && attempt < 1000);

        var targetPath = target.fsName;
        try {
            comp.saveFrameToPng(comp.time, target);
        } catch (writeError) {
            return seedFail("saveFrameToPng failed: " + writeError);
        }

        /*
         * Re-stat through a NEW File object. An ExtendScript File caches what
         * it knew at construction time, so asking the same instance whether it
         * exists can answer with a stale "no" immediately after a write.
         */
        var written = null;
        for (var check = 0; check < 20; check++) {
            var probe = new File(targetPath);
            if (probe.exists && probe.length > 0) {
                written = probe;
                break;
            }
            $.sleep(50);
        }

        if (!written) {
            return seedFail(
                "After Effects reported no error but no file appeared at " +
                    targetPath +
                    " (folder exists: " + folder.exists +
                    ", folder: " + folder.fsName + ")"
            );
        }

        return seedOk({
            path: written.fsName,
            bytes: written.length,
            width: comp.width,
            height: comp.height,
            frameNumber: frame,
            timeSeconds: comp.time
        });
    } catch (error) {
        return seedFail(error);
    }
}

// ------------------------------------------------------------------- import

function seedImport(path) {
    try {
        var file = new File(seedNormalizePath(path));
        if (!file.exists) return seedFail("file not found: " + path);

        var options = new ImportOptions(file);
        var item = app.project.importFile(options);

        // Keep generated media together rather than loose in the project root.
        var folder = null;
        for (var i = 1; i <= app.project.numItems; i++) {
            var candidate = app.project.item(i);
            if (candidate instanceof FolderItem && candidate.name === "SEED") {
                folder = candidate;
                break;
            }
        }
        if (!folder) folder = app.project.items.addFolder("SEED");
        item.parentFolder = folder;

        return seedOk({ projectItemId: String(item.id), name: item.name });
    } catch (error) {
        return seedFail(error);
    }
}

function seedFindItemById(id) {
    for (var i = 1; i <= app.project.numItems; i++) {
        var item = app.project.item(i);
        if (String(item.id) === String(id)) return item;
    }
    return null;
}

/**
 * Adds the item to the active comp at the playhead. Wrapped in an undo group
 * so one Ctrl+Z removes it — the timeline stays the user's to control.
 */
function seedInsertAtPlayhead(projectItemId) {
    try {
        var comp = seedActiveComp();
        if (!comp) return seedFail("no active composition");

        var item = seedFindItemById(projectItemId);
        if (!item) return seedFail("project item " + projectItemId + " not found");

        app.beginUndoGroup("SEED: insert at playhead");
        var layer;
        try {
            layer = comp.layers.add(item);
            layer.startTime = comp.time;
            layer.selected = true;
        } finally {
            app.endUndoGroup();
        }

        return seedOk({ layerIndex: layer ? layer.index : null, name: layer ? layer.name : null });
    } catch (error) {
        return seedFail(error);
    }
}

/** Probe used by the panel to confirm the host script actually loaded. */
function seedPing() {
    try {
        return seedOk({
            host: "after-effects",
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

var seedAeft_ping = seedPing;
var seedAeft_getContext = seedGetContext;
var seedAeft_captureFrame = seedCaptureFrame;
var seedAeft_import = seedImport;
var seedAeft_insertAtPlayhead = seedInsertAtPlayhead;
