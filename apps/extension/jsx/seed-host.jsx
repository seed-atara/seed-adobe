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
    return seedJson({ ok: false, error: String(message) });
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

/**
 * Renders the frame under the playhead to a PNG.
 *
 * `saveFrameToPng` is a direct still export — it does not touch the render
 * queue, so it neither disturbs the user's queue nor requires a template.
 */
function seedCaptureFrame(outputDir, basename) {
    try {
        var comp = seedActiveComp();
        if (!comp) return seedFail("no active composition");

        var folder = new Folder(outputDir);
        if (!folder.exists && !folder.create()) {
            return seedFail("could not create " + outputDir);
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
            target = new File(folder.fsName + "/" + safe + "_f" + stamp + "_" + suffix + ".png");
            attempt++;
        } while (target.exists && attempt < 1000);

        comp.saveFrameToPng(comp.time, target);
        if (!target.exists) return seedFail("After Effects did not write the frame");

        return seedOk({
            path: target.fsName,
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
        var file = new File(path);
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
