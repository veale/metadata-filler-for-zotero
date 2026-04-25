/* global Zotero */
"use strict";

/**
 * LLMClient: Sends PDF content (text + image) to various LLM providers
 * and parses structured JSON responses with the missing metadata.
 */
var LLMClient = {

    // ── Provider configurations ───────────────────────────────
    providers: {
        openai: {
            label: "OpenAI",
            defaultModel: "gpt-4o",
            endpoint: "https://api.openai.com/v1/chat/completions",
        },
        anthropic: {
            label: "Anthropic",
            defaultModel: "claude-sonnet-4-20250514",
            endpoint: "https://api.anthropic.com/v1/messages",
        },
        google: {
            label: "Google Gemini",
            defaultModel: "gemini-2.0-flash",
            endpointTemplate: "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
        },
        custom: {
            label: "OpenAI-Compatible",
            defaultModel: "gpt-4o",
            endpoint: "",  // set by user
        },
        apple: {
            label: "Apple Intelligence (on-device, macOS 26+)",
            defaultModel: "apple-foundation",
            endpoint: null,  // not HTTP — uses a local helper subprocess
            macOnly: true,
        },
    },

    // ── Retry / backoff ───────────────────────────────────────
    //
    // Retries 429 (rate limit) and 5xx (transient server) responses with
    // exponential backoff and jitter. Honours Retry-After when present.
    // Network errors (fetch throwing) are also retried. Other 4xx errors
    // are NOT retried — they're config issues that won't fix themselves.

    async _fetchWithRetry(url, init, opts) {
        opts = opts || {};
        var maxAttempts = opts.maxAttempts || 3;
        var baseDelayMs = opts.baseDelayMs || 800;

        for (var attempt = 1; ; attempt++) {
            try {
                var response = await fetch(url, init);
                if (response.status !== 429 && response.status < 500) return response;
                if (attempt >= maxAttempts) return response;

                var retryAfterMs = this._parseRetryAfter(response.headers && response.headers.get && response.headers.get("Retry-After"));
                var delay = retryAfterMs !== null
                    ? retryAfterMs
                    : Math.round(baseDelayMs * Math.pow(2, attempt - 1) * (0.5 + Math.random()));
                Zotero.debug("[MetadataFiller] Got " + response.status + ", retrying in " + delay + "ms (attempt " + attempt + "/" + maxAttempts + ")");
                await new Promise(function(r) { setTimeout(r, delay); });
            } catch (e) {
                if (attempt >= maxAttempts) throw e;
                var backoff = Math.round(baseDelayMs * Math.pow(2, attempt - 1) * (0.5 + Math.random()));
                Zotero.debug("[MetadataFiller] Network error, retrying in " + backoff + "ms: " + e.message);
                await new Promise(function(r) { setTimeout(r, backoff); });
            }
        }
    },

    _parseRetryAfter(header) {
        if (!header) return null;
        var n = parseInt(header, 10);
        if (!isNaN(n)) return n * 1000;
        var date = Date.parse(header);
        if (isNaN(date)) return null;
        return Math.max(0, date - Date.now());
    },

    // ── Advanced overrides ────────────────────────────────────
    //
    // Users can override the JSON request body sent to any provider via the
    // "Advanced" panel in the dialog. This makes the plugin future-proof when
    // providers change their parameter names (e.g. max_tokens →
    // max_completion_tokens) or add new required fields. Overrides are stored
    // per-provider as a JSON string in
    //   extensions.metadata-filler.<provider>.bodyOverrides
    // Set a key to `null` to remove it from the request.
    //
    // The system prompt can also be overridden via
    //   extensions.metadata-filler.systemPromptTemplate
    // with placeholders {fieldList} and {itemTypeLabel}.

    _getBodyOverrides(provider) {
        try {
            var raw = Zotero.Prefs.get("extensions.metadata-filler." + provider + ".bodyOverrides");
            if (!raw || !String(raw).trim()) return null;
            return JSON.parse(raw);
        } catch (e) {
            Zotero.debug("[MetadataFiller] Invalid JSON in " + provider + " body overrides: " + e.message);
            return null;
        }
    },

    _applyBodyOverrides(body, provider) {
        var overrides = this._getBodyOverrides(provider);
        if (!overrides || typeof overrides !== "object") return body;
        for (var k in overrides) {
            if (!Object.prototype.hasOwnProperty.call(overrides, k)) continue;
            var v = overrides[k];
            if (v === null) {
                delete body[k];
            } else if (
                v && typeof v === "object" && !Array.isArray(v)
                && body[k] && typeof body[k] === "object" && !Array.isArray(body[k])
            ) {
                body[k] = Object.assign({}, body[k], v);
            } else {
                body[k] = v;
            }
        }
        return body;
    },

    // ── Main entry point ──────────────────────────────────────

    /**
     * Query an LLM to fill missing metadata from PDF content.
     *
     * @param {Object}   opts
     * @param {string}   opts.text           – Extracted text from PDF pages
     * @param {string|null} opts.imageBase64 – Base64 PNG of the page images (or null)
     * @param {Array}    opts.missingFields  – Array of fieldDef objects to fill
     * @param {string}   opts.itemTypeLabel  – Human-readable item type ("Journal Article", etc.)
     * @param {string}   opts.provider       – "openai" | "anthropic" | "google"
     * @param {string}   opts.apiKey
     * @param {string}   opts.model          – Model name to use
     * @param {number}   opts.maxTokens      – Max response tokens
     *
     * @returns {Promise<Object>} – Parsed JSON with llmKey → value pairs
     */
    async query(opts) {
        const { provider, apiKey, model, text, imageBase64, missingFields, itemTypeLabel, maxTokens } = opts;

        // Apple's on-device provider has no API key — auth is "the user is
        // logged in to a Mac with Apple Intelligence enabled".
        if (!apiKey && provider !== "apple") throw new Error(`No API key configured for ${provider}`);

        const systemPrompt = this._buildSystemPrompt(missingFields, itemTypeLabel);
        const userContent = this._buildUserContent(text, imageBase64, missingFields, opts.embedded);

        let raw;
        switch (provider) {
            case "openai":
                raw = await this._callOpenAI(apiKey, model, systemPrompt, userContent, maxTokens);
                break;
            case "custom":
                raw = await this._callCustom(apiKey, model, systemPrompt, userContent, maxTokens);
                break;
            case "anthropic":
                raw = await this._callAnthropic(apiKey, model, systemPrompt, userContent, maxTokens);
                break;
            case "google":
                raw = await this._callGoogle(apiKey, model, systemPrompt, userContent, maxTokens);
                break;
            case "apple":
                raw = await this._callApple(model, systemPrompt, userContent, maxTokens);
                break;
            default:
                throw new Error("Unknown provider: " + provider);
        }

        this._lastRawResponse = raw;
        // Persist the most recent raw response so the user can inspect it
        // from the dialog's "Show last raw response" button even if their
        // current session log has scrolled past.
        try { Zotero.Prefs.set("extensions.metadata-filler.lastRawResponse", String(raw || "").slice(0, 16384)); } catch(e) {}
        return this._parseResponse(raw, missingFields);
    },

    // ── Prompt construction ───────────────────────────────────

    DEFAULT_SYSTEM_PROMPT:
`You are a metadata extraction assistant for academic and research documents.
You are given the first two pages of a PDF document (as text and/or an image).
The document is a {itemTypeLabel}.

Your task: extract ONLY the following missing metadata fields, if they can be determined from the provided content:

{fieldList}

Rules:
1. Return ONLY a valid JSON object with the keys listed above.
2. Only include a key if you can confidently determine its value from the document.
3. If you cannot determine a field, OMIT the key entirely (do not set it to null or empty string).
4. For author/creator fields, return an array of objects with "firstName" and "lastName" keys.
   Example: [{"firstName": "Jane", "lastName": "Doe"}, {"firstName": "John", "lastName": "Smith"}]
5. For dates, use the format YYYY-MM-DD (or YYYY if only year is known).
6. Do not guess or hallucinate. Only return information that is clearly present in the document.
7. Do NOT include any explanation, commentary, or markdown formatting. Return ONLY the JSON object.`,

    _buildSystemPrompt(missingFields, itemTypeLabel) {
        var fieldList = missingFields
            .map(function(f) { return '  - "' + f.llmKey + '": ' + f.label; })
            .join("\n");

        var template = "";
        try {
            template = Zotero.Prefs.get("extensions.metadata-filler.systemPromptTemplate") || "";
        } catch (e) {}
        if (!template || !template.trim()) template = this.DEFAULT_SYSTEM_PROMPT;

        return template
            .replace(/\{fieldList\}/g, fieldList)
            .replace(/\{itemTypeLabel\}/g, itemTypeLabel || "document");
    },

    _buildUserContent(text, imageBase64, missingFields, embedded) {
        const fieldNames = missingFields.map((f) => f.llmKey).join(", ");
        const parts = [];

        if (imageBase64) {
            parts.push({
                type: "image",
                base64: imageBase64,
                mediaType: "image/png",
            });
        }

        var embeddedBlock = "";
        if (embedded && typeof embedded === "object" && Object.keys(embedded).length) {
            var lines = [];
            for (var k in embedded) {
                if (embedded[k]) lines.push("  " + k + ": " + String(embedded[k]).slice(0, 300));
            }
            if (lines.length) {
                embeddedBlock = "\n\nEmbedded PDF metadata (treat as a hint — verify against the page content; ignore if obviously wrong, e.g. the PDF Author field is the software vendor):\n" + lines.join("\n");
            }
        }

        parts.push({
            type: "text",
            text: "Here is the extracted text from the first pages of the document:\n\n"
                + text
                + embeddedBlock
                + "\n\nPlease extract the following missing metadata fields as JSON: "
                + fieldNames,
        });

        return parts;
    },

    // ── Provider-specific API calls ───────────────────────────

    /**
     * Detects OpenAI models that use the newer Chat Completions parameter set
     * (max_completion_tokens instead of max_tokens). Covers o-series
     * reasoning models and the GPT-5 family (incl. gpt-5.4, gpt-5-mini, etc.).
     */
    _isNewOpenAIModel(model) {
        var m = String(model || "").toLowerCase();
        return /^o\d/.test(m)
            || /^gpt-5/.test(m)
            || /^gpt-6/.test(m)
            || /^chatgpt-5/.test(m)
            || /^chatgpt-6/.test(m);
    },

    /**
     * Reasoning / GPT-5 models on OpenAI do not accept custom temperature
     * values — they only support the default. Omit temperature for them.
     */
    _openAISupportsTemperature(model) {
        var m = String(model || "").toLowerCase();
        if (/^o\d/.test(m)) return false;
        if (/^gpt-5/.test(m) || /^gpt-6/.test(m)) return false;
        if (/^chatgpt-5/.test(m) || /^chatgpt-6/.test(m)) return false;
        return true;
    },

    _buildOpenAIMessages(systemPrompt, userContent, model) {
        // o-series reasoning models prefer "developer" over "system" role.
        var systemRole = /^o\d/.test(String(model || "").toLowerCase()) ? "developer" : "system";
        return [
            { role: systemRole, content: systemPrompt },
            {
                role: "user",
                content: userContent.map(function(part) {
                    if (part.type === "image") {
                        return {
                            type: "image_url",
                            image_url: {
                                url: "data:" + part.mediaType + ";base64," + part.base64,
                                detail: "high",
                            },
                        };
                    }
                    return { type: "text", text: part.text };
                }),
            },
        ];
    },

    _buildOpenAIBody(model, messages, maxTokens) {
        var body = { model: model, messages: messages };
        if (this._isNewOpenAIModel(model)) {
            body.max_completion_tokens = maxTokens;
        } else {
            body.max_tokens = maxTokens;
        }
        if (this._openAISupportsTemperature(model)) {
            body.temperature = 0.1;
        }
        body.response_format = { type: "json_object" };
        return body;
    },

    async _callOpenAI(apiKey, model, systemPrompt, userContent, maxTokens) {
        var messages = this._buildOpenAIMessages(systemPrompt, userContent, model);
        var body = this._buildOpenAIBody(model, messages, maxTokens);
        body = this._applyBodyOverrides(body, "openai");

        var self = this;
        var doFetch = function(b) {
            return self._fetchWithRetry(LLMClient.providers.openai.endpoint, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: "Bearer " + apiKey,
                },
                body: JSON.stringify(b),
            });
        };

        var response = await doFetch(body);

        // Auto-recover from parameter mismatch errors. OpenAI's required
        // params shift over time; rather than gate by a fixed model list,
        // react to the actual error messages so future models keep working.
        if (!response.ok && response.status === 400) {
            var errText = await response.text();
            var retried = false;

            if (/max_tokens.*not supported|use ['"]?max_completion_tokens/i.test(errText)
                && body.max_tokens !== undefined) {
                body.max_completion_tokens = body.max_tokens;
                delete body.max_tokens;
                retried = true;
            }
            if (/max_completion_tokens.*(unsupported|not supported|unknown|unrecognized)/i.test(errText)
                && body.max_completion_tokens !== undefined) {
                body.max_tokens = body.max_completion_tokens;
                delete body.max_completion_tokens;
                retried = true;
            }
            if (/temperature.*(unsupported|does not support|only the default)/i.test(errText)) {
                delete body.temperature;
                retried = true;
            }
            if (/response_format.*(unsupported|not supported)/i.test(errText)) {
                delete body.response_format;
                retried = true;
            }

            if (retried) {
                response = await doFetch(body);
            } else {
                throw new Error("OpenAI API error (" + response.status + "): " + errText);
            }
        }

        if (!response.ok) {
            var err = await response.text();
            throw new Error("OpenAI API error (" + response.status + "): " + err);
        }

        var data = await response.json();
        return data.choices?.[0]?.message?.content || "{}";
    },

    async _callCustom(apiKey, model, systemPrompt, userContent, maxTokens) {
        var endpoint = Zotero.Prefs.get("extensions.metadata-filler.custom.endpoint") || "";
        if (!endpoint) {
            throw new Error("No custom endpoint URL configured. Set it in the AI Provider section.");
        }

        const messages = [
            { role: "system", content: systemPrompt },
            {
                role: "user",
                content: userContent.map((part) => {
                    if (part.type === "image") {
                        return {
                            type: "image_url",
                            image_url: {
                                url: "data:" + part.mediaType + ";base64," + part.base64,
                                detail: "high",
                            },
                        };
                    }
                    return { type: "text", text: part.text };
                }),
            },
        ];

        var body = {
            model: model,
            messages: messages,
            max_tokens: maxTokens,
            temperature: 0.1,
        };

        // Try to request JSON mode (not all endpoints support this)
        try {
            body.response_format = { type: "json_object" };
        } catch(e) {}

        body = this._applyBodyOverrides(body, "custom");

        const response = await this._fetchWithRetry(endpoint, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": "Bearer " + apiKey,
            },
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const err = await response.text();
            throw new Error("Custom endpoint error (" + response.status + "): " + err);
        }

        const data = await response.json();
        return data.choices?.[0]?.message?.content || "{}";
    },

    async _callAnthropic(apiKey, model, systemPrompt, userContent, maxTokens) {
        const contentBlocks = userContent.map((part) => {
            if (part.type === "image") {
                return {
                    type: "image",
                    source: {
                        type: "base64",
                        media_type: part.mediaType,
                        data: part.base64,
                    },
                };
            }
            return { type: "text", text: part.text };
        });

        var anthropicBody = {
            model: model,
            max_tokens: maxTokens,
            system: systemPrompt,
            messages: [{ role: "user", content: contentBlocks }],
            temperature: 0.1,
        };
        anthropicBody = this._applyBodyOverrides(anthropicBody, "anthropic");

        const response = await this._fetchWithRetry(this.providers.anthropic.endpoint, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-api-key": apiKey,
                "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify(anthropicBody),
        });

        if (!response.ok) {
            const err = await response.text();
            throw new Error(`Anthropic API error (${response.status}): ${err}`);
        }

        const data = await response.json();
        const textBlock = data.content?.find((b) => b.type === "text");
        return textBlock?.text || "{}";
    },

    async _callGoogle(apiKey, model, systemPrompt, userContent, maxTokens) {
        const endpoint = this.providers.google.endpointTemplate.replace("{model}", model);

        const parts = [];

        // System instruction as a text part at the beginning
        parts.push({ text: systemPrompt });

        for (const item of userContent) {
            if (item.type === "image") {
                parts.push({
                    inlineData: {
                        mimeType: item.mediaType,
                        data: item.base64,
                    },
                });
            } else {
                parts.push({ text: item.text });
            }
        }

        var googleBody = {
            contents: [{ parts: parts }],
            generationConfig: {
                maxOutputTokens: maxTokens,
                temperature: 0.1,
                responseMimeType: "application/json",
            },
        };
        googleBody = this._applyBodyOverrides(googleBody, "google");

        const response = await this._fetchWithRetry(`${endpoint}?key=${apiKey}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(googleBody),
        });

        if (!response.ok) {
            const err = await response.text();
            throw new Error(`Google API error (${response.status}): ${err}`);
        }

        const data = await response.json();
        const textPart = data.candidates?.[0]?.content?.parts?.find((p) => p.text);
        return textPart?.text || "{}";
    },

    // ── Apple Intelligence (on-device, via Swift helper) ──────
    //
    // The helper is a Swift binary that wraps Apple's FoundationModels
    // framework. Communication is one-shot subprocess: we write the prompt
    // to a temp JSON file, run the helper with [inFile, outFile], read the
    // result back, delete both. The helper itself is text-in / text-out;
    // the existing _parseResponse / _parseOrphanResponse handle the JSON.
    //
    // Image parts are stripped (the on-device model is text-only as of
    // macOS 26). The system prompt becomes the session's `instructions:`
    // and the joined text parts become the per-call `prompt:`.
    //
    // Helper input file shape:
    //   { instructions: string, prompt: string, temperature: number, maxTokens: number }
    //
    // Helper output file shape (success):
    //   { text: string }
    // Helper output file shape (failure):
    //   { error: string, code?: string }
    //
    // The helper exits non-zero on any failure. Stderr is captured and
    // stuffed into the thrown error message so the user can see *why* it
    // failed in the dialog log + the lastRawResponse pref.

    async _callApple(model, systemPrompt, userContent, maxTokens) {
        if (!Zotero.isMac) {
            throw new Error("Apple Intelligence is only available on macOS. Pick a different provider in the dialog.");
        }

        var resolution = await this._resolveAppleHelperPathDetailed();
        if (!resolution.path) {
            throw new Error(this._buildAppleHelperMissingMessage(resolution));
        }
        var helperPath = resolution.path;

        // Strip image parts — the on-device model is text-only.
        var hadImages = false;
        var promptText = userContent.map(function(part) {
            if (part.type === "image") { hadImages = true; return null; }
            return part.text;
        }).filter(Boolean).join("\n\n");
        if (hadImages) {
            Zotero.debug("[MetadataFiller] Apple provider: dropping image parts (on-device model is text-only)");
        }

        // Allow advanced overrides for temperature etc. via the same
        // bodyOverrides mechanism the HTTP providers use.
        var helperPayload = {
            model: model,
            instructions: systemPrompt,
            prompt: promptText,
            temperature: 0.1,
            maxTokens: maxTokens,
        };
        helperPayload = this._applyBodyOverrides(helperPayload, "apple");

        // Write input, run, read output, clean up. We use a fresh temp
        // filename per call so concurrent processing doesn't collide.
        var stamp = Date.now() + "-" + Math.random().toString(36).slice(2, 10);
        var tmpDir = Zotero.getTempDirectory().path;
        var inPath = PathUtils.join(tmpDir, "mf-apple-in-" + stamp + ".json");
        var outPath = PathUtils.join(tmpDir, "mf-apple-out-" + stamp + ".json");

        await IOUtils.writeUTF8(inPath, JSON.stringify(helperPayload));

        var exitCode;
        try {
            exitCode = await this._runAppleHelper(helperPath, [inPath, outPath]);
        } catch (e) {
            try { await IOUtils.remove(inPath); } catch (x) {}
            throw new Error("Apple helper failed to launch: " + (e && e.message ? e.message : e));
        }

        var outputText = "";
        var outputJSON = null;
        if (await IOUtils.exists(outPath)) {
            outputText = await IOUtils.readUTF8(outPath);
            try { outputJSON = JSON.parse(outputText); } catch (e) {}
        }

        try { await IOUtils.remove(inPath); } catch (e) {}
        try { await IOUtils.remove(outPath); } catch (e) {}

        if (exitCode !== 0) {
            // The helper writes structured errors with a stable `code` so we
            // can give actionable guidance for the common failure modes.
            var code = outputJSON && outputJSON.code ? outputJSON.code : "";
            var detail = outputJSON && outputJSON.error
                ? outputJSON.error
                : (outputText ? outputText.slice(0, 400) : "(no output)");

            var hint = "";
            if (code === "model-unavailable") {
                hint = "\n\nTo fix:\n"
                    + "  • Open System Settings → Apple Intelligence & Siri.\n"
                    + "  • Turn on Apple Intelligence and let the model finish downloading (can be several GB on first enable).\n"
                    + "  • Confirm your Mac is Apple Silicon and on macOS 26 (Tahoe) or later.";
            } else if (code === "guardrail") {
                hint = "\n\nApple's on-device safety filter blocked this content. Try a different item, or strip headers/footers from the PDF text. Other providers (OpenAI/Anthropic/Google) may handle it.";
            } else if (code === "context-window") {
                hint = "\n\nThe on-device model has a ~4K-token total budget (input + output). Reduce 'Pages to read — short doc' to 1, or trim the prompt via the Advanced panel. Switching providers also bypasses this.";
            } else if (code === "generation-failed") {
                hint = "\n\nGeneration failed inside FoundationModels. Check Console.app for IntelligencePlatformComputeService logs.";
            } else if (exitCode === 126 || exitCode === 127 || /not permitted|exec format error/i.test(detail)) {
                hint = "\n\nThe binary couldn't be executed. Most likely cause: macOS quarantine. Run:\n"
                    + "  xattr -d com.apple.quarantine \"" + helperPath + "\"\n"
                    + "  chmod +x \"" + helperPath + "\"\n"
                    + "Or click \"Build helper now\" in the dialog to rebuild it locally.";
            }

            throw new Error("Apple helper exited with code " + exitCode + ": " + detail + hint);
        }
        if (!outputJSON || typeof outputJSON.text !== "string") {
            throw new Error("Apple helper did not return a 'text' field. Raw output: " + outputText.slice(0, 400));
        }
        return outputJSON.text;
    },

    /**
     * Resolve the path to the fm-helper binary. Priority order:
     *   1. extensions.metadata-filler.apple.helperPath  (user-configured)
     *   2. <Zotero data dir>/fm-helper                   (recommended drop location, also where auto-install + Build-helper-now writes)
     *   3. <addon root>/bin/fm-helper                    (bundled — only present
     *      when CI built it for the release, or user ran scripts/build.sh with MF_BUILD_HELPER=1)
     */
    async _resolveAppleHelperPath() {
        var r = await this._resolveAppleHelperPathDetailed();
        return r.path;
    },

    /**
     * Same as _resolveAppleHelperPath but also returns the candidate list
     * for use in error messages — knowing exactly *where* we looked is the
     * single most useful piece of information when the helper isn't found.
     */
    async _resolveAppleHelperPathDetailed() {
        var candidates = [];
        try {
            var configured = Zotero.Prefs.get("extensions.metadata-filler.apple.helperPath");
            if (configured && String(configured).trim()) {
                candidates.push({ source: "pref (apple.helperPath)", path: String(configured).trim() });
            }
        } catch (e) {}
        try {
            candidates.push({ source: "Zotero data dir", path: PathUtils.join(Zotero.DataDirectory.dir, "fm-helper") });
        } catch (e) {}
        try {
            if (this._addonRootPath) {
                candidates.push({ source: "addon bundled", path: PathUtils.join(this._addonRootPath, "bin", "fm-helper") });
            }
        } catch (e) {}

        var checked = [];
        for (var i = 0; i < candidates.length; i++) {
            var exists = false;
            try { exists = await IOUtils.exists(candidates[i].path); } catch (e) {}
            checked.push({ source: candidates[i].source, path: candidates[i].path, exists: exists });
            if (exists) {
                return { path: candidates[i].path, source: candidates[i].source, checked: checked };
            }
        }
        return { path: null, checked: checked };
    },

    /**
     * A multi-line, copy-pasteable instruction block telling the user
     * exactly what to do when fm-helper can't be found. Shown in the
     * dialog's status area and on the "Test" button output.
     */
    _buildAppleHelperMissingMessage(resolution) {
        var dataDir = "<Zotero data dir>";
        try { dataDir = Zotero.DataDirectory.dir; } catch (e) {}

        var addonRoot = this._addonRootPath || "<addon root>";
        var helperSrc = addonRoot + "/fm-helper";
        var dest = dataDir + "/fm-helper";

        var checkedLines = (resolution.checked || []).map(function(c) {
            return "    • " + c.source + ":  " + c.path + "  →  " + (c.exists ? "✓ found" : "✗ missing");
        }).join("\n");

        return [
            "Apple Intelligence helper binary (fm-helper) not found.",
            "",
            "Locations checked:",
            checkedLines || "    (none)",
            "",
            "Easiest fix — click the \"Build helper now\" button in the dialog (Apple Silicon Mac with Xcode CLI tools required).",
            "",
            "Manual fix:",
            "  1. Install Xcode CLI tools (one-time, ~3 GB):",
            "       xcode-select --install",
            "  2. Build the helper from the source bundled inside this plugin:",
            "       cd \"" + helperSrc + "\"",
            "       swift build -c release --arch arm64",
            "  3. Copy + ad-hoc sign + make executable:",
            "       cp .build/arm64-apple-macosx/release/fm-helper \"" + dest + "\"",
            "       codesign --sign - --force --timestamp=none \"" + dest + "\"",
            "       chmod +x \"" + dest + "\"",
            "  4. (Optional) strip quarantine if you copied it from a download:",
            "       xattr -d com.apple.quarantine \"" + dest + "\" 2>/dev/null || true",
            "",
            "Requirements: Apple Silicon Mac, macOS 26+, Apple Intelligence enabled in System Settings.",
        ].join("\n");
    },

    /**
     * One-click "Build helper now" — compiles fm-helper/ from the source
     * shipped inside the addon, ad-hoc signs, copies to <data dir>/fm-helper.
     *
     * Reports progress via the onProgress callback (one line per phase).
     * Returns the destination path on success, throws on any failure with
     * a message the user can act on.
     */
    async buildAppleHelper(onProgress) {
        var report = onProgress || function() {};
        if (!Zotero.isMac) throw new Error("Apple Intelligence is only available on macOS.");

        // Prefer the extracted source dir (works for both packed and unpacked
        // .xpi installs — bootstrap copies the source files to the data dir
        // on every startup). Fall back to the unpacked-addon path if for
        // some reason the extraction step didn't run.
        var srcDir = null;
        if (this._fmHelperSrcDir && await IOUtils.exists(PathUtils.join(this._fmHelperSrcDir, "Package.swift"))) {
            srcDir = this._fmHelperSrcDir;
        } else if (this._addonRootPath) {
            var unpacked = PathUtils.join(this._addonRootPath, "fm-helper");
            if (await IOUtils.exists(PathUtils.join(unpacked, "Package.swift"))) {
                srcDir = unpacked;
            }
        }

        if (!srcDir) {
            throw new Error(
                "Could not locate fm-helper source files. The plugin tries to extract them on startup\n"
                + "to <Zotero data dir>/metadata-filler-fm-helper-src/ — this can fail if the .xpi was\n"
                + "built without the helper source.\n\n"
                + "Fix:\n"
                + "  1. Make sure you installed metadata-filler v1.3.0 or later.\n"
                + "  2. Restart Zotero (so the startup extraction runs again).\n"
                + "  3. If still failing, clone the repo and run from Terminal:\n"
                + "       git clone https://github.com/veale/metadata-filler-for-zotero.git\n"
                + "       cd metadata-filler-for-zotero/fm-helper\n"
                + "       swift build -c release --arch arm64\n"
                + "       cp .build/arm64-apple-macosx/release/fm-helper \"" + Zotero.DataDirectory.dir + "/fm-helper\"\n"
                + "       codesign --sign - --force --timestamp=none \"" + Zotero.DataDirectory.dir + "/fm-helper\"\n"
                + "       chmod +x \"" + Zotero.DataDirectory.dir + "/fm-helper\""
            );
        }

        // 1. Detect Xcode CLI tools. If absent, the user gets prompted to
        // install them — that's a separate workflow; bail with instructions.
        report("Checking for Xcode command-line tools…");
        var xcodeOK = false;
        try {
            var xs = await Zotero.Utilities.Internal.exec("/usr/bin/xcode-select", ["-p"]);
            xcodeOK = (xs === 0);
        } catch (e) {}
        if (!xcodeOK) {
            throw new Error(
                "Xcode command-line tools not detected. Install them first:\n\n"
                + "  xcode-select --install\n\n"
                + "macOS will pop up an installer (one-time, ~3 GB). Re-run \"Build helper now\" once it finishes."
            );
        }

        // 2. swift build. We capture exit code only; logs go to Zotero.debug.
        report("Compiling Swift helper (this takes ~30-60 seconds the first time)…");
        var swiftPath = await this._whichBinary("swift") || "/usr/bin/swift";
        var buildExit;
        try {
            // We'd prefer cwd control here, but Zotero.Utilities.Internal.exec
            // doesn't expose cwd. Use `swift build --package-path <dir>` instead,
            // which avoids the cwd issue entirely.
            buildExit = await Zotero.Utilities.Internal.exec(swiftPath, [
                "build",
                "--package-path", srcDir,
                "-c", "release",
                "--arch", "arm64",
            ]);
        } catch (e) {
            throw new Error("Failed to launch swift: " + (e && e.message ? e.message : e));
        }
        if (buildExit !== 0) {
            throw new Error(
                "swift build exited with code " + buildExit + ".\n\n"
                + "Common causes:\n"
                + "  • macOS 26 SDK not installed (FoundationModels requires it). Update to macOS 26 / Tahoe and update Xcode.\n"
                + "  • Apple Silicon required (the helper builds for arm64 only).\n\n"
                + "For full build output, run from Terminal:\n"
                + "  cd \"" + srcDir + "\" && swift build -c release --arch arm64"
            );
        }

        var built = PathUtils.join(srcDir, ".build", "arm64-apple-macosx", "release", "fm-helper");
        if (!(await IOUtils.exists(built))) {
            throw new Error("swift build reported success but the binary wasn't found at:\n  " + built);
        }

        // 3. Copy to the canonical destination.
        report("Copying helper to Zotero data directory…");
        var dest = PathUtils.join(Zotero.DataDirectory.dir, "fm-helper");
        var data = await IOUtils.read(built);
        await IOUtils.write(dest, data);

        // 4. Ad-hoc sign + chmod +x. Best-effort; don't fail the build if these flake.
        report("Ad-hoc signing and marking executable…");
        try { await Zotero.Utilities.Internal.exec("/usr/bin/codesign", ["--sign", "-", "--force", "--timestamp=none", dest]); } catch (e) {}
        try { await Zotero.Utilities.Internal.exec("/bin/chmod", ["+x", dest]); } catch (e) {}
        try { await Zotero.Utilities.Internal.exec("/usr/bin/xattr", ["-d", "com.apple.quarantine", dest]); } catch (e) {}

        report("✓ Helper built and installed at: " + dest);
        return dest;
    },

    async _whichBinary(name) {
        // Best-effort `which` via /usr/bin/env; returns absolute path or null.
        try {
            var path = "/usr/bin/" + name;
            if (await IOUtils.exists(path)) return path;
        } catch (e) {}
        try {
            var path2 = "/opt/homebrew/bin/" + name;
            if (await IOUtils.exists(path2)) return path2;
        } catch (e) {}
        return null;
    },

    async _runAppleHelper(helperPath, args) {
        // Prefer Zotero.Utilities.Internal.exec when available — it returns
        // a promise that resolves to the exit code. Fall back to nsIProcess
        // wrapped in a promise for older Zotero builds.
        if (Zotero.Utilities.Internal && typeof Zotero.Utilities.Internal.exec === "function") {
            return await Zotero.Utilities.Internal.exec(helperPath, args);
        }
        return await new Promise(function(resolve, reject) {
            try {
                var file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
                file.initWithPath(helperPath);
                var proc = Cc["@mozilla.org/process/util;1"].createInstance(Ci.nsIProcess);
                proc.init(file);
                proc.runAsync(args, args.length, {
                    observe: function(_subject, topic) {
                        if (topic === "process-finished") resolve(proc.exitValue);
                        else if (topic === "process-failed") reject(new Error("process-failed"));
                    },
                });
            } catch (e) { reject(e); }
        });
    },

    // ── Response parsing ──────────────────────────────────────

    _parseResponse(raw, missingFields) {
        // Strip markdown code fences if present
        let cleaned = raw.trim();
        if (cleaned.startsWith("```")) {
            cleaned = cleaned.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
        }

        Zotero.debug("[MetadataFiller] Raw LLM response: " + cleaned.substring(0, 500));

        let parsed;
        try {
            parsed = JSON.parse(cleaned);
        } catch (e) {
            Zotero.debug("[MetadataFiller] Failed to parse LLM response: " + cleaned);
            throw new Error("LLM returned invalid JSON. Raw response: " + cleaned.substring(0, 200));
        }

        Zotero.debug("[MetadataFiller] Parsed keys: " + Object.keys(parsed).join(", "));
        Zotero.debug("[MetadataFiller] Expected keys: " + missingFields.map(function(f){return f.llmKey;}).join(", "));

        // Build lookup: lowercase key -> fieldDef.llmKey
        var keyMap = {};
        for (var i = 0; i < missingFields.length; i++) {
            var f = missingFields[i];
            keyMap[f.llmKey.toLowerCase()] = f.llmKey;
            // Also add common aliases
            if (f.llmKey === "publicationTitle") {
                keyMap["publication"] = f.llmKey;
                keyMap["journal"] = f.llmKey;
                keyMap["journaltitle"] = f.llmKey;
                keyMap["journalname"] = f.llmKey;
            }
            if (f.llmKey === "doi") { keyMap["doi"] = f.llmKey; }
            if (f.llmKey === "authors") {
                keyMap["author"] = f.llmKey;
                keyMap["creators"] = f.llmKey;
            }
            if (f.llmKey === "abstract") { keyMap["abstractnote"] = f.llmKey; }
            if (f.llmKey === "date") {
                keyMap["year"] = f.llmKey;
                keyMap["publicationdate"] = f.llmKey;
            }
            // Note: "url" key is intentionally NOT mapped from LLM output;
            // URLs only come from verified enrichment sources.
            if (f.llmKey === "numPages") { keyMap["numpages"] = f.llmKey; keyMap["pages"] = f.llmKey; }
        }

        var result = {};
        for (var key in parsed) {
            if (!parsed.hasOwnProperty(key)) continue;
            var value = parsed[key];
            if (value === null || value === "" || value === undefined) continue;

            // SECURITY / TRUST: never accept a URL from the LLM. Models hallucinate
            // URLs all the time, and a hallucinated URL silently overwriting an
            // item's URL field is a worst-case outcome. URLs only come from
            // verified sources (OpenAlex / CrossRef enrichment).
            var lk = String(key).toLowerCase();
            if (lk === "url" || lk === "link" || lk === "html_url" || lk === "homepage") continue;

            // Try exact match first, then lowercase, then alias
            var mappedKey = null;
            if (keyMap[key]) {
                mappedKey = keyMap[key];
            } else if (keyMap[key.toLowerCase()]) {
                mappedKey = keyMap[key.toLowerCase()];
            }

            if (mappedKey && !result[mappedKey]) {
                result[mappedKey] = value;
            }
        }

        Zotero.debug("[MetadataFiller] Matched fields: " + Object.keys(result).join(", "));
        return result;
    },

    // ── Utility ───────────────────────────────────────────────

    /**
     * Get the effective model name for a provider, considering custom overrides.
     */
    getEffectiveModel(provider) {
        const custom = Zotero.Prefs.get(`extensions.metadata-filler.${provider}.customModel`);
        if (custom && custom.trim()) return custom.trim();
        const selected = Zotero.Prefs.get(`extensions.metadata-filler.${provider}.model`);
        return selected || this.providers[provider].defaultModel;
    },

    /**
     * Get the API key for a provider.
     */
    getAPIKey(provider) {
        return Zotero.Prefs.get(`extensions.metadata-filler.${provider}.apiKey`) || "";
    },

    // ── Orphan PDF mode ───────────────────────────────────────

    /**
     * Query an LLM to identify the item type and extract full metadata
     * from a standalone PDF with no parent item.
     */
    async queryOrphan(opts) {
        var provider = opts.provider;
        var apiKey = opts.apiKey;
        var model = opts.model;
        var text = opts.text;
        var imageBase64 = opts.imageBase64;
        var maxTokens = opts.maxTokens;

        if (!apiKey && provider !== "apple") throw new Error("No API key configured for " + provider);

        // Build the list of supported types and their fields for the prompt
        var typeDescriptions = [];
        var typeKeys = FieldMappings.getTypeKeys();
        for (var t = 0; t < typeKeys.length; t++) {
            var tk = typeKeys[t];
            var typeDef = FieldMappings.types[tk];
            var fieldNames = typeDef.fields.map(function(f) { return f.llmKey; });
            typeDescriptions.push('  "' + tk + '" (' + typeDef.label + '): fields = [' + fieldNames.join(", ") + ']');
        }

        var systemPrompt = 'You are a metadata extraction assistant for academic and research documents.\n'
            + 'You are given the first two pages of a standalone PDF that has no bibliographic metadata.\n\n'
            + 'Your task:\n'
            + '1. Determine what TYPE of document this is.\n'
            + '2. Extract as much metadata as you can.\n\n'
            + 'Supported item types and their fields:\n'
            + typeDescriptions.join('\n') + '\n\n'
            + 'Rules:\n'
            + '1. Return a JSON object with TWO top-level keys:\n'
            + '   - "itemType": one of the type keys listed above (e.g. "journalArticle", "book", etc.)\n'
            + '   - "metadata": an object containing the metadata fields for that type\n'
            + '2. For author/creator fields, return an array of {"firstName": "...", "lastName": "..."} objects.\n'
            + '3. For dates, use YYYY-MM-DD or YYYY if only the year is known.\n'
            + '4. Only include fields you can confidently determine. Omit unknown fields.\n'
            + '5. Do NOT guess or hallucinate. Only return information clearly present.\n'
            + '6. Return ONLY the JSON object, no explanation or markdown.\n';

        var userParts = [];
        if (imageBase64) {
            userParts.push({ type: "image", base64: imageBase64, mediaType: "image/png" });
        }
        userParts.push({
            type: "text",
            text: "Here is the extracted text from the first two pages of a standalone PDF:\n\n"
                + text
                + "\n\nPlease identify the document type and extract all available metadata as JSON."
        });

        var raw;
        switch (provider) {
            case "openai":
                raw = await this._callOpenAI(apiKey, model, systemPrompt, userParts, maxTokens);
                break;
            case "custom":
                raw = await this._callCustom(apiKey, model, systemPrompt, userParts, maxTokens);
                break;
            case "anthropic":
                raw = await this._callAnthropic(apiKey, model, systemPrompt, userParts, maxTokens);
                break;
            case "google":
                raw = await this._callGoogle(apiKey, model, systemPrompt, userParts, maxTokens);
                break;
            case "apple":
                raw = await this._callApple(model, systemPrompt, userParts, maxTokens);
                break;
            default:
                throw new Error("Unknown provider: " + provider);
        }

        this._lastRawResponse = raw;
        try { Zotero.Prefs.set("extensions.metadata-filler.lastRawResponse", String(raw || "").slice(0, 16384)); } catch(e) {}
        return this._parseOrphanResponse(raw);
    },

    /**
     * Parse the LLM response for an orphan PDF query.
     * Returns { itemType: string, metadata: object }
     */
    _parseOrphanResponse(raw) {
        var cleaned = raw.trim();
        if (cleaned.startsWith("```")) {
            cleaned = cleaned.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
        }

        var parsed;
        try {
            parsed = JSON.parse(cleaned);
        } catch (e) {
            Zotero.debug("[MetadataFiller] Failed to parse orphan LLM response: " + cleaned);
            throw new Error("LLM returned invalid JSON: " + cleaned.substring(0, 200));
        }

        var itemType = parsed.itemType;
        var metadata = parsed.metadata || {};

        // Validate the item type
        if (!itemType || !FieldMappings.types[itemType]) {
            // Try to find a close match
            var typeKeys = FieldMappings.getTypeKeys();
            var lower = (itemType || "").toLowerCase();
            for (var i = 0; i < typeKeys.length; i++) {
                if (typeKeys[i].toLowerCase() === lower) {
                    itemType = typeKeys[i];
                    break;
                }
            }
            if (!FieldMappings.types[itemType]) {
                itemType = "document"; // fallback
            }
        }

        // Filter metadata to only valid fields for the chosen type
        var validFields = FieldMappings.getFieldsForType(itemType);
        var validKeys = {};
        for (var j = 0; j < validFields.length; j++) {
            validKeys[validFields[j].llmKey] = validFields[j];
        }

        var filteredMetadata = {};
        for (var key in metadata) {
            if (!metadata.hasOwnProperty(key)) continue;
            // Drop hallucinated URLs from LLM output (orphan mode too).
            var lk = String(key).toLowerCase();
            if (lk === "url" || lk === "link" || lk === "html_url" || lk === "homepage") continue;
            if (validKeys[key] && metadata[key] !== null && metadata[key] !== "") {
                filteredMetadata[key] = metadata[key];
            }
        }

        return {
            itemType: itemType,
            metadata: filteredMetadata
        };
    },
};
