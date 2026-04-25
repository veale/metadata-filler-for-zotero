/* global Zotero, FieldMappings, Scanner, PDFProcessor, LLMClient */
"use strict";

/**
 * MetadataFillerDialog — Controller for the multi-step dialog.
 *
 * Steps:
 *   1. Configure  — pick item types, fields, and AI provider
 *   2. Results    — review scan results, select items to process
 *   3. Processing — progress UI while LLM calls run
 *   4. Review     — inspect & approve/reject proposed changes
 *   5. Done       — summary of applied changes
 */
var MetadataFillerDialog = {

    // ── Helpers ───────────────────────────────────────────────
    // In XUL documents, createElement("button") creates XUL buttons
    // which fire "command" not "click". We need HTML buttons.
    _htmlBtn(text, className, handler) {
        var btn = document.createElementNS("http://www.w3.org/1999/xhtml", "button");
        btn.textContent = text;
        btn.className = className || "";
        if (handler) {
            btn.addEventListener("click", handler);
            btn.addEventListener("command", handler); // XUL fallback
        }
        return btn;
    },

    // ── State ─────────────────────────────────────────────────
    _args: null,
    _currentStep: "configure",
    _selectedTypes: null,          // Set<typeKey>
    _selectedFieldLabels: null,    // Set<fieldLabel>
    _allFieldLabels: null,         // Array<string>
    _scanResults: [],           // from Scanner.scan()
    _selectedForProcessing: new Set(),  // indices into _scanResults
    _processingCancelled: false,
    _llmResults: [],            // { scanResult, llmData?, error? }
    _logBuffer: [],             // full log text for download
    _reviewDecisions: [],       // "accepted" | "rejected" per llmResult

    // ── Initialisation ────────────────────────────────────────

    async init(args) {
        this._args = args;
        this._bindEvents();
        this._loadProviderPrefs();
        this._buildTypeList();
        this._showStep("configure");
    },

    // ── Navigation ────────────────────────────────────────────

    _showStep(step) {
        this._currentStep = step;
        for (const el of document.querySelectorAll(".mf-step")) {
            el.hidden = true;
        }
        document.getElementById("step-" + step).hidden = false;

        const labels = {
            configure: "Step 1 of 4 — Configure",
            results: "Step 2 of 4 — Select Items",
            processing: "Step 3 of 4 — Processing",
            review: "Step 4 of 4 — Review Changes",
            done: "Complete",
        };
        document.getElementById("mf-step-indicator").textContent = labels[step] || "";
    },

    _setStatus(msg) {
        document.getElementById("mf-status").textContent = msg;
    },

    // ── Event binding ─────────────────────────────────────────

    _bindEvents() {
        const $ = (id) => document.getElementById(id);

        // Provider config
        $("cfg-provider").addEventListener("command", () => this._onProviderChange());
        $("cfg-apikey").addEventListener("input", () => this._saveProviderPrefs());
        $("cfg-model").addEventListener("input", () => this._saveProviderPrefs());

        // Custom endpoint
        var endpointEl = $("cfg-custom-endpoint");
        if (endpointEl) {
            endpointEl.addEventListener("input", () => {
                Zotero.Prefs.set("extensions.metadata-filler.custom.endpoint", endpointEl.value.trim());
            });
        }

        // Type/field bulk actions (now <a> links, need preventDefault)
        $("cfg-select-all-types").addEventListener("click", (e) => { e.preventDefault(); this._toggleAllTypes(true); });
        $("cfg-deselect-all-types").addEventListener("click", (e) => { e.preventDefault(); this._toggleAllTypes(false); });
        $("cfg-select-all-fields").addEventListener("click", (e) => { e.preventDefault(); this._toggleAllFields(true); });
        $("cfg-deselect-all-fields").addEventListener("click", (e) => { e.preventDefault(); this._toggleAllFields(false); });

        // Navigation buttons — add both click and command for XUL/HTML compatibility
        var scanHandler = () => this._onScan();
        var backConfigHandler = () => this._showStep("configure");
        var processHandler = () => this._onProcess();
        var cancelHandler = () => { this._processingCancelled = true; };
        var startOverHandler = () => this._onStartOver();
        var closeHandler = () => window.close();

        $("btn-scan").addEventListener("click", scanHandler);
        $("btn-scan").addEventListener("command", scanHandler);
        $("btn-back-to-config").addEventListener("click", backConfigHandler);
        $("btn-back-to-config").addEventListener("command", backConfigHandler);
        $("btn-process").addEventListener("click", processHandler);
        $("btn-process").addEventListener("command", processHandler);
        $("btn-cancel-processing").addEventListener("click", cancelHandler);
        $("btn-cancel-processing").addEventListener("command", cancelHandler);
        $("btn-start-over").addEventListener("click", startOverHandler);
        $("btn-start-over").addEventListener("command", startOverHandler);
        $("btn-close").addEventListener("click", closeHandler);
        $("btn-close").addEventListener("command", closeHandler);
        $("btn-download-log").addEventListener("click", () => this._downloadLog());
        $("btn-download-log").addEventListener("command", () => this._downloadLog());

        // Advanced: system prompt — load current value, save / restore
        var promptArea = $("cfg-system-prompt");
        var promptStatus = $("cfg-prompt-status");
        if (promptArea) {
            var stored = "";
            try { stored = Zotero.Prefs.get("extensions.metadata-filler.systemPromptTemplate") || ""; } catch(e) {}
            promptArea.value = stored || LLMClient.DEFAULT_SYSTEM_PROMPT;
        }
        var promptSaveEl = $("cfg-prompt-save");
        if (promptSaveEl) {
            promptSaveEl.addEventListener("click", function() {
                try {
                    Zotero.Prefs.set("extensions.metadata-filler.systemPromptTemplate", promptArea.value);
                    if (promptStatus) {
                        promptStatus.textContent = "Saved.";
                        setTimeout(function(){ promptStatus.textContent = ""; }, 2000);
                    }
                } catch(e) {
                    if (promptStatus) promptStatus.textContent = "Error: " + e.message;
                }
            });
        }
        var promptRestoreEl = $("cfg-prompt-restore");
        if (promptRestoreEl) {
            promptRestoreEl.addEventListener("click", function() {
                promptArea.value = LLMClient.DEFAULT_SYSTEM_PROMPT;
                try { Zotero.Prefs.set("extensions.metadata-filler.systemPromptTemplate", ""); } catch(e) {}
                if (promptStatus) {
                    promptStatus.textContent = "Restored to default.";
                    setTimeout(function(){ promptStatus.textContent = ""; }, 2000);
                }
            });
        }

        // Advanced: body overrides — per provider
        var overridesArea = $("cfg-body-overrides");
        var overridesStatus = $("cfg-overrides-status");
        var self = this;
        var loadOverridesForProvider = function() {
            var provider = $("cfg-provider").value;
            var lbl = $("cfg-overrides-provider-label");
            if (lbl) lbl.textContent = provider;
            if (overridesArea) {
                var v = "";
                try { v = Zotero.Prefs.get("extensions.metadata-filler." + provider + ".bodyOverrides") || ""; } catch(e) {}
                overridesArea.value = v;
            }
        };
        loadOverridesForProvider();
        $("cfg-provider").addEventListener("command", loadOverridesForProvider);

        var overridesSaveEl = $("cfg-overrides-save");
        if (overridesSaveEl) {
            overridesSaveEl.addEventListener("click", function() {
                var provider = $("cfg-provider").value;
                var raw = overridesArea.value.trim();
                if (raw) {
                    try { JSON.parse(raw); } catch(e) {
                        if (overridesStatus) overridesStatus.textContent = "Invalid JSON: " + e.message;
                        return;
                    }
                }
                Zotero.Prefs.set("extensions.metadata-filler." + provider + ".bodyOverrides", raw);
                if (overridesStatus) {
                    overridesStatus.textContent = "Saved for " + provider + ".";
                    setTimeout(function(){ overridesStatus.textContent = ""; }, 2000);
                }
            });
        }
        var overridesClearEl = $("cfg-overrides-clear");
        if (overridesClearEl) {
            overridesClearEl.addEventListener("click", function() {
                var provider = $("cfg-provider").value;
                Zotero.Prefs.set("extensions.metadata-filler." + provider + ".bodyOverrides", "");
                overridesArea.value = "";
                if (overridesStatus) {
                    overridesStatus.textContent = "Cleared for " + provider + ".";
                    setTimeout(function(){ overridesStatus.textContent = ""; }, 2000);
                }
            });
        }

        // Quick Fill log viewer (on configure step)
        var qfRefreshEl = $("cfg-quickfill-refresh");
        var qfClearEl = $("cfg-quickfill-clear");
        if (qfRefreshEl) qfRefreshEl.addEventListener("click", function(){ self._refreshQuickFillLog(); });
        if (qfClearEl) qfClearEl.addEventListener("click", function() {
            Zotero.Prefs.set("extensions.metadata-filler.quickFillLog", "");
            self._refreshQuickFillLog();
        });
        try { this._refreshQuickFillLog(); } catch(e) {}

        // Send images checkbox
        var sendImgEl = $("cfg-send-images");
        if (sendImgEl) {
            sendImgEl.addEventListener("change", function() {
                Zotero.Prefs.set("extensions.metadata-filler.sendImages", sendImgEl.checked);
            });
        }

        // Results bulk actions
        var selAllHandler = () => this._toggleAllResultItems(true);
        var deselAllHandler = () => this._toggleAllResultItems(false);
        $("btn-select-all-items").addEventListener("click", selAllHandler);
        $("btn-select-all-items").addEventListener("command", selAllHandler);
        $("btn-deselect-all-items").addEventListener("click", deselAllHandler);
        $("btn-deselect-all-items").addEventListener("command", deselAllHandler);
        $("results-filter").addEventListener("input", (e) => this._filterResults(e.target.value));
        $("results-check-all").addEventListener("change", (e) => this._toggleAllResultItems(e.target.checked));

        // Review bulk actions — html:buttons should fire click, but add command too for safety
        var acceptAllEl = $("btn-accept-all");
        var rejectAllEl = $("btn-reject-all");
        var applyEl = $("btn-apply");
        var backResultsEl = $("btn-back-to-results");

        var acceptAllHandler = () => this._setAllReviewDecisions("accepted");
        var rejectAllHandler = () => this._setAllReviewDecisions("rejected");
        var applyHandler = () => this._onApply();
        var backResultsHandler = () => this._showStep("results");

        acceptAllEl.addEventListener("click", acceptAllHandler);
        acceptAllEl.addEventListener("command", acceptAllHandler);
        rejectAllEl.addEventListener("click", rejectAllHandler);
        rejectAllEl.addEventListener("command", rejectAllHandler);
        applyEl.addEventListener("click", applyHandler);
        applyEl.addEventListener("command", applyHandler);
        backResultsEl.addEventListener("click", backResultsHandler);
        backResultsEl.addEventListener("command", backResultsHandler);
    },

    // ── Quick Fill log viewer ─────────────────────────────────

    _refreshQuickFillLog() {
        var pre = document.getElementById("cfg-quickfill-log");
        if (!pre) return;
        var raw = "";
        try { raw = Zotero.Prefs.get("extensions.metadata-filler.quickFillLog") || ""; } catch(e) {}
        var lines = [];
        if (raw) {
            try { lines = JSON.parse(raw); } catch(e) { lines = []; }
        }
        if (!Array.isArray(lines) || lines.length === 0) {
            pre.textContent = "(no Quick Fill activity recorded yet — use the right-click \"Quick Fill Metadata with AI\" action to populate this)";
        } else {
            pre.textContent = lines.join("\n");
            pre.scrollTop = pre.scrollHeight;
        }
    },

    // ── Step 1: Configure ─────────────────────────────────────

    _loadProviderPrefs() {
        const provider = Zotero.Prefs.get("extensions.metadata-filler.provider") || "openai";
        document.getElementById("cfg-provider").value = provider;
        this._onProviderChange();

        // Load send images preference
        var sendImages = Zotero.Prefs.get("extensions.metadata-filler.sendImages");
        var sendImgEl = document.getElementById("cfg-send-images");
        if (sendImgEl) {
            sendImgEl.checked = (sendImages !== false); // default true
        }
    },

    _onProviderChange() {
        const provider = document.getElementById("cfg-provider").value;
        Zotero.Prefs.set("extensions.metadata-filler.provider", provider);

        const apiKey = LLMClient.getAPIKey(provider);
        const model = LLMClient.getEffectiveModel(provider);
        const defaultModel = LLMClient.providers[provider].defaultModel;

        document.getElementById("cfg-apikey").value = apiKey;
        document.getElementById("cfg-model").value = model;
        document.getElementById("cfg-model-hint").textContent = "(default: " + defaultModel + ")";

        // Show/hide custom endpoint row
        var endpointRow = document.getElementById("cfg-custom-endpoint-row");
        if (endpointRow) {
            endpointRow.hidden = (provider !== "custom");
        }
        var endpointInput = document.getElementById("cfg-custom-endpoint");
        if (endpointInput && provider === "custom") {
            endpointInput.value = Zotero.Prefs.get("extensions.metadata-filler.custom.endpoint") || "";
        }
    },

    _saveProviderPrefs() {
        const provider = document.getElementById("cfg-provider").value;
        const apiKey = document.getElementById("cfg-apikey").value.trim();
        const model = document.getElementById("cfg-model").value.trim();
        const defaultModel = LLMClient.providers[provider].defaultModel;

        Zotero.Prefs.set(`extensions.metadata-filler.${provider}.apiKey`, apiKey);

        if (model && model !== defaultModel) {
            Zotero.Prefs.set(`extensions.metadata-filler.${provider}.customModel`, model);
        } else {
            Zotero.Prefs.set(`extensions.metadata-filler.${provider}.customModel`, "");
        }
    },

    _buildTypeList() {
        var container = document.getElementById("cfg-type-list");
        container.innerHTML = "";

        this._selectedTypes = new Set();
        var typeKeys = FieldMappings.getTypeKeys();
        for (var t = 0; t < typeKeys.length; t++) {
            var typeKey = typeKeys[t];
            var typeDef = FieldMappings.types[typeKey];
            var div = document.createElement("div");
            div.className = "mf-check-item";
            div.dataset.typeKey = typeKey;

            var cb = document.createElement("input");
            cb.type = "checkbox";
            cb.id = "type-cb-" + typeKey;
            cb.checked = true;
            cb.dataset.typeKey = typeKey;

            var label = document.createElement("label");
            label.htmlFor = cb.id;
            label.textContent = typeDef.label;

            div.appendChild(cb);
            div.appendChild(label);
            div.addEventListener("click", (function(checkbox) {
                return function(e) {
                    if (e.target !== checkbox) checkbox.checked = !checkbox.checked;
                    checkbox.dispatchEvent(new Event("change"));
                };
            })(cb));

            cb.addEventListener("change", (function(tk) {
                return function(e) {
                    if (e.target.checked) {
                        this._selectedTypes.add(tk);
                    } else {
                        this._selectedTypes.delete(tk);
                    }
                };
            })(typeKey).bind(this));

            container.appendChild(div);
            this._selectedTypes.add(typeKey);
        }

        // Build the static field list (all unique fields across all types)
        this._buildFieldList();
    },

    _buildFieldList() {
        var container = document.getElementById("cfg-field-list");
        container.innerHTML = "";

        // Gather all unique fields across all types, deduplicate by label
        this._allFieldLabels = [];
        this._selectedFieldLabels = new Set();
        var seen = {};

        var typeKeys = FieldMappings.getTypeKeys();
        for (var t = 0; t < typeKeys.length; t++) {
            var fields = FieldMappings.getFieldsForType(typeKeys[t]);
            for (var f = 0; f < fields.length; f++) {
                var fieldLabel = fields[f].label;
                if (!seen[fieldLabel]) {
                    seen[fieldLabel] = true;
                    this._allFieldLabels.push(fieldLabel);
                }
            }
        }

        // Sort alphabetically
        this._allFieldLabels.sort();

        // Build checkboxes — all selected by default
        for (var i = 0; i < this._allFieldLabels.length; i++) {
            var fl = this._allFieldLabels[i];
            var div = document.createElement("div");
            div.className = "mf-check-item";

            var cb = document.createElement("input");
            cb.type = "checkbox";
            cb.id = "field-cb-" + i;
            cb.checked = true;
            cb.dataset.fieldLabel = fl;

            var label = document.createElement("label");
            label.htmlFor = cb.id;
            label.textContent = fl;

            cb.addEventListener("change", (function(fieldLabel) {
                return function(e) {
                    if (e.target.checked) {
                        this._selectedFieldLabels.add(fieldLabel);
                    } else {
                        this._selectedFieldLabels.delete(fieldLabel);
                    }
                };
            })(fl).bind(this));

            div.appendChild(cb);
            div.appendChild(label);
            div.addEventListener("click", (function(checkbox) {
                return function(e) {
                    if (e.target !== checkbox) {
                        checkbox.checked = !checkbox.checked;
                        checkbox.dispatchEvent(new Event("change"));
                    }
                };
            })(cb));

            container.appendChild(div);
            this._selectedFieldLabels.add(fl);
        }
    },

    _toggleAllTypes(state) {
        this._selectedTypes.clear();
        var cbs = document.querySelectorAll("#cfg-type-list input[type='checkbox']");
        for (var i = 0; i < cbs.length; i++) {
            cbs[i].checked = state;
            if (state) this._selectedTypes.add(cbs[i].dataset.typeKey);
        }
    },

    _toggleAllFields(state) {
        this._selectedFieldLabels.clear();
        var cbs = document.querySelectorAll("#cfg-field-list input[type='checkbox']");
        for (var i = 0; i < cbs.length; i++) {
            cbs[i].checked = state;
            if (state) this._selectedFieldLabels.add(cbs[i].dataset.fieldLabel);
        }
    },

    // ── Step 2: Scan ──────────────────────────────────────────

    async _onScan() {
        // Build typeFieldSelections from the flat type + field selections
        var selections = {};
        var typeKeys = FieldMappings.getTypeKeys();
        for (var t = 0; t < typeKeys.length; t++) {
            var tk = typeKeys[t];
            if (!this._selectedTypes.has(tk)) continue;

            var fields = FieldMappings.getFieldsForType(tk);
            var selectedFields = [];
            for (var f = 0; f < fields.length; f++) {
                if (this._selectedFieldLabels.has(fields[f].label)) {
                    selectedFields.push(fields[f]);
                }
            }
            if (selectedFields.length > 0) {
                selections[tk] = selectedFields;
            }
        }

        var scanOrphans = document.getElementById("cfg-scan-orphans")?.checked;

        if (Object.keys(selections).length === 0 && !scanOrphans) {
            this._setStatus("Please select at least one item type and field to check, or enable orphan PDF scanning.");
            return;
        }

        // Check API key
        const provider = document.getElementById("cfg-provider").value;
        if (!LLMClient.getAPIKey(provider)) {
            this._setStatus("Please enter an API key for the selected provider.");
            return;
        }

        this._setStatus("Scanning library...");
        document.getElementById("btn-scan").disabled = true;

        try {
            this._scanResults = [];

            // Scan for items with missing metadata
            if (Object.keys(selections).length > 0) {
                var metadataResults = await Scanner.scan({
                    typeFieldSelections: selections,
                    itemIDs: this._args.selectedItemIDs,
                    onProgress: (cur, total) => {
                        this._setStatus("Scanning items: " + cur + " / " + total);
                    },
                });
                this._scanResults = this._scanResults.concat(metadataResults);
            }

            // Scan for orphan PDFs
            if (scanOrphans) {
                this._setStatus("Scanning for standalone PDFs...");
                var orphanResults = await Scanner.scanOrphanPDFs({
                    itemIDs: this._args.selectedItemIDs,
                    onProgress: (cur, total) => {
                        this._setStatus("Scanning for standalone PDFs: " + cur + " / " + total);
                    },
                });
                this._scanResults = this._scanResults.concat(orphanResults);
            }

            var orphanCount = this._scanResults.filter(function(r) { return r.isOrphan; }).length;
            var metaCount = this._scanResults.length - orphanCount;
            this._setStatus("Scan complete. Found " + metaCount + " items with missing metadata and " + orphanCount + " standalone PDFs.");

            this._selectedForProcessing = new Set();
            this._buildResultsTable();
            this._showStep("results");
        } catch (e) {
            this._setStatus("Scan error: " + e.message);
            Zotero.debug("[MetadataFiller] Scan error: " + e);
        } finally {
            document.getElementById("btn-scan").disabled = false;
        }
    },

    _buildResultsTable() {
        const tbody = document.getElementById("results-tbody");
        tbody.innerHTML = "";

        const summary = document.getElementById("results-summary");
        const withPDF = this._scanResults.filter((r) => r.hasPDF).length;
        const orphanCount = this._scanResults.filter((r) => r.isOrphan).length;
        summary.textContent = "Found " + (this._scanResults.length - orphanCount) + " items with missing metadata"
            + (orphanCount > 0 ? " and " + orphanCount + " standalone PDFs" : "")
            + " (" + withPDF + " have PDF attachments). ";

        for (let i = 0; i < this._scanResults.length; i++) {
            const r = this._scanResults[i];
            const tr = document.createElement("tr");
            tr.dataset.index = i;
            if (!r.hasPDF) tr.className = "no-pdf";

            // Checkbox
            const tdCb = document.createElement("td");
            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.disabled = !r.hasPDF;
            cb.checked = r.hasPDF;
            if (r.hasPDF) this._selectedForProcessing.add(i);
            cb.addEventListener("change", () => {
                if (cb.checked) this._selectedForProcessing.add(i);
                else this._selectedForProcessing.delete(i);
                this._updateProcessButton();
            });
            tdCb.appendChild(cb);
            tr.appendChild(tdCb);

            // Title
            const tdTitle = document.createElement("td");
            var title = "";
            try { title = r.item.getField("title"); } catch(e) {}
            if (!title && r.isOrphan) {
                // Use filename for orphan PDFs
                try {
                    var fn = r.item.attachmentFilename;
                    title = fn || "(unnamed PDF)";
                } catch(e) { title = "(standalone PDF)"; }
            }
            tdTitle.textContent = title || "(untitled)";
            tr.appendChild(tdTitle);

            // Type
            const tdType = document.createElement("td");
            if (r.isOrphan) {
                tdType.textContent = "Standalone PDF";
                tdType.style.fontStyle = "italic";
                tdType.style.color = "#9333ea";
            } else {
                tdType.textContent = FieldMappings.types[r.typeKey]?.label || r.typeKey;
            }
            tr.appendChild(tdType);

            // Missing fields
            const tdFields = document.createElement("td");
            if (r.isOrphan) {
                const badge = document.createElement("span");
                badge.className = "mf-missing-badge";
                badge.style.background = "#f3e8ff";
                badge.style.color = "#6b21a8";
                badge.textContent = "All (AI will identify type)";
                tdFields.appendChild(badge);
            } else {
                for (const f of r.missingFields) {
                    const badge = document.createElement("span");
                    badge.className = "mf-missing-badge";
                    badge.textContent = f.label;
                    tdFields.appendChild(badge);
                }
            }
            tr.appendChild(tdFields);

            // PDF
            const tdPDF = document.createElement("td");
            if (r.hasPDF) {
                var sp = document.createElement("span");
                sp.className = "mf-pdf-yes";
                sp.textContent = "Yes";
                tdPDF.appendChild(sp);
            } else {
                var sp2 = document.createElement("span");
                sp2.className = "mf-pdf-no";
                sp2.textContent = "No";
                tdPDF.appendChild(sp2);
            }
            tr.appendChild(tdPDF);

            tbody.appendChild(tr);
        }

        this._updateProcessButton();
    },

    _updateProcessButton() {
        const btn = document.getElementById("btn-process");
        const count = this._selectedForProcessing.size;
        btn.textContent = `Process ${count} Item${count !== 1 ? "s" : ""} with AI`;
        btn.disabled = count === 0;
    },

    _toggleAllResultItems(state) {
        this._selectedForProcessing.clear();
        const rows = document.querySelectorAll("#results-tbody tr");
        for (const row of rows) {
            const i = parseInt(row.dataset.index);
            const cb = row.querySelector("input[type='checkbox']");
            if (cb && !cb.disabled) {
                cb.checked = state;
                if (state) this._selectedForProcessing.add(i);
            }
        }
        this._updateProcessButton();
    },

    _filterResults(query) {
        const q = query.toLowerCase();
        const rows = document.querySelectorAll("#results-tbody tr");
        for (const row of rows) {
            const title = row.children[1]?.textContent.toLowerCase() || "";
            row.hidden = q && !title.includes(q);
        }
    },

    // ── Step 3: Processing ────────────────────────────────────

    async _onProcess() {
        const indices = [...this._selectedForProcessing].sort((a, b) => a - b);
        if (indices.length === 0) return;

        this._processingCancelled = false;
        this._llmResults = [];
        this._logBuffer = [];
        this._showStep("processing");

        const provider = document.getElementById("cfg-provider").value;
        const apiKey = LLMClient.getAPIKey(provider);
        const model = LLMClient.getEffectiveModel(provider);
        const maxTokens = Zotero.Prefs.get("extensions.metadata-filler.maxTokens") || 2048;
        const sendImages = Zotero.Prefs.get("extensions.metadata-filler.sendImages") !== false;

        const progressBar = document.getElementById("processing-progress");
        const statusEl = document.getElementById("processing-status");
        const logEl = document.getElementById("processing-log");
        const titleEl = document.getElementById("processing-title");
        progressBar.max = indices.length;

        const concurrency = Zotero.Prefs.get("extensions.metadata-filler.concurrency") || 3;

        this._log(logEl, `Starting processing: ${indices.length} items with ${provider} (${model})`);
        this._log(logEl, `Concurrency: ${concurrency}\n`);

        let completed = 0;

        // Process in batches
        for (let batchStart = 0; batchStart < indices.length; batchStart += concurrency) {
            if (this._processingCancelled) break;

            const batch = indices.slice(batchStart, batchStart + concurrency);
            const promises = batch.map(async (idx) => {
                const scanResult = this._scanResults[idx];
                var title = "";
                try { title = scanResult.item.getField("title"); } catch(e) {}
                if (!title && scanResult.isOrphan) {
                    try { title = scanResult.item.attachmentFilename || "(unnamed PDF)"; } catch(e) { title = "(standalone PDF)"; }
                }
                title = title || "(untitled)";

                try {
                    // Get PDF: for orphans, the item IS the PDF; for regular items, find attachment
                    var attachment;
                    if (scanResult.isOrphan) {
                        attachment = scanResult.item;
                    } else {
                        attachment = await Scanner.getPDFAttachment(scanResult.item);
                    }
                    if (!attachment) {
                        throw new Error("No PDF attachment found");
                    }

                    this._log(logEl, `[${completed + 1}/${indices.length}] Processing: ${title}`);
                    statusEl.textContent = `Processing: ${title}`;

                    // Extract text & image from PDF
                    const pdfData = await PDFProcessor.process(attachment);

                    // Check if user wants to send images
                    var sendImages = Zotero.Prefs.get("extensions.metadata-filler.sendImages") !== false;
                    var imageToSend = (sendImages && pdfData.imageBase64) ? pdfData.imageBase64 : null;

                    var extractInfo = pdfData.text.length + " chars, image: " + (imageToSend ? "yes (sending)" : pdfData.imageBase64 ? "available (not sending)" : "no");
                    var textPreview = pdfData.text.substring(0, 80).replace(/\n/g, " ");
                    this._log(logEl, "  > Extracted " + extractInfo);
                    this._log(logEl, "  > Preview: " + textPreview + "...");
                    this._logBuffer.push("  > TEXT SNIPPET (first 500 chars):\n" + pdfData.text.substring(0, 500));

                    if (scanResult.isOrphan) {
                        // Orphan mode: ask LLM to identify item type + all metadata
                        const orphanResult = await LLMClient.queryOrphan({
                            text: pdfData.text,
                            imageBase64: imageToSend,
                            provider,
                            apiKey,
                            model,
                            maxTokens,
                        });

                        const foundCount = Object.keys(orphanResult.metadata).length;
                        this._log(logEl, `  > LLM identified type: ${orphanResult.itemType}, returned ${foundCount} field(s)`);
                        this._logBuffer.push("  > RAW LLM RESPONSE:\n" + (LLMClient._lastRawResponse || "(empty)"));
                        if (foundCount > 0) {
                            this._logBuffer.push("  > PARSED METADATA: " + JSON.stringify(orphanResult.metadata, null, 2));
                        }

                        this._llmResults.push({
                            scanResult,
                            llmData: orphanResult.metadata,
                            orphanItemType: orphanResult.itemType,
                            isOrphan: true,
                            error: null,
                        });
                    } else {
                        // Normal mode: fill missing fields
                        const typeLabel = FieldMappings.types[scanResult.typeKey]?.label || scanResult.typeKey;
                        const llmData = await LLMClient.query({
                            text: pdfData.text,
                            imageBase64: imageToSend,
                            missingFields: scanResult.missingFields,
                            itemTypeLabel: typeLabel,
                            provider,
                            apiKey,
                            model,
                            maxTokens,
                        });

                        const foundCount = Object.keys(llmData).length;
                        this._log(logEl, `  > LLM returned ${foundCount} field(s)`);
                        this._logBuffer.push("  > RAW LLM RESPONSE:\n" + (LLMClient._lastRawResponse || "(empty)"));
                        this._logBuffer.push("  > EXPECTED KEYS: " + scanResult.missingFields.map(function(f){return f.llmKey;}).join(", "));
                        if (foundCount > 0) {
                            this._logBuffer.push("  > MATCHED FIELDS: " + JSON.stringify(llmData, null, 2));
                        }

                        this._llmResults.push({ scanResult, llmData, error: null });
                    }
                } catch (e) {
                    this._log(logEl, `  X Error: ${e.message}`);
                    this._logBuffer.push("  X RAW LLM RESPONSE (on error):\n" + (LLMClient._lastRawResponse || "(none)"));
                    this._logBuffer.push("  X Full error: " + e + "\n" + (e.stack || ""));
                    this._llmResults.push({ scanResult, llmData: null, error: e.message });
                }

                completed++;
                progressBar.value = completed;
            });

            await Promise.all(promises);
        }

        if (this._processingCancelled) {
            this._log(logEl, "\nProcessing cancelled by user.");
            titleEl.textContent = "Processing Cancelled";
            statusEl.textContent = "Processed " + completed + " of " + indices.length + " items before cancellation.";
        } else {
            titleEl.textContent = "Processing Complete";
            statusEl.textContent = "Finished processing " + completed + " items.";
        }

        this._log(logEl, "\nDone. " + this._llmResults.filter((r) => r.llmData).length + " succeeded, " + this._llmResults.filter((r) => r.error).length + " failed.");

        // Change cancel button to back/review buttons
        var cancelBtn = document.getElementById("btn-cancel-processing");
        cancelBtn.textContent = "Back to Results";
        cancelBtn.addEventListener("click", () => this._showStep("results"));

        // Add a Review button if we have results
        var hasResults = this._llmResults.some((r) => r.llmData && Object.keys(r.llmData).length > 0);

        if (hasResults) {
            var reviewBtn = this._htmlBtn("Review Changes", "mf-btn-primary", () => {
                try {
                    this._buildReviewUI();
                    this._showStep("review");
                } catch(e) {
                    this._log(logEl, "\nERROR building review UI: " + e + "\n" + (e.stack || ""));
                    this._logBuffer.push("REVIEW UI ERROR: " + e + "\n" + (e.stack || ""));
                }
            });
            cancelBtn.parentNode.appendChild(reviewBtn);

            // Also try auto-advance
            try {
                await new Promise((r) => setTimeout(r, 800));
                this._buildReviewUI();
                this._showStep("review");
            } catch(e) {
                this._log(logEl, "\nERROR auto-advancing to review: " + e + "\n" + (e.stack || ""));
                this._logBuffer.push("AUTO-ADVANCE ERROR: " + e + "\n" + (e.stack || ""));
                statusEl.textContent = "Finished processing. Click 'Review Changes' to see results.";
            }
        } else {
            statusEl.textContent += " No metadata could be extracted. Check the debug log (Help > Debug Output Logging > View Output) for the raw LLM response.";
        }
    },

    _log(el, msg) {
        el.textContent += msg + "\n";
        el.scrollTop = el.scrollHeight;
        this._logBuffer.push(msg);
    },

    _downloadLog() {
        try {
            var text = this._logBuffer.join("\n");
            var blob = new Blob([text], { type: "text/plain" });

            // Use Zotero's file picker to save
            var fp = Components.classes["@mozilla.org/filepicker;1"]
                .createInstance(Components.interfaces.nsIFilePicker);
            fp.init(window, "Save Processing Log", fp.modeSave);
            fp.defaultString = "metadata-filler-log.txt";
            fp.appendFilter("Text Files", "*.txt");
            fp.appendFilters(fp.filterAll);

            fp.open(function(result) {
                if (result === fp.returnOK || result === fp.returnReplace) {
                    var path = fp.file.path;
                    IOUtils.writeUTF8(path, text).then(function() {
                        Zotero.debug("[MetadataFiller] Log saved to " + path);
                    });
                }
            });
        } catch(e) {
            // Fallback: copy to clipboard
            try {
                var text2 = this._logBuffer.join("\n");
                var clipboard = Components.classes["@mozilla.org/widget/clipboardhelper;1"]
                    .getService(Components.interfaces.nsIClipboardHelper);
                clipboard.copyString(text2);
                window.alert("Log copied to clipboard (file save not available).");
            } catch(e2) {
                window.alert("Could not save log. Error: " + e + "\n\nFallback error: " + e2);
            }
        }
    },

    // ── Step 4: Review ────────────────────────────────────────

    _buildReviewUI() {
        const container = document.getElementById("review-container");
        container.innerHTML = "";

        // Only show results that have data
        const reviewable = this._llmResults.filter(
            (r) => r.llmData && Object.keys(r.llmData).length > 0
        );

        // Store reviewable BEFORE building cards (cards reference this)
        this._reviewableResults = reviewable;
        this._reviewDecisions = reviewable.map(() => "accepted"); // default: all accepted

        for (let i = 0; i < reviewable.length; i++) {
            const { scanResult, llmData } = reviewable[i];
            const card = this._buildReviewCard(i, scanResult, llmData);
            container.appendChild(card);
        }

        this._updateReviewSummary();

        // Also show errors
        const errors = this._llmResults.filter((r) => r.error);
        if (errors.length > 0) {
            const errSection = document.createElement("div");
            errSection.style.marginTop = "16px";
            var errTitle = document.createElement("strong");
            errTitle.style.color = "#dc2626";
            errTitle.textContent = "Errors (" + errors.length + " items):";
            errSection.appendChild(errTitle);
            for (var k = 0; k < errors.length; k++) {
                var errResult = errors[k];
                var errItemTitle = "";
                try { errItemTitle = errResult.scanResult.item.getField("title"); } catch(e) {}
                if (!errItemTitle) {
                    try { errItemTitle = errResult.scanResult.item.attachmentFilename; } catch(e) {}
                }
                errItemTitle = errItemTitle || "(untitled)";
                const p = document.createElement("div");
                p.className = "mf-review-error";
                p.textContent = "- " + errItemTitle + ": " + errResult.error;
                errSection.appendChild(p);
            }
            container.appendChild(errSection);
        }
    },

    _buildReviewCard(index, scanResult, llmData) {
        var reviewItem = this._reviewableResults[index];
        const card = document.createElement("div");
        card.className = "mf-review-card accepted";
        card.dataset.index = index;

        // Header
        const header = document.createElement("div");
        header.className = "mf-review-card-header";

        const title = document.createElement("span");
        title.className = "mf-review-card-title";
        var titleText = "";
        try { titleText = scanResult.item.getField("title"); } catch(e) {}
        if (!titleText && reviewItem.isOrphan) {
            try { titleText = scanResult.item.attachmentFilename || "(unnamed PDF)"; } catch(e) {}
        }
        title.textContent = titleText || "(untitled)";

        const typeBadge = document.createElement("span");
        typeBadge.className = "mf-review-card-type";

        if (reviewItem.isOrphan) {
            // Show the proposed item type for orphans
            var proposedType = reviewItem.orphanItemType || "document";
            var typeLabel = FieldMappings.types[proposedType]?.label || proposedType;
            typeBadge.textContent = "NEW: " + typeLabel;
            typeBadge.style.background = "#f3e8ff";
            typeBadge.style.color = "#6b21a8";
        } else {
            typeBadge.textContent = FieldMappings.types[scanResult.typeKey]?.label || scanResult.typeKey;
        }

        header.appendChild(title);
        header.appendChild(typeBadge);
        card.appendChild(header);

        // Fields
        const fieldsContainer = document.createElement("div");

        if (reviewItem.isOrphan) {
            // For orphans, show all proposed metadata keyed by the item type's field definitions
            var proposedType2 = reviewItem.orphanItemType || "document";
            var fieldDefs = FieldMappings.getFieldsForType(proposedType2);

            for (var f = 0; f < fieldDefs.length; f++) {
                var fieldDef = fieldDefs[f];
                var value = llmData[fieldDef.llmKey];
                if (value === undefined || value === null) continue;

                var row = document.createElement("div");
                row.className = "mf-review-field";

                var labelEl = document.createElement("span");
                labelEl.className = "mf-review-field-label";
                labelEl.textContent = fieldDef.label;

                var valueEl = document.createElement("span");
                valueEl.className = "mf-review-field-value";

                if (fieldDef.isCreator && Array.isArray(value)) {
                    valueEl.textContent = value
                        .map(function(c) { return ((c.firstName || "") + " " + (c.lastName || "")).trim(); })
                        .join("; ");
                } else {
                    valueEl.textContent = String(value);
                }

                row.appendChild(labelEl);
                row.appendChild(valueEl);
                fieldsContainer.appendChild(row);
            }
        } else {
            // Normal mode: show missing fields
            for (const fieldDef of scanResult.missingFields) {
                const value = llmData[fieldDef.llmKey];
                if (value === undefined || value === null) continue;

                const row = document.createElement("div");
                row.className = "mf-review-field";

                const labelEl = document.createElement("span");
                labelEl.className = "mf-review-field-label";
                labelEl.textContent = fieldDef.label;

                const valueEl = document.createElement("span");
                valueEl.className = "mf-review-field-value";

                if (fieldDef.isCreator && Array.isArray(value)) {
                    valueEl.textContent = value
                        .map((c) => `${c.firstName || ""} ${c.lastName || ""}`.trim())
                        .join("; ");
                } else {
                    valueEl.textContent = String(value);
                }

                row.appendChild(labelEl);
                row.appendChild(valueEl);
                fieldsContainer.appendChild(row);
            }
        }
        // Two-column body: fields left, PDF thumbnail right
        var bodyRow = document.createElement("div");
        bodyRow.style.cssText = "display:flex; gap:12px;";

        fieldsContainer.style.flex = "1";
        bodyRow.appendChild(fieldsContainer);

        // Try to add PDF thumbnail
        try {
            var pdfItem = reviewItem.isOrphan ? scanResult.item : null;
            if (!pdfItem) {
                // For regular items, get the PDF attachment
                var attIDs = scanResult.item.getAttachments();
                for (var ai = 0; ai < attIDs.length; ai++) {
                    var att = Zotero.Items.get(attIDs[ai]);
                    if (att && att.attachmentContentType === "application/pdf") {
                        pdfItem = att;
                        break;
                    }
                }
            }
            if (pdfItem) {
                var thumbDiv = document.createElement("div");
                thumbDiv.style.cssText = "width:140px; min-width:140px; text-align:center;";

                // Try to get cached page image from Zotero's storage
                var storageDir = Zotero.Attachments.getStorageDirectoryByID(pdfItem.id);
                if (storageDir) {
                    var cachePath = storageDir.path;
                    // Zotero stores page thumbnails in .zotero-ft-cache or generates them
                    // Try the file:// URL of the PDF itself as a fallback label
                    var thumbLabel = document.createElement("div");
                    thumbLabel.style.cssText = "font-size:10px; color:#888; margin-top:4px; word-break:break-all;";
                    thumbLabel.textContent = pdfItem.attachmentFilename || "PDF";

                    // Create a small colored preview box with first letter
                    var thumbBox = document.createElement("div");
                    var firstChar = (pdfItem.attachmentFilename || "P").charAt(0).toUpperCase();
                    thumbBox.style.cssText = "width:120px; height:160px; background:linear-gradient(135deg, #e0e7ff 0%, #c7d2fe 100%); border:1px solid #a5b4fc; border-radius:6px; display:flex; align-items:center; justify-content:center; font-size:36px; color:#4338ca; font-weight:700; margin:0 auto;";
                    thumbBox.textContent = firstChar;

                    thumbDiv.appendChild(thumbBox);
                    thumbDiv.appendChild(thumbLabel);
                    bodyRow.appendChild(thumbDiv);
                }
            }
        } catch(thumbErr) {
            // Thumbnail is best-effort, don't break the card
            Zotero.debug("[MetadataFiller] Thumbnail error: " + thumbErr);
        }

        card.appendChild(bodyRow);

        // Actions
        const actions = document.createElement("div");
        actions.className = "mf-review-actions";

        var self = this;
        var acceptBtn = this._htmlBtn("Accept", "mf-btn-accept", function() {
            self._setReviewDecision(index, "accepted");
        });
        var rejectBtn = this._htmlBtn("Reject", "mf-btn-reject", function() {
            self._setReviewDecision(index, "rejected");
        });

        actions.appendChild(acceptBtn);
        actions.appendChild(rejectBtn);
        card.appendChild(actions);

        return card;
    },

    _setReviewDecision(index, decision) {
        this._reviewDecisions[index] = decision;
        const card = document.querySelector(`.mf-review-card[data-index="${index}"]`);
        if (card) {
            card.classList.remove("accepted", "rejected");
            card.classList.add(decision);
        }
        this._updateReviewSummary();
    },

    _setAllReviewDecisions(decision) {
        for (let i = 0; i < this._reviewDecisions.length; i++) {
            this._setReviewDecision(i, decision);
        }
    },

    _updateReviewSummary() {
        const accepted = this._reviewDecisions.filter((d) => d === "accepted").length;
        const total = this._reviewDecisions.length;
        document.getElementById("review-summary").textContent =
            `${accepted} of ${total} changes accepted`;
        document.getElementById("btn-apply").disabled = accepted === 0;
    },

    // ── Step 5: Apply ─────────────────────────────────────────

    async _onApply() {
        const toApply = [];
        for (let i = 0; i < this._reviewDecisions.length; i++) {
            if (this._reviewDecisions[i] === "accepted") {
                toApply.push(this._reviewableResults[i]);
            }
        }

        if (toApply.length === 0) {
            this._setStatus("No changes to apply.");
            return;
        }

        this._setStatus("Applying changes...");
        document.getElementById("btn-apply").disabled = true;

        var applied = 0;
        var orphansCreated = 0;
        var errorDetails = [];

        for (var j = 0; j < toApply.length; j++) {
            var result = toApply[j];
            var itemTitle = "";
            try { itemTitle = result.scanResult.item.getField("title"); } catch(ex) {}
            if (!itemTitle) {
                try { itemTitle = result.scanResult.item.attachmentFilename; } catch(ex) {}
            }
            itemTitle = itemTitle || "(item " + j + ")";

            try {
                if (result.isOrphan) {
                    await this._applyOrphanChanges(result);
                    orphansCreated++;
                } else {
                    await this._applyChanges(result.scanResult, result.llmData);
                }
                applied++;
            } catch (e) {
                var errMsg = itemTitle + ": " + e + (e.stack ? "\n" + e.stack : "");
                errorDetails.push(errMsg);
                Zotero.debug("[MetadataFiller] Error applying: " + errMsg);
            }
        }

        var summaryParts = [];
        if (applied - orphansCreated > 0) {
            summaryParts.push("Updated " + (applied - orphansCreated) + " existing item(s).");
        }
        if (orphansCreated > 0) {
            summaryParts.push("Created " + orphansCreated + " new parent item(s) for standalone PDFs.");
        }
        if (errorDetails.length > 0) {
            summaryParts.push(errorDetails.length + " error(s):");
        }
        document.getElementById("done-summary").textContent = summaryParts.join(" ");

        if (errorDetails.length > 0) {
            var parent = document.getElementById("done-summary").parentNode;
            var errPre = document.createElementNS("http://www.w3.org/1999/xhtml", "pre");
            errPre.style.cssText = "color:#dc2626; font-size:11px; white-space:pre-wrap; max-height:200px; overflow-y:auto; margin-top:10px; padding:8px; border:1px solid #fca5a5; border-radius:4px; background:#fef2f2; text-align:left;";
            errPre.textContent = errorDetails.join("\n\n");
            parent.appendChild(errPre);
        }

        this._showStep("done");
    },

    /**
     * Apply LLM-extracted metadata to a Zotero item (normal mode).
     */
    async _applyChanges(scanResult, llmData) {
        const item = scanResult.item;

        for (const fieldDef of scanResult.missingFields) {
            const value = llmData[fieldDef.llmKey];
            if (value === undefined || value === null) continue;

            if (fieldDef.isCreator && Array.isArray(value)) {
                const creatorTypeID = Zotero.CreatorTypes.getID(fieldDef.creatorType);
                const existingCreators = item.getCreators();
                const newCreators = [...existingCreators];

                for (const c of value) {
                    newCreators.push({
                        firstName: c.firstName || "",
                        lastName: c.lastName || "",
                        creatorTypeID,
                    });
                }
                item.setCreators(newCreators);
            } else {
                try {
                    item.setField(fieldDef.zotero, String(value));
                } catch (e) {
                    Zotero.debug("[MetadataFiller] Could not set field " + fieldDef.zotero + ": " + e.message);
                }
            }
        }

        await item.saveTx();
    },

    /**
     * Apply orphan PDF changes: create a new parent item, set metadata, reparent the PDF.
     */
    async _applyOrphanChanges(result) {
        var scanResult = result.scanResult;
        var llmData = result.llmData;
        var itemType = result.orphanItemType || "document";
        var pdfAttachment = scanResult.item;

        // Create the new parent item
        var itemTypeID = Zotero.ItemTypes.getID(itemType);
        if (!itemTypeID) {
            Zotero.debug("[MetadataFiller] Unknown item type: " + itemType + ", falling back to document");
            itemTypeID = Zotero.ItemTypes.getID("document");
        }

        var newItem = new Zotero.Item();
        newItem.libraryID = pdfAttachment.libraryID;
        newItem.setType(itemTypeID);

        // Set all the metadata fields
        var fieldDefs = FieldMappings.getFieldsForType(itemType);
        var creators = [];

        for (var f = 0; f < fieldDefs.length; f++) {
            var fieldDef = fieldDefs[f];
            var value = llmData[fieldDef.llmKey];
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
                try {
                    newItem.setField(fieldDef.zotero, String(value));
                } catch (e) {
                    Zotero.debug("[MetadataFiller] Could not set field " + fieldDef.zotero + " on new item: " + e.message);
                }
            }
        }

        if (creators.length > 0) {
            newItem.setCreators(creators);
        }

        // Save the new parent item
        await newItem.saveTx();

        // Reparent the PDF attachment to the new item
        pdfAttachment.parentItemID = newItem.id;
        await pdfAttachment.saveTx();

        Zotero.debug("[MetadataFiller] Created parent item " + newItem.id + " (type: " + itemType + ") for orphan PDF " + pdfAttachment.id);
    },

    // ── Start over ────────────────────────────────────────────

    _onStartOver() {
        this._scanResults = [];
        this._selectedForProcessing = new Set();
        this._llmResults = [];
        this._logBuffer = [];
        this._reviewDecisions = [];
        this._reviewableResults = [];
        this._setStatus("");
        this._showStep("configure");
    },
};
