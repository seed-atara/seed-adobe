/**
 * Asks THIS After Effects what its render settings are actually called.
 *
 * Run it once: File > Scripts > Run Script File..., pick this file.
 * It writes a JSON dump next to your project and tells you where.
 *
 * Why a probe rather than code that guesses:
 *
 * `CompItem.saveFrameToPng` — which SEED uses for a still — is undocumented,
 * and it writes the frame in the project's WORKING space with no view
 * transform. In an OCIO/ACES project that is scene-referred data, so the file
 * reads as near-black everywhere downstream.
 *
 * The render queue does have the control we need: Output Module Settings >
 * Color > Output Color Space. Adobe documents `OutputModule.getSettings()` and
 * `setSettings()` but does NOT document the key names, and they differ between
 * versions and between ICC and OCIO engines. So the honest way to find the one
 * on this machine is to ask this machine.
 *
 * Nothing is rendered and nothing is changed: a render queue item is added to
 * read its defaults, then removed again.
 */
(function () {
    function write(file, text) {
        file.encoding = "UTF-8";
        file.open("w");
        file.write(text);
        file.close();
    }

    function describe(value, depth) {
        if (depth > 4) return '"<deep>"';
        if (value === null || value === undefined) return "null";
        var type = typeof value;
        if (type === "number" || type === "boolean") return String(value);
        if (type === "string") return '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
        if (value instanceof Array) {
            var items = [];
            for (var i = 0; i < value.length; i++) items.push(describe(value[i], depth + 1));
            return "[" + items.join(",") + "]";
        }
        if (type === "object") {
            var pairs = [];
            for (var key in value) {
                try {
                    pairs.push('"' + key + '":' + describe(value[key], depth + 1));
                } catch (inner) {
                    pairs.push('"' + key + '":"<unreadable>"');
                }
            }
            return "{" + pairs.join(",") + "}";
        }
        return '"<' + type + '>"';
    }

    if (!app.project) {
        alert("Open a project first.");
        return;
    }

    var comp = null;
    if (app.project.activeItem instanceof CompItem) {
        comp = app.project.activeItem;
    } else {
        for (var i = 1; i <= app.project.numItems; i++) {
            if (app.project.item(i) instanceof CompItem) {
                comp = app.project.item(i);
                break;
            }
        }
    }
    if (!comp) {
        alert("This project has no composition to inspect.");
        return;
    }

    var report = {};

    // What the project itself says. All read-only here.
    var project = {};
    var names = [
        "workingSpace", "workingGamma", "linearBlending", "linearizeWorkingSpace",
        "compensateForSceneReferredProfiles", "bitsPerChannel", "displayColorSpace",
        "colorSettings", "ocioConfigFile", "colorEngine"
    ];
    for (var n = 0; n < names.length; n++) {
        try {
            var v = app.project[names[n]];
            project[names[n]] = v === undefined ? "<undefined>" : describe(v, 0);
        } catch (readError) {
            project[names[n]] = "<threw: " + readError.toString() + ">";
        }
    }
    report.project = project;
    report.version = app.version;
    report.buildName = app.buildName;
    report.comp = comp.name;

    // The render queue's own vocabulary. Added, read, removed.
    var item = null;
    try {
        item = app.project.renderQueue.items.add(comp);
        var om = item.outputModule(1);

        report.templates = om.templates;

        var formats = {};
        var kinds = ["STRING", "NUMBER", "SPEC", "STRING_SETTABLE", "NUMBER_SETTABLE"];
        for (var k = 0; k < kinds.length; k++) {
            try {
                formats[kinds[k]] = describe(om.getSettings(GetSettingsFormat[kinds[k]]), 0);
            } catch (settingsError) {
                formats[kinds[k]] = "<threw: " + settingsError.toString() + ">";
            }
        }
        report.outputModuleSettings = formats;

        try {
            report.renderSettings = describe(
                item.getSettings(GetSettingsFormat.STRING),
                0
            );
        } catch (rsError) {
            report.renderSettings = "<threw: " + rsError.toString() + ">";
        }
    } catch (queueError) {
        report.error = queueError.toString();
    } finally {
        // Leave the queue exactly as it was found.
        if (item) {
            try { item.remove(); } catch (removeError) {}
        }
    }

    var folder = app.project.file ? app.project.file.parent : Folder.desktop;
    var out = new File(folder.fsName + "/seed-color-probe.json");
    write(out, describe(report, 0));

    alert(
        "Written to:\n\n" + out.fsName +
        "\n\nSend that file back. Nothing was rendered and nothing was changed."
    );
})();
