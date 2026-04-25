var _rootURI;
var _chromeHandle;
var _libsLoaded = false;

function log(msg) {
    Zotero.debug("Metadata Filler: " + msg);
}

function install() {}
function uninstall() {}

function startup({ id, version, rootURI }) {
    _rootURI = rootURI;
    log("Starting, rootURI=" + rootURI);

    // Register chrome content so dialog has chrome privileges
    try {
        var aomStartup = Cc["@mozilla.org/addons/addon-manager-startup;1"]
            .getService(Ci.amIAddonManagerStartup);
        var manifestURI = Services.io.newURI(rootURI + "manifest.json");
        _chromeHandle = aomStartup.registerChrome(manifestURI, [
            ["content", "metadata-filler", "content/"],
            ["content", "metadata-filler-lib", "lib/"]
        ]);
        log("Chrome registered OK");
    }
    catch (e) {
        log("Chrome registration error: " + e);
    }

    // Load lib scripts into bootstrap scope for quick-fill
    try {
        Services.scriptloader.loadSubScript(rootURI + "lib/fieldMappings.js");
        Services.scriptloader.loadSubScript(rootURI + "lib/scanner.js");
        Services.scriptloader.loadSubScript(rootURI + "lib/pdfProcessor.js");
        Services.scriptloader.loadSubScript(rootURI + "lib/llmClient.js");
        Services.scriptloader.loadSubScript(rootURI + "lib/enrich.js");
        Services.scriptloader.loadSubScript(rootURI + "lib/costEstimator.js");

        // Hand the addon's on-disk root to LLMClient so it can find a
        // bundled Apple helper at <root>/bin/fm-helper. rootURI for an
        // unpacked plugin is "file:///…/" — strip the scheme to a path.
        try {
            if (typeof LLMClient !== "undefined" && rootURI && rootURI.indexOf("file://") === 0) {
                var fsPath = decodeURI(rootURI.replace(/^file:\/\//, "").replace(/\/$/, ""));
                LLMClient._addonRootPath = fsPath;
            }
        } catch(e) {}
        _libsLoaded = true;
        log("Libs loaded into bootstrap scope");
    } catch(e) {
        log("Could not load libs into bootstrap (quick-fill disabled): " + e);
        _libsLoaded = false;
    }

    // Init default prefs
    try {
        if (Zotero.Prefs.get("extensions.metadata-filler.sendImages") === undefined) {
            Zotero.Prefs.set("extensions.metadata-filler.sendImages", true);
        }
    } catch(e) {}

    // Auto-install bundled Apple helper on macOS. The .xpi may ship a
    // signed `bin/fm-helper`; we copy it to the Zotero data dir, chmod +x,
    // and strip the quarantine attribute. This is best-effort: any failure
    // just means the user has to set extensions.metadata-filler.apple.helperPath
    // manually, or build the helper themselves.
    try {
        if (Zotero.isMac && rootURI && rootURI.indexOf("file://") === 0) {
            installAppleHelperAsync(rootURI);
        }
    } catch(e) {
        log("Apple helper auto-install skipped: " + e);
    }

    addToAllWindows();
}

async function installAppleHelperAsync(rootURI) {
    var addonRoot = decodeURI(rootURI.replace(/^file:\/\//, "").replace(/\/$/, ""));
    var bundled = PathUtils.join(addonRoot, "bin", "fm-helper");
    if (!(await IOUtils.exists(bundled))) {
        log("Apple helper: not bundled in this .xpi; skipping auto-install");
        return;
    }

    var dataDir = Zotero.DataDirectory.dir;
    var dest = PathUtils.join(dataDir, "fm-helper");

    // Skip the copy if it's already in place AND has the same size — saves
    // chmod + xattr cost on every startup.
    var needsCopy = true;
    try {
        if (await IOUtils.exists(dest)) {
            var srcStat = await IOUtils.stat(bundled);
            var dstStat = await IOUtils.stat(dest);
            if (srcStat.size === dstStat.size) needsCopy = false;
        }
    } catch(e) {}

    if (needsCopy) {
        try {
            var data = await IOUtils.read(bundled);
            await IOUtils.write(dest, data);
            log("Apple helper: copied to " + dest);
        } catch(e) {
            log("Apple helper: copy failed: " + e);
            return;
        }
    }

    // chmod +x (IOUtils has no chmod; shell out to /bin/chmod). Best effort.
    try {
        var chmodFile = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
        chmodFile.initWithPath("/bin/chmod");
        var chmodProc = Cc["@mozilla.org/process/util;1"].createInstance(Ci.nsIProcess);
        chmodProc.init(chmodFile);
        chmodProc.runAsync(["+x", dest], 2, { observe: function(){} });
    } catch(e) {
        log("Apple helper: chmod failed: " + e);
    }

    // Strip quarantine xattr — without this, an ad-hoc-signed binary
    // downloaded from a release will be killed by Gatekeeper. Best effort;
    // silently ignored if `xattr` isn't on PATH or the attribute isn't set.
    try {
        var xattrFile = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
        xattrFile.initWithPath("/usr/bin/xattr");
        var xattrProc = Cc["@mozilla.org/process/util;1"].createInstance(Ci.nsIProcess);
        xattrProc.init(xattrFile);
        xattrProc.runAsync(["-d", "com.apple.quarantine", dest], 3, { observe: function(){} });
    } catch(e) {}
}

function shutdown() {
    log("Shutting down");
    removeFromAllWindows();
    if (_chromeHandle) {
        _chromeHandle.destruct();
        _chromeHandle = null;
    }
    _rootURI = null;
    _libsLoaded = false;
}

function onMainWindowLoad({ window }) {
    log("onMainWindowLoad");
    addToWindow(window);
}

function onMainWindowUnload({ window }) {
    removeFromWindow(window);
}

function addToAllWindows() {
    var enumerator = Services.wm.getEnumerator("navigator:browser");
    while (enumerator.hasMoreElements()) {
        var win = enumerator.getNext();
        if (win.ZoteroPane) addToWindow(win);
    }
}

function removeFromAllWindows() {
    var enumerator = Services.wm.getEnumerator("navigator:browser");
    while (enumerator.hasMoreElements()) {
        var win = enumerator.getNext();
        removeFromWindow(win);
    }
}

function addToWindow(win) {
    try {
        var doc = win.document;
        if (doc.getElementById("metadata-filler-tools-menuitem")) return;

        // Tools menu
        var toolsPopup = doc.getElementById("menu_ToolsPopup");
        if (toolsPopup) {
            var mi = doc.createXULElement("menuitem");
            mi.id = "metadata-filler-tools-menuitem";
            mi.setAttribute("label", "Find & Fill Missing Metadata\u2026");
            mi.addEventListener("command", function() { openMFDialog(win, null); });
            toolsPopup.appendChild(mi);
        }

        // Right-click context menu
        var itemMenu = doc.getElementById("zotero-itemmenu");
        if (itemMenu) {
            var sep = doc.createXULElement("menuseparator");
            sep.id = "metadata-filler-separator";
            itemMenu.appendChild(sep);

            // Open dialog for selected
            var mi2 = doc.createXULElement("menuitem");
            mi2.id = "metadata-filler-context-menuitem";
            mi2.setAttribute("label", "Fill Missing Metadata for Selected\u2026");
            mi2.addEventListener("command", function() {
                var zp = Zotero.getActiveZoteroPane();
                var ids = zp.getSelectedItems(true);
                if (!ids.length) { win.alert("No items selected."); return; }
                openMFDialog(win, ids);
            });
            itemMenu.appendChild(mi2);

            // Quick fill for standalone PDFs (no dialog)
            var mi3 = doc.createXULElement("menuitem");
            mi3.id = "metadata-filler-quickfill-menuitem";
            mi3.setAttribute("label", "Quick Fill Metadata with AI (no dialog)");
            mi3.addEventListener("command", function() {
                quickFillSelected(win);
            });
            itemMenu.appendChild(mi3);
        }

        log("Added menu items");
    }
    catch (e) {
        log("ERROR in addToWindow: " + e);
    }
}

function removeFromWindow(win) {
    var doc = win.document;
    var ids = [
        "metadata-filler-tools-menuitem",
        "metadata-filler-separator",
        "metadata-filler-context-menuitem",
        "metadata-filler-quickfill-menuitem"
    ];
    for (var i = 0; i < ids.length; i++) {
        var el = doc.getElementById(ids[i]);
        if (el) el.remove();
    }
}

function openMFDialog(parentWindow, selectedItemIDs) {
    log("Opening dialog");
    try {
        var url = _chromeHandle
            ? "chrome://metadata-filler/content/main.xhtml"
            : _rootURI + "content/main.xhtml";
        parentWindow.openDialog(
            url,
            "metadata-filler-dialog",
            "chrome,centerscreen,resizable,dialog=no",
            { rootURI: _rootURI, selectedItemIDs: selectedItemIDs || null, Zotero: Zotero }
        );
    }
    catch (e) {
        log("ERROR opening dialog: " + e);
        parentWindow.alert("Metadata Filler error:\n\n" + e);
    }
}

// ── Quick Fill log persistence ───────────────────────────────
// Persists a per-line log of quick-fill activity to a Zotero pref so users
// can review failures and successes from the dialog's "Recent activity"
// panel. Without this, quick-fill errors only land in Zotero.debug, which
// most users never see.
var QUICK_FILL_LOG_PREF = "extensions.metadata-filler.quickFillLog";
var QUICK_FILL_LOG_MAX = 200;

function _qfLogAppend(line) {
    try {
        var raw = Zotero.Prefs.get(QUICK_FILL_LOG_PREF);
        var arr = [];
        if (raw) { try { arr = JSON.parse(raw); } catch(e) { arr = []; } }
        if (!Array.isArray(arr)) arr = [];
        arr.push("[" + (new Date()).toISOString() + "] " + line);
        if (arr.length > QUICK_FILL_LOG_MAX) arr = arr.slice(arr.length - QUICK_FILL_LOG_MAX);
        Zotero.Prefs.set(QUICK_FILL_LOG_PREF, JSON.stringify(arr));
    } catch(e) {
        Zotero.debug("Metadata Filler: could not persist quick-fill log: " + e);
    }
}

// ── Quick Fill (no dialog) ───────────────────────────────────
async function quickFillSelected(win) {
    if (!_libsLoaded) {
        win.alert("Metadata Filler: Quick fill is not available (library scripts failed to load). Use the dialog instead.");
        return;
    }

    var zp = Zotero.getActiveZoteroPane();
    var selectedItems = zp.getSelectedItems();
    if (!selectedItems.length) {
        win.alert("No items selected.");
        return;
    }

    // Filter to standalone PDF attachments only
    var orphanPDFs = [];
    for (var i = 0; i < selectedItems.length; i++) {
        var item = selectedItems[i];
        if (item.isAttachment() && !item.parentItemID && item.attachmentContentType === "application/pdf") {
            orphanPDFs.push(item);
        }
    }

    if (orphanPDFs.length === 0) {
        win.alert("Metadata Filler: No standalone PDF attachments selected.\n\nThis quick action only works on PDFs that have no parent item. For other items, use 'Fill Missing Metadata for Selected\u2026' instead.");
        return;
    }

    // Get provider settings
    var provider = Zotero.Prefs.get("extensions.metadata-filler.provider") || "openai";
    var apiKey = LLMClient.getAPIKey(provider);
    if (!apiKey) {
        win.alert("Metadata Filler: No API key configured for " + provider + ".\n\nPlease set your API key via Tools > Find & Fill Missing Metadata first.");
        return;
    }
    var model = LLMClient.getEffectiveModel(provider);
    var maxTokens = Zotero.Prefs.get("extensions.metadata-filler.maxTokens") || 2048;
    var doiShortcut = Zotero.Prefs.get("extensions.metadata-filler.doiShortcut") !== false;
    var forceLLM = !!Zotero.Prefs.get("extensions.metadata-filler.forceLLM");
    var enrichEnabled = Zotero.Prefs.get("extensions.metadata-filler.enrich") !== false;

    // Show progress popup
    var progressWin = new Zotero.ProgressWindow({ closeOnClick: false });
    progressWin.changeHeadline("Quick Fill Metadata");
    progressWin.addDescription("Processing " + orphanPDFs.length + " PDF(s) with " + provider + " (" + model + ")...");
    progressWin.show();

    var successCount = 0;
    var errorCount = 0;

    _qfLogAppend("──── Quick Fill run: " + orphanPDFs.length + " PDF(s), provider=" + provider + ", model=" + model + " ────");

    for (var j = 0; j < orphanPDFs.length; j++) {
        var pdfItem = orphanPDFs[j];
        var filename = pdfItem.attachmentFilename || "(unnamed)";

        try {
            log("Quick fill: processing " + filename);
            _qfLogAppend("Processing: " + filename);

            // Extract text
            var pdfData = await PDFProcessor.process(pdfItem);
            if (!pdfData.text || pdfData.text.length < 50 || pdfData.text.indexOf("%PDF") === 0) {
                throw new Error("Could not extract readable text from PDF");
            }

            // Check if we should send images
            var sendImages = Zotero.Prefs.get("extensions.metadata-filler.sendImages");
            var imageToSend = sendImages ? pdfData.imageBase64 : null;

            // ── DOI shortcut for Quick Fill ──
            // If the first page contains a DOI and the user hasn't disabled
            // it, skip the LLM entirely and pull canonical metadata from
            // OpenAlex (or CrossRef). This is the fastest, cheapest, and
            // most accurate path when it works.
            var detectedDOI = Enrich.extractDOIFromText((pdfData.text || "").substring(0, 4000));
            var enrichedShortcut = null;
            if (detectedDOI && doiShortcut && !forceLLM) {
                _qfLogAppend("  DOI detected (" + detectedDOI + "), trying OpenAlex/CrossRef shortcut");
                enrichedShortcut = await Enrich.fetchByDOI(detectedDOI);
                if (enrichedShortcut) {
                    _qfLogAppend("  ✓ shortcut succeeded via " + (enrichedShortcut._source || "openalex"));
                } else {
                    _qfLogAppend("  ✗ shortcut miss; falling back to LLM");
                }
            }

            // Query LLM (skipped if DOI shortcut succeeded)
            var result;
            if (enrichedShortcut) {
                // Heuristic: OpenAlex doesn't return item type, but works are
                // overwhelmingly journal articles. Default to journalArticle.
                result = { itemType: "journalArticle", metadata: enrichedShortcut };
            } else {
                result = await LLMClient.queryOrphan({
                    text: pdfData.text,
                    imageBase64: imageToSend,
                    embedded: pdfData.embedded,
                    provider: provider,
                    apiKey: apiKey,
                    model: model,
                    maxTokens: maxTokens,
                });

                // Post-LLM enrichment for Quick Fill too
                if (enrichEnabled && result.metadata) {
                    var doiToCheck = result.metadata.doi || detectedDOI;
                    var postEnriched = null;
                    if (doiToCheck) postEnriched = await Enrich.fetchByDOI(doiToCheck);
                    else if (result.metadata.title) postEnriched = await Enrich.searchByTitle(result.metadata.title);
                    if (postEnriched) {
                        _qfLogAppend("  ↻ enriched from " + (postEnriched._source || "openalex"));
                        result.metadata = Enrich.mergeOver(result.metadata, postEnriched);
                    }
                }
            }

            log("Quick fill: LLM identified type=" + result.itemType + ", fields=" + Object.keys(result.metadata).length);

            if (Object.keys(result.metadata).length === 0) {
                throw new Error("LLM could not extract any metadata");
            }

            // Create new parent item
            var itemType = result.itemType || "document";
            var itemTypeID = Zotero.ItemTypes.getID(itemType);
            if (!itemTypeID) itemTypeID = Zotero.ItemTypes.getID("document");

            var newItem = new Zotero.Item();
            newItem.libraryID = pdfItem.libraryID;
            newItem.setType(itemTypeID);

            var fieldDefs = FieldMappings.getFieldsForType(itemType);
            var creators = [];

            for (var f = 0; f < fieldDefs.length; f++) {
                var fieldDef = fieldDefs[f];
                var value = result.metadata[fieldDef.llmKey];
                if (value === undefined || value === null) continue;

                if (fieldDef.isCreator && Array.isArray(value)) {
                    var creatorTypeID = Zotero.CreatorTypes.getID(fieldDef.creatorType);
                    for (var c = 0; c < value.length; c++) {
                        creators.push({
                            firstName: value[c].firstName || "",
                            lastName: value[c].lastName || "",
                            creatorTypeID: creatorTypeID,
                        });
                    }
                } else {
                    try { newItem.setField(fieldDef.zotero, String(value)); } catch(e) {}
                }
            }
            if (creators.length > 0) newItem.setCreators(creators);

            await newItem.saveTx();
            pdfItem.parentItemID = newItem.id;
            await pdfItem.saveTx();

            log("Quick fill: created parent item " + newItem.id + " for " + filename);
            _qfLogAppend("  ✓ Created parent (type=" + itemType + ", " + Object.keys(result.metadata).length + " fields) for " + filename);
            successCount++;
        } catch(e) {
            log("Quick fill ERROR for " + filename + ": " + e);
            _qfLogAppend("  ✗ ERROR for " + filename + ": " + (e && e.message ? e.message : String(e)));
            errorCount++;
        }
    }

    _qfLogAppend("──── Run finished: " + successCount + " succeeded, " + errorCount + " failed ────");

    progressWin.close();

    // Show result
    var resultWin = new Zotero.ProgressWindow({ closeOnClick: true });
    resultWin.changeHeadline("Quick Fill Complete");
    var msg = successCount + " PDF(s) processed successfully.";
    if (errorCount > 0) msg += " " + errorCount + " error(s) — check debug log.";
    resultWin.addDescription(msg);
    resultWin.show();
    resultWin.startCloseTimer(5000);
}
