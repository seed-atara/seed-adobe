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

/**
 * How the project is managing colour.
 *
 * Read one property at a time and skip whatever this build does not have:
 * `linearizeWorkingSpace` and `compensateForSceneReferredProfiles` arrived in
 * AE 16.0, and reading a missing property must not cost us the whole context.
 *
 * Absent is reported as absent. A treatment chain that assumes sRGB when it
 * simply could not find out produces double-gamma, and the artist sees a
 * contrast problem rather than a colour-management one.
 */
function seedColorManagement() {
    try {
        var project = app.project;
        var cm = {};
        var found = false;

        var depth = Number(project.bitsPerChannel);
        if (depth === 8 || depth === 16 || depth === 32) {
            cm.bitsPerChannel = depth;
            found = true;
        }

        // Reading an absent property yields undefined rather than throwing, so
        // the version differences need checking but not guarding.
        if (project.workingSpace !== undefined) {
            cm.workingSpace = String(project.workingSpace);
            found = true;
        }

        var gamma = Number(project.workingGamma);
        if (gamma > 0) {
            cm.workingGamma = gamma;
            found = true;
        }

        if (project.linearBlending !== undefined) {
            cm.linearBlending = project.linearBlending ? true : false;
            found = true;
        }

        if (project.linearizeWorkingSpace !== undefined) {
            cm.linearizeWorkingSpace = project.linearizeWorkingSpace ? true : false;
            found = true;
        }

        if (project.compensateForSceneReferredProfiles !== undefined) {
            cm.compensateForSceneReferredProfiles =
                project.compensateForSceneReferredProfiles ? true : false;
            found = true;
        }

        return found ? cm : null;
    } catch (error) {
        // Colour management is provenance, not the capture. Losing it must
        // never cost the frame.
        return null;
    }
}

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

        var colour = seedColorManagement();
        if (colour) {
            context.colorManagement = colour;
            /*
             * A single readable name for the working space. An empty string is
             * After Effects saying "None", which means untagged sRGB-ish
             * display values — worth stating rather than leaving blank.
             */
            if (colour.workingSpace !== undefined) {
                context.colorSpace =
                    colour.workingSpace === "" ? "None" : colour.workingSpace;
            }
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
// ------------------------------------------------------------------- regions

/*
 * A region is a square of a larger plate, animated on its own and composited
 * back.
 *
 * Three objects make one region, and each has a job:
 *
 *   1. a guide layer in the plate comp — the control. It is an ordinary shape
 *      layer, so it is adjusted with the Position and Scale properties the
 *      artist already uses, and can be keyframed, parented or duplicated.
 *   2. a sub-comp, sized to the region — the workspace. It holds the captured
 *      still, and later the animated clip on top of it.
 *   3. a layer in the plate comp holding that sub-comp — the composite. It is
 *      feathered, so the animated square blends into the surrounding plate
 *      instead of reading as a patch.
 *
 * The sub-comp holds the captured *still*, never the plate comp itself: a
 * comp cannot contain a comp that contains it, and the animation is built from
 * that frozen frame anyway.
 */

var SEED_REGION_PREFIX = "SEED Region";
var SEED_COMPOSITE_SUFFIX = " (comp)";

/**
 * The rectangle the layer was built at, before its scale.
 *
 * Read from the shape itself rather than remembered, so a project reopened
 * tomorrow still measures correctly — and so the aspect survives the artist
 * saving, closing, and coming back to it next week.
 */
function seedRegionBaseSize(layer) {
    try {
        var group = layer.property("Contents").property(1);
        var rect = group.property("Contents").property("Rectangle Path 1");
        var size = rect.property("Size").value;
        return [size[0], size[1]];
    } catch (error) {
        return [1024, 1024];
    }
}

/** "16:9" as a number. Undefined for "adaptive" and anything unparseable. */
function seedParseAspect(aspect) {
    if (!aspect) return null;
    var parts = String(aspect).split(":");
    if (parts.length !== 2) return null;
    var w = Number(parts[0]);
    var h = Number(parts[1]);
    if (!(w > 0) || !(h > 0)) return null;
    return w / h;
}

/**
 * A rectangle of the given aspect that fits within `size` on its longest edge.
 *
 * Sized by the longest edge so that asking for 1024 never produces something
 * larger than 1024 in either direction — a region has to fit inside the plate.
 */
function seedRectForAspect(size, aspect) {
    var ratio = seedParseAspect(aspect);
    if (!ratio) return [size, size];
    return ratio >= 1
        ? [size, Math.round(size / ratio)]
        : [Math.round(size * ratio), size];
}

/**
 * Locks the layer's vertical scale to its horizontal one.
 *
 * An expression rather than a one-off correction: it holds while the artist
 * drags a corner handle, which is when the aspect would otherwise be lost.
 * Clearing it returns the region to free scaling.
 */
function seedApplyAspectLock(layer, locked) {
    var scale = layer.property("Transform").property("Scale");
    try {
        scale.expression = locked ? "[value[0], value[0]]" : "";
    } catch (error) {
        // An expression-disabled project is not a reason to fail the whole
        // action; the region simply scales freely.
    }
}

/**
 * Keeps the region inside the composition.
 *
 * An expression on Position rather than a correction after the fact, so the
 * region stops at the edge *during* the drag — the same reason the aspect lock
 * is an expression. After Effects owns the mouse; a modifier key cannot be
 * intercepted from a script, so this is a state the region is in rather than
 * something held down.
 *
 * The rectangle is read live where possible so the clamp keeps up with a
 * reshape, with the size at the time of writing as a fallback. A region larger
 * than the comp in an axis is centred on that axis: there is no position that
 * satisfies containment, and pinning it to one edge would be a silent lie
 * about which part of the plate is being captured.
 */
function seedApplyContain(layer, contained, base) {
    var position = layer.property("Transform").property("Position");
    try {
        if (!contained) {
            position.expression = "";
            return;
        }
        position.expression =
            'var base = [' + base[0] + ', ' + base[1] + '];\n' +
            'try { base = content("Group 1").content("Rectangle Path 1").size; } catch (err) {}\n' +
            'var s = transform.scale / 100;\n' +
            'var hw = base[0] * s[0] / 2;\n' +
            'var hh = base[1] * s[1] / 2;\n' +
            'var cw = thisComp.width;\n' +
            'var ch = thisComp.height;\n' +
            'var x = (hw * 2 >= cw) ? cw / 2 : clamp(value[0], hw, cw - hw);\n' +
            'var y = (hh * 2 >= ch) ? ch / 2 : clamp(value[1], hh, ch - hh);\n' +
            '[x, y]';
    } catch (error) {
        // An expression-disabled project simply moves freely.
    }
}

/** Whether this region is currently held inside the comp. */
function seedContained(layer) {
    try {
        var expression = layer.property("Transform").property("Position").expression;
        return expression !== null && expression !== "";
    } catch (error) {
        return false;
    }
}

/** Whether this region is currently holding an aspect. */
function seedAspectLocked(layer) {
    try {
        var expression = layer.property("Transform").property("Scale").expression;
        return expression !== null && expression !== "";
    } catch (error) {
        return false;
    }
}

/** The rectangle a region layer currently covers, in comp pixels. */
function seedRegionRect(layer) {
    var position = layer.property("Transform").property("Position").value;
    var scale = layer.property("Transform").property("Scale").value;
    var base = seedRegionBaseSize(layer);

    return {
        centerX: position[0],
        centerY: position[1],
        width: Math.max(8, Math.round((base[0] * scale[0]) / 100)),
        height: Math.max(8, Math.round((base[1] * scale[1]) / 100))
    };
}

/**
 * The guide layers, and only those.
 *
 * The composite layer carries the region's name too, so matching on the name
 * alone would treat the thing being composited as another control.
 */
function seedFindRegions(comp) {
    var found = [];
    for (var i = 1; i <= comp.numLayers; i++) {
        var layer = comp.layer(i);
        if (
            layer.name.indexOf(SEED_REGION_PREFIX) === 0 &&
            layer.guideLayer === true &&
            layer instanceof ShapeLayer
        ) {
            found.push(layer);
        }
    }
    return found;
}

function seedRegionByName(comp, name) {
    var regions = seedFindRegions(comp);
    if (!name) return regions.length > 0 ? regions[0] : null;
    for (var i = 0; i < regions.length; i++) {
        if (regions[i].name === name) return regions[i];
    }
    return null;
}

/** The project comp that belongs to a region, if it has been made yet. */
function seedFindRegionComp(name) {
    for (var i = 1; i <= app.project.numItems; i++) {
        var item = app.project.item(i);
        if (item instanceof CompItem && item.name === name) return item;
    }
    return null;
}

/** The layer in the plate comp that holds a region's sub-comp. */
function seedFindComposite(comp, name) {
    var target = name + SEED_COMPOSITE_SUFFIX;
    for (var i = 1; i <= comp.numLayers; i++) {
        if (comp.layer(i).name === target) return comp.layer(i);
    }
    return null;
}

/** Keeps SEED's own items together instead of loose in the project root. */
function seedProjectFolder() {
    for (var i = 1; i <= app.project.numItems; i++) {
        var item = app.project.item(i);
        if (item instanceof FolderItem && item.name === "SEED") return item;
    }
    return app.project.items.addFolder("SEED");
}

function seedDescribeRegion(comp, layer) {
    var rect = seedRegionRect(layer);
    var sub = seedFindRegionComp(layer.name);
    var base = seedRegionBaseSize(layer);
    return {
        name: layer.name,
        centerX: rect.centerX,
        centerY: rect.centerY,
        width: rect.width,
        height: rect.height,
        aspect: base[1] > 0 ? base[0] / base[1] : 1,
        locked: seedAspectLocked(layer),
        contained: seedContained(layer),
        hasComp: sub !== null,
        composited: seedFindComposite(comp, layer.name) !== null
    };
}

/**
 * The next free region name.
 *
 * Counting the existing guides is not enough: deleting region 2 of three would
 * hand the next one the name "SEED Region 3", which already exists — and since
 * a region finds its sub-comp by name, the two would silently share one.
 */
function seedNextRegionName(comp) {
    for (var n = 1; n < 1000; n++) {
        var candidate = SEED_REGION_PREFIX + " " + n;
        if (seedRegionByName(comp, candidate)) continue;
        if (seedFindRegionComp(candidate)) continue;
        return candidate;
    }
    return SEED_REGION_PREFIX + " " + new Date().getTime();
}

/** Creates a region guide, centred, sized to fit the plate. */
function seedCreateRegion(size, aspect) {
    try {
        var comp = seedActiveComp();
        if (!comp) return seedFail("no active composition");

        app.beginUndoGroup("SEED: add region");

        var edge = Number(size) > 0 ? Number(size) : 1024;
        // A region larger than the plate cannot be captured from it.
        var limit = Math.min(comp.width, comp.height);
        if (edge > limit) edge = limit;

        var dims = seedRectForAspect(edge, aspect);

        var layer = comp.layers.addShape();
        layer.name = seedNextRegionName(comp);

        var group = layer.property("Contents").addProperty("ADBE Vector Group");
        var contents = group.property("Contents");
        var rect = contents.addProperty("ADBE Vector Shape - Rect");
        rect.property("Size").setValue(dims);
        rect.property("Position").setValue([0, 0]);

        var stroke = contents.addProperty("ADBE Vector Graphic - Stroke");
        stroke.property("Color").setValue([0, 1, 1]);
        stroke.property("Stroke Width").setValue(4);

        layer.property("Transform").property("Position").setValue([
            comp.width / 2,
            comp.height / 2
        ]);
        // Excluded from renders, so it can never be baked into a capture.
        layer.guideLayer = true;
        // The aspect is built into the rectangle; the lock is what keeps it
        // through a corner drag.
        seedApplyAspectLock(layer, seedParseAspect(aspect) !== null);

        app.endUndoGroup();
        return seedOk({ region: seedDescribeRegion(comp, layer) });
    } catch (error) {
        try { app.endUndoGroup(); } catch (ignored) {}
        return seedFail(error);
    }
}

/**
 * Reshapes a region to an aspect, keeping its width and its centre.
 *
 * Width is what is preserved because that is what an artist has usually just
 * finished framing; the height moves to satisfy the ratio. Passing no aspect
 * frees the region to scale in either direction again.
 */
function seedSetRegionAspect(regionName, aspect) {
    try {
        var comp = seedActiveComp();
        if (!comp) return seedFail("no active composition");

        var region = seedRegionByName(comp, regionName);
        if (!region) return seedFail("no region named " + regionName);

        app.beginUndoGroup("SEED: region aspect");

        var rect = seedRegionRect(region);
        var ratio = seedParseAspect(aspect);

        var group = region.property("Contents").property(1);
        var shape = group.property("Contents").property("Rectangle Path 1");

        if (ratio) {
            var height = Math.max(8, Math.round(rect.width / ratio));
            shape.property("Size").setValue([rect.width, height]);
            // The rectangle now carries the aspect at 100%, so reset the scale
            // rather than leave the old one distorting it.
            region.property("Transform").property("Scale").setValue([100, 100]);
            seedApplyAspectLock(region, true);
            if (seedContained(region)) {
                seedApplyContain(region, true, [rect.width, height]);
            }
        } else {
            shape.property("Size").setValue([rect.width, rect.height]);
            region.property("Transform").property("Scale").setValue([100, 100]);
            seedApplyAspectLock(region, false);
            if (seedContained(region)) {
                seedApplyContain(region, true, [rect.width, rect.height]);
            }
        }

        app.endUndoGroup();
        return seedOk({ region: seedDescribeRegion(comp, region) });
    } catch (error) {
        try { app.endUndoGroup(); } catch (ignored) {}
        return seedFail(error);
    }
}

/** Holds a region inside the comp, or lets it roam. */
function seedSetRegionContain(regionName, contained) {
    try {
        var comp = seedActiveComp();
        if (!comp) return seedFail("no active composition");

        var region = seedRegionByName(comp, regionName);
        if (!region) return seedFail("no region named " + regionName);

        app.beginUndoGroup("SEED: region containment");
        seedApplyContain(region, contained === true, seedRegionBaseSize(region));
        app.endUndoGroup();

        return seedOk({ region: seedDescribeRegion(comp, region) });
    } catch (error) {
        try { app.endUndoGroup(); } catch (ignored) {}
        return seedFail(error);
    }
}

function seedListRegions() {
    try {
        var comp = seedActiveComp();
        if (!comp) return seedFail("no active composition");

        var layers = seedFindRegions(comp);
        var described = [];
        for (var i = 0; i < layers.length; i++) {
            described.push(seedDescribeRegion(comp, layers[i]));
        }
        return seedOk({
            regions: described,
            compWidth: comp.width,
            compHeight: comp.height
        });
    } catch (error) {
        return seedFail(error);
    }
}

/**
 * Imports a file After Effects has only just written.
 *
 * saveFrameToPng returns before the handle is released, so importing the same
 * path immediately fails with "File exists but couldn't be open for reading" —
 * the file is there, it is simply still held. Each attempt uses a fresh File
 * object, because an ExtendScript File caches what it knew at construction.
 */
function seedImportWhenReadable(path) {
    var lastError = null;
    for (var attempt = 0; attempt < 30; attempt++) {
        try {
            return app.project.importFile(new ImportOptions(new File(path)));
        } catch (error) {
            lastError = error;
            $.sleep(100);
        }
    }
    throw new Error(
        "After Effects wrote " + path + " but would not read it back after 3s: " +
            lastError
    );
}

/**
 * Builds or refreshes the region's sub-comp around a captured still.
 *
 * Re-capturing an existing region reuses its comp rather than making another,
 * so whatever the artist has already built inside it survives.
 */
function seedEnsureRegionComp(comp, region, rect, stillFile) {
    var sub = seedFindRegionComp(region.name);
    if (!sub) {
        sub = app.project.items.addComp(
            region.name,
            rect.width,
            rect.height,
            comp.pixelAspect,
            comp.duration,
            comp.frameRate
        );
        sub.parentFolder = seedProjectFolder();
    } else if (sub.width !== rect.width || sub.height !== rect.height) {
        // The guide was rescaled since the last capture.
        sub.width = rect.width;
        sub.height = rect.height;
    }

    // Replace the previous plate still; anything the artist added stays.
    for (var i = sub.numLayers; i >= 1; i--) {
        if (sub.layer(i).name.indexOf("SEED plate") === 0) sub.layer(i).remove();
    }

    var imported = seedImportWhenReadable(stillFile.fsName);
    imported.parentFolder = seedProjectFolder();
    var plate = sub.layers.add(imported);
    plate.name = "SEED plate";
    plate.moveToEnd();
    plate.property("Transform").property("Position").setValue([
        sub.width / 2,
        sub.height / 2
    ]);

    return sub;
}

/**
 * Places the region's sub-comp back over the plate, feathered.
 *
 * Because the sub-comp's own background is the captured still, the feathered
 * edge fades into pixels identical to the plate underneath — which is what
 * makes the join invisible.
 */
function seedPlaceComposite(comp, region, rect, featherPixels) {
    var sub = seedFindRegionComp(region.name);
    if (!sub) return null;

    var layer = seedFindComposite(comp, region.name);
    if (!layer) {
        layer = comp.layers.add(sub);
        layer.name = region.name + SEED_COMPOSITE_SUFFIX;
        // Above the plate, below anything the artist put on top.
        layer.moveToBeginning();
    }

    layer.property("Transform").property("Position").setValue([
        rect.centerX,
        rect.centerY
    ]);
    layer.property("Transform").property("Scale").setValue([100, 100]);

    var feather = Number(featherPixels);
    if (isNaN(feather) || feather < 0) feather = 24;

    // Rebuild rather than adjust: the region may have been resized.
    var masks = layer.property("ADBE Mask Parade");
    for (var m = masks.numProperties; m >= 1; m--) masks.property(m).remove();

    if (feather > 0) {
        var inset = Math.min(feather, sub.width / 4, sub.height / 4);
        var mask = masks.addProperty("ADBE Mask Atom");
        var shape = new Shape();
        shape.vertices = [
            [inset, inset],
            [sub.width - inset, inset],
            [sub.width - inset, sub.height - inset],
            [inset, sub.height - inset]
        ];
        shape.closed = true;
        mask.property("ADBE Mask Shape").setValue(shape);
        mask.property("ADBE Mask Feather").setValue([feather, feather]);
        mask.maskMode = MaskMode.ADD;
    }

    return layer;
}

/**
 * Renders just the region, at the playhead, and preps its sub-comp.
 *
 * After Effects can only write a whole composition, so the region is framed by
 * a temporary comp holding the plate offset behind it. That temp comp is
 * removed afterwards whether or not the render succeeded — leaving debris in
 * someone's project is worse than failing.
 */
function seedCaptureRegion(regionName, outputDir, basename, featherPixels) {
    var temp = null;
    var hidden = [];
    try {
        var comp = seedActiveComp();
        if (!comp) return seedFail("no active composition");

        var region = seedRegionByName(comp, regionName);
        if (!region) {
            return seedFail(
                regionName
                    ? "no region layer named " + regionName
                    : "this comp has no region yet — add one first"
            );
        }

        var rect = seedRegionRect(region);
        var folder = seedEnsureFolder(outputDir);
        if (!folder.exists) {
            return seedFail("could not create output folder: " + outputDir);
        }

        app.beginUndoGroup("SEED: capture region");

        // Hide every guide, and any composite already over this region, so the
        // capture is of the plate itself and not of an earlier result.
        var regions = seedFindRegions(comp);
        for (var r = 0; r < regions.length; r++) {
            if (regions[r].enabled) {
                regions[r].enabled = false;
                hidden.push(regions[r]);
            }
        }
        // Every composite, not just this region's: with several regions on one
        // plate, an overlapping neighbour would otherwise be captured as if it
        // were part of the plate, and a re-capture would compound its own result.
        for (var c = 1; c <= comp.numLayers; c++) {
            var candidate = comp.layer(c);
            var isComposite =
                candidate.name.indexOf(SEED_REGION_PREFIX) === 0 &&
                candidate.name.indexOf(SEED_COMPOSITE_SUFFIX) ===
                    candidate.name.length - SEED_COMPOSITE_SUFFIX.length;
            if (isComposite && candidate.enabled) {
                candidate.enabled = false;
                hidden.push(candidate);
            }
        }

        temp = app.project.items.addComp(
            "SEED Capture (temp)",
            rect.width,
            rect.height,
            comp.pixelAspect,
            Math.max(comp.duration, 1 / comp.frameRate),
            comp.frameRate
        );

        var plate = temp.layers.add(comp);
        // Put the region's centre at the centre of the temp comp.
        plate.property("Transform").property("Position").setValue([
            rect.width / 2 - (rect.centerX - comp.width / 2),
            rect.height / 2 - (rect.centerY - comp.height / 2)
        ]);
        temp.time = comp.time;

        var frame = Math.round(comp.time * comp.frameRate);
        var safe = String(basename || comp.name).replace(/[^A-Za-z0-9._-]+/g, "_");
        var stamp = String(frame);
        while (stamp.length < 5) stamp = "0" + stamp;

        var attempt = 1;
        var target;
        do {
            var suffix = String(attempt);
            while (suffix.length < 3) suffix = "0" + suffix;
            target = new File(
                seedNormalizePath(folder.fsName) +
                    "/" + safe + "_r" + stamp + "_" + suffix + ".png"
            );
            attempt++;
        } while (target.exists && attempt < 1000);

        var targetPath = target.fsName;
        try {
            temp.saveFrameToPng(temp.time, target);
        } catch (writeError) {
            return seedFail("saveFrameToPng failed on the region comp: " + writeError);
        }

        var written = null;
        for (var check = 0; check < 20; check++) {
            var probe = new File(targetPath);
            if (probe.exists && probe.length > 0) {
                written = probe;
                break;
            }
            $.sleep(50);
        }
        if (!written) return seedFail("no region frame appeared at " + targetPath);

        var sub = seedEnsureRegionComp(comp, region, rect, written);
        seedPlaceComposite(comp, region, rect, featherPixels);

        return seedOk({
            path: written.fsName,
            bytes: written.length,
            width: rect.width,
            height: rect.height,
            frameNumber: frame,
            timeSeconds: comp.time,
            compName: sub.name,
            region: seedDescribeRegion(comp, region)
        });
    } catch (error) {
        return seedFail(error);
    } finally {
        if (temp) {
            try { temp.remove(); } catch (ignored) {}
        }
        for (var h = 0; h < hidden.length; h++) {
            try { hidden[h].enabled = true; } catch (ignored) {}
        }
        try { app.endUndoGroup(); } catch (ignored) {}
    }
}

/**
 * Drops an animated clip into its region's sub-comp.
 *
 * The plate is never touched. The clip goes on top of the captured still
 * inside the sub-comp, and the sub-comp is what sits — feathered — over the
 * plate, so the whole composite can be retimed, replaced or deleted without
 * rebuilding anything.
 */
function seedInsertRegion(projectItemId, options) {
    try {
        var comp = seedActiveComp();
        if (!comp) return seedFail("no active composition");

        var item = seedFindItemById(projectItemId);
        if (!item) return seedFail("project item " + projectItemId + " not found");

        var settings = options || {};
        var region = seedRegionByName(comp, settings.regionName);
        if (!region) return seedFail("no region to composite into — add one first");

        var rect = seedRegionRect(region);
        var sub = seedFindRegionComp(region.name);
        if (!sub) {
            return seedFail(
                "capture " + region.name + " first — its comp does not exist yet"
            );
        }

        app.beginUndoGroup("SEED: composite region");

        var layer = sub.layers.add(item);
        layer.moveToBeginning();
        layer.startTime =
            settings.startSeconds === undefined || settings.startSeconds === null
                ? comp.time
                : Number(settings.startSeconds);

        // Retime before anything measures the layer's length.
        if (Number(settings.stretchToSeconds) > 0 && item.duration > 0) {
            layer.stretch = (Number(settings.stretchToSeconds) / item.duration) * 100;
        }

        // Fill the sub-comp exactly; the clip usually differs from the region
        // in resolution, since the model has its own output sizes.
        var sourceWidth = item.width || sub.width;
        var sourceHeight = item.height || sub.height;
        layer.property("Transform").property("Scale").setValue([
            (sub.width / sourceWidth) * 100,
            (sub.height / sourceHeight) * 100
        ]);
        layer.property("Transform").property("Position").setValue([
            sub.width / 2,
            sub.height / 2
        ]);

        var composite = seedPlaceComposite(comp, region, rect, settings.featherPixels);

        app.endUndoGroup();

        return seedOk({
            name: item.name,
            regionName: region.name,
            compName: sub.name,
            atSeconds: layer.startTime,
            width: rect.width,
            height: rect.height,
            sourceWidth: sourceWidth,
            sourceHeight: sourceHeight,
            featherPixels: composite ? Number(settings.featherPixels) || 0 : 0,
            stretchPercent: layer.stretch
        });
    } catch (error) {
        try { app.endUndoGroup(); } catch (ignored) {}
        return seedFail(error);
    }
}

// ------------------------------------------------------------------ the look

/*
 * The film look as effects on a layer, rather than a baked file.
 *
 * This is what an artist actually wants: something on the layer, live in the
 * viewer, keyframeable, rendering with the comp, and adjustable without going
 * back to a panel. The bake treats one still; this treats a shot.
 *
 * It arrives in two parts because the chain divides in two. The tonal half —
 * exposure, both tonemaps, stock colour, the grade — is per-pixel and is
 * carried exactly by a 3D LUT that SEED generates from the same config. The
 * spatial half — grain, vignette, halation, distortion — cannot be a lookup at
 * any size, so it is built from After Effects' own effects, set from the same
 * numbers.
 *
 * The LUT file cannot be attached by script: the parameter takes an integer
 * rather than a path. So the effect is applied and left pointing at nothing,
 * and the artist chooses the file once. Everything else is set for them.
 */

/**
 * Adds an effect by trying each candidate match name in turn.
 *
 * Match names are version- and locale-dependent and are not something to
 * assume. Probing is the same approach the Premiere exporter takes for the
 * same reason: an assumption that is wrong here throws, and the artist sees
 * "EvalScript error" with nothing to act on.
 */
function seedAddEffect(layer, candidates) {
    var effects = layer.property("ADBE Effect Parade");
    for (var i = 0; i < candidates.length; i++) {
        try {
            if (effects.canAddProperty(candidates[i])) {
                return effects.addProperty(candidates[i]);
            }
        } catch (error) {
            // Try the next spelling.
        }
    }
    return null;
}

/**
 * Puts SEED's own LUT on an adjustment layer over the comp.
 *
 * Only the LUT. An earlier version of this also added After Effects' stock
 * Glow, CC Vignette and Add Grain with numbers scaled off the config, and
 * called that the look — it was not. Those effects are not this chain's
 * halation, vignette or grain; they are different maths wearing the same
 * words, and dressing them up as SEED's would have made the tool lie about
 * what it was doing.
 *
 * So this applies the one thing that genuinely is ours and genuinely is exact:
 * the tonal half, as a cube built from the same engine the bake uses. The
 * spatial half belongs in a real SEED plugin, and until that exists the bake
 * is where to get it.
 */
function seedBuildLookRig(name, lutPath, settings) {
    try {
        var comp = seedActiveComp();
        if (!comp) return seedFail("no active composition");

        app.beginUndoGroup("SEED: add look");

        var layer = comp.layers.addSolid(
            [0, 0, 0], "SEED Look - " + (name || "look"),
            comp.width, comp.height, 1, comp.duration
        );
        layer.adjustmentLayer = true;
        layer.moveToBeginning();
        layer.label = 11;

        var lut = seedAddEffect(layer, [
            "ADBE Apply Color LUT2",
            "ADBE Apply Color LUT"
        ]);

        app.endUndoGroup();

        return seedOk({
            name: layer.name,
            compName: comp.name,
            layerIndex: layer.index,
            lutPath: lutPath || null,
            applied: lut ? ["the look (Apply Color LUT)"] : [],
            skipped: lut ? [] : ["Apply Color LUT — this build does not have it"]
        });
    } catch (error) {
        try { app.endUndoGroup(); } catch (ignored) {}
        return seedFail(error);
    }
}

// -------------------------------------------------------------- placeholders

/*
 * Holding a cut open while a video renders.
 *
 * The duration is known when Generate is pressed, so the space is reserved
 * immediately and the result swapped in when it lands. The swap is
 * `replaceSource`, not a delete and re-insert: effects, transforms and
 * keyframes live on the layer rather than the source, so anything the artist
 * built on the placeholder while waiting survives — and they may well have
 * trimmed or moved it, which is rather the point of reserving the space.
 */

var SEED_PENDING_PREFIX = "SEED pending";

/** A placeholder layer within one comp, by the label it was reserved under. */
function seedPlaceholderIn(comp, label) {
    for (var i = 1; i <= comp.numLayers; i++) {
        var layer = comp.layer(i);
        if (layer.name.indexOf(SEED_PENDING_PREFIX) === 0 &&
            layer.name.indexOf(label) !== -1) {
            return layer;
        }
    }
    return null;
}

/**
 * The placeholder, wherever it is.
 *
 * Searched by the comp it was reserved in first, then across the project.
 * Looking only in the *active* comp was wrong: a render takes minutes, and
 * moving up and down the comp ladder while waiting is ordinary work — but it
 * meant the placeholder stopped being findable the moment the artist looked at
 * anything else, and the render then landed nowhere.
 */
function seedFindPlaceholder(label, compId) {
    var wanted = Number(compId);
    if (wanted > 0) {
        for (var i = 1; i <= app.project.numItems; i++) {
            var item = app.project.item(i);
            if (!(item instanceof CompItem) || item.id !== wanted) continue;
            var found = seedPlaceholderIn(item, label);
            if (found) return { comp: item, layer: found };
        }
    }

    // The comp may have been deleted, or the reservation made before comps
    // were recorded; the label is unique either way.
    for (var j = 1; j <= app.project.numItems; j++) {
        var candidate = app.project.item(j);
        if (!(candidate instanceof CompItem)) continue;
        var layer = seedPlaceholderIn(candidate, label);
        if (layer) return { comp: candidate, layer: layer };
    }
    return null;
}

/** Puts a placeholder at the playhead for the length the render will be. */
function seedReservePlaceholder(placeholderPath, durationSeconds, label) {
    try {
        var comp = seedActiveComp();
        if (!comp) return seedFail("no active composition");

        var file = new File(seedNormalizePath(placeholderPath));
        if (!file.exists) return seedFail("placeholder media not found");

        app.beginUndoGroup("SEED: reserve space");

        var item = app.project.importFile(new ImportOptions(file));
        item.parentFolder = seedProjectFolder();
        item.name = SEED_PENDING_PREFIX + " " + label;

        var layer = comp.layers.add(item);
        layer.startTime = comp.time;
        var seconds = Number(durationSeconds);
        if (seconds > 0) layer.outPoint = layer.inPoint + seconds;
        layer.name = SEED_PENDING_PREFIX + " " + label;
        layer.label = 1; // red, so it reads as unfinished in the timeline

        app.endUndoGroup();
        return seedOk({
            label: label,
            name: layer.name,
            compId: comp.id,
            atSeconds: layer.startTime,
            durationSeconds: layer.outPoint - layer.inPoint
        });
    } catch (error) {
        try { app.endUndoGroup(); } catch (ignored) {}
        return seedFail(error);
    }
}

/*
 * Iterating on a shot that is already in the timeline.
 *
 * The loop the artist actually wants is: look at the take in context, decide
 * it is nearly right, change one thing, run it again — and have the new take
 * arrive where the old one was, still carrying the scale, position, timing and
 * effects that were built around it.
 *
 * That needs two things the reserve/fill pair did not have. Something has to
 * say which generation made the layer under the cursor, and the layer itself
 * has to become the placeholder rather than a second one appearing at the
 * playhead. Both are below; the fill that follows is the same one a fresh
 * reservation uses.
 */

/** Whether a layer is backed by a file of this name. */
function seedLayerHasFile(layer, filename) {
    try {
        if (!layer || !layer.source || !layer.source.file) return false;
        return String(layer.source.file.name) === String(filename);
    } catch (error) {
        return false;
    }
}

/**
 * Describes the media under the selection, so the panel can find its recipe.
 *
 * Reports the source file rather than the layer name, because the name is the
 * artist's to change and the path is not. A region composite is followed one
 * level down: the selection there is the sub-comp sitting in the plate, and
 * what is being iterated on is the footage inside it.
 */
function seedSelectedMedia() {
    try {
        var comp = seedActiveComp();
        if (!comp) return seedFail("no active composition");

        var selected = comp.selectedLayers;
        if (selected.length === 0) {
            return seedFail("select the layer you want to iterate on");
        }
        if (selected.length > 1) {
            return seedFail("select a single layer — " + selected.length + " are selected");
        }

        var layer = selected[0];
        var source = layer.source;
        if (!source) return seedFail(layer.name + " has no source to iterate on");

        var host = comp;
        var inRegion = null;

        // A region composite: step inside and take the footage it holds.
        if (source instanceof CompItem) {
            var inner = null;
            for (var i = 1; i <= source.numLayers; i++) {
                var candidate = source.layer(i);
                if (candidate.source && candidate.source instanceof FootageItem &&
                    candidate.source.file) {
                    inner = candidate;
                    break;
                }
            }
            if (!inner) {
                return seedFail(
                    layer.name + " is a composition with no generated footage inside it"
                );
            }
            inRegion = source.name;
            host = source;
            layer = inner;
            source = inner.source;
        }

        if (!source.file) {
            return seedFail(layer.name + " is not backed by a file on disk");
        }

        return seedOk({
            path: source.file.fsName,
            filename: source.file.name,
            layerName: layer.name,
            compId: host.id,
            compName: host.name,
            layerIndex: layer.index,
            width: source.width,
            height: source.height,
            durationSeconds: source.duration,
            regionName: inRegion,
            startSeconds: layer.startTime,
            inRegion: inRegion !== null
        });
    } catch (error) {
        return seedFail(error);
    }
}

/**
 * Turns a layer that is already in the timeline into the pending placeholder.
 *
 * `replaceSource` rather than a delete and re-add, for the same reason fill
 * uses it: everything the artist built — transforms, keyframes, effects, the
 * trim — lives on the layer, and iterating must not cost them that. The
 * original item and its width go back to the caller so a failed render can put
 * the previous take back, which is the whole safety net of iterating: the take
 * you had is never worse off for having tried another.
 */
function seedAdoptPlaceholder(placeholderPath, label, compId, layerIndex, expectedFile) {
    try {
        var comp = null;
        var wanted = Number(compId);
        for (var i = 1; i <= app.project.numItems; i++) {
            var item = app.project.item(i);
            if (item instanceof CompItem && item.id === wanted) {
                comp = item;
                break;
            }
        }
        if (!comp) return seedFail("the composition holding that layer is gone");

        var index = Number(layerIndex);
        if (!(index >= 1 && index <= comp.numLayers)) {
            return seedFail("layer " + layerIndex + " is no longer in " + comp.name);
        }
        var layer = comp.layer(index);

        /*
         * Confirm it is still the same shot before replacing anything.
         *
         * A layer index is a position in a stack, and stacks get reordered —
         * between choosing to iterate and pressing Generate the artist may
         * have added a layer above this one, which silently shifts every index
         * below it. Replacing whatever now sits at that position would destroy
         * unrelated work, so the file is checked, and the layer is found by
         * file if the index has moved.
         */
        if (expectedFile) {
            var wantedName = String(expectedFile);
            if (!seedLayerHasFile(layer, wantedName)) {
                var relocated = null;
                var seen = 0;
                for (var s = 1; s <= comp.numLayers; s++) {
                    if (seedLayerHasFile(comp.layer(s), wantedName)) {
                        relocated = comp.layer(s);
                        seen++;
                    }
                }
                if (seen !== 1) {
                    return seedFail(
                        seen === 0
                            ? wantedName + " is no longer in " + comp.name +
                                  ", so there is nothing to iterate on"
                            : comp.name + " has " + seen + " layers using " +
                                  wantedName + " — select it again so there is " +
                                  "no doubt which one to replace"
                    );
                }
                layer = relocated;
            }
        }

        var file = new File(seedNormalizePath(placeholderPath));
        if (!file.exists) return seedFail("placeholder media not found");

        var original = layer.source;
        if (!original) return seedFail(layer.name + " has no source to replace");
        var originalWidth = original.width;
        var originalName = layer.name;

        app.beginUndoGroup("SEED: iterate on this shot");

        var card = app.project.importFile(new ImportOptions(file));
        card.parentFolder = seedProjectFolder();
        card.name = SEED_PENDING_PREFIX + " " + label;

        layer.replaceSource(card, false);
        layer.name = SEED_PENDING_PREFIX + " " + label;
        layer.label = 1; // red, so it reads as unfinished in the timeline

        /*
         * Hold the framing. Swapping the source keeps the scale that suited the
         * old take, and the card is rarely the same size — correcting by the
         * ratio now means the fill's own correction lands back exactly where
         * the artist had it, whatever size the render turns out to be.
         */
        if (originalWidth > 0 && card.width > 0 && originalWidth !== card.width) {
            var scale = layer.property("Transform").property("Scale");
            var was = scale.value;
            var factor = originalWidth / card.width;
            scale.setValue([was[0] * factor, was[1] * factor]);
        }

        app.endUndoGroup();

        return seedOk({
            label: label,
            name: layer.name,
            compId: comp.id,
            layerIndex: layer.index,
            atSeconds: layer.startTime,
            durationSeconds: layer.outPoint - layer.inPoint,
            restoreItemId: original.id,
            restoreName: originalName,
            restoreWidth: originalWidth
        });
    } catch (error) {
        try { app.endUndoGroup(); } catch (ignored) {}
        return seedFail(error);
    }
}

/** Swaps the finished render in underneath the placeholder. */
function seedFillPlaceholder(label, mediaPath, compId) {
    try {
        var held = seedFindPlaceholder(label, compId);
        if (!held) {
            return seedFail(
                "could not find the placeholder for " + label + " — it may have " +
                    "been deleted or renamed"
            );
        }
        var layer = held.layer;

        var file = new File(seedNormalizePath(mediaPath));
        if (!file.exists) return seedFail("file not found: " + mediaPath);

        app.beginUndoGroup("SEED: fill placeholder");

        var item = app.project.importFile(new ImportOptions(file));
        item.parentFolder = seedProjectFolder();

        /*
         * Swapping the source keeps the layer's scale, which was right for the
         * card and is wrong for the render: the two are rarely the same size,
         * because the model returns what it returns and the card could only be
         * a prediction. So the scale is corrected by exactly the ratio between
         * them, which fixes the swap while keeping any scaling the artist did
         * while they waited.
         */
        var before = layer.source ? layer.source.width : 0;

        layer.replaceSource(item, false);
        layer.name = item.name;
        layer.label = 0;

        if (before > 0 && item.width > 0 && before !== item.width) {
            var scale = layer.property("Transform").property("Scale");
            var was = scale.value;
            var factor = before / item.width;
            scale.setValue([was[0] * factor, was[1] * factor]);
        }

        app.endUndoGroup();
        return seedOk({
            name: layer.name,
            atSeconds: layer.startTime,
            durationSeconds: layer.outPoint - layer.inPoint
        });
    } catch (error) {
        try { app.endUndoGroup(); } catch (ignored) {}
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
function seedFailPlaceholder(label, message, compId, restoreItemId, restoreWidth) {
    try {
        var held = seedFindPlaceholder(label, compId);
        if (!held) return seedOk({ name: null });
        var layer = held.layer;

        app.beginUndoGroup("SEED: placeholder failed");

        /*
         * An adopted layer had a take in it before this attempt. Put it back:
         * a failed iteration should cost the artist the wait and nothing else,
         * and a striped card where their shot used to be is a worse outcome
         * than the take they already had.
         */
        var restored = false;
        var wanted = Number(restoreItemId);
        if (wanted > 0) {
            var previous = seedFindItemById(wanted);
            if (previous) {
                var cardWidth = layer.source ? layer.source.width : 0;
                layer.replaceSource(previous, false);
                layer.name = previous.name;
                layer.label = 0;
                var back = Number(restoreWidth);
                if (cardWidth > 0 && back > 0 && cardWidth !== back) {
                    var scale = layer.property("Transform").property("Scale");
                    var was = scale.value;
                    var factor = cardWidth / back;
                    scale.setValue([was[0] * factor, was[1] * factor]);
                }
                restored = true;
            }
        }

        if (!restored) {
            layer.name =
                "SEED failed - " + String(message || "generation failed").substr(0, 60);
            layer.label = 9;
        }

        app.endUndoGroup();

        return seedOk({ name: layer.name, restored: restored });
    } catch (error) {
        try { app.endUndoGroup(); } catch (ignored) {}
        return seedFail(error);
    }
}

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
var seedAeft_createRegion = seedCreateRegion;
var seedAeft_setRegionAspect = seedSetRegionAspect;
var seedAeft_setRegionContain = seedSetRegionContain;
var seedAeft_listRegions = seedListRegions;
var seedAeft_captureRegion = seedCaptureRegion;
var seedAeft_insertRegion = seedInsertRegion;
var seedAeft_reservePlaceholder = seedReservePlaceholder;
var seedAeft_fillPlaceholder = seedFillPlaceholder;
var seedAeft_failPlaceholder = seedFailPlaceholder;
var seedAeft_selectedMedia = seedSelectedMedia;
var seedAeft_adoptPlaceholder = seedAdoptPlaceholder;
var seedAeft_buildLookRig = seedBuildLookRig;
