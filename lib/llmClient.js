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

        if (!apiKey) throw new Error(`No API key configured for ${provider}`);

        const systemPrompt = this._buildSystemPrompt(missingFields, itemTypeLabel);
        const userContent = this._buildUserContent(text, imageBase64, missingFields);

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
            default:
                throw new Error("Unknown provider: " + provider);
        }

        this._lastRawResponse = raw;
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

    _buildUserContent(text, imageBase64, missingFields) {
        const fieldNames = missingFields.map((f) => f.llmKey).join(", ");
        const parts = [];

        if (imageBase64) {
            parts.push({
                type: "image",
                base64: imageBase64,
                mediaType: "image/png",
            });
        }

        parts.push({
            type: "text",
            text: `Here is the extracted text from the first two pages of the document:\n\n${text}\n\nPlease extract the following missing metadata fields as JSON: ${fieldNames}`,
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

        var doFetch = function(b) {
            return fetch(LLMClient.providers.openai.endpoint, {
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

        const response = await fetch(endpoint, {
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

        const response = await fetch(this.providers.anthropic.endpoint, {
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

        const response = await fetch(`${endpoint}?key=${apiKey}`, {
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
            if (f.llmKey === "url") { keyMap["link"] = f.llmKey; }
            if (f.llmKey === "numPages") { keyMap["numpages"] = f.llmKey; keyMap["pages"] = f.llmKey; }
        }

        var result = {};
        for (var key in parsed) {
            if (!parsed.hasOwnProperty(key)) continue;
            var value = parsed[key];
            if (value === null || value === "" || value === undefined) continue;

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

        if (!apiKey) throw new Error("No API key configured for " + provider);

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
            default:
                throw new Error("Unknown provider: " + provider);
        }

        this._lastRawResponse = raw;
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
            if (metadata.hasOwnProperty(key) && validKeys[key] && metadata[key] !== null && metadata[key] !== "") {
                filteredMetadata[key] = metadata[key];
            }
        }

        return {
            itemType: itemType,
            metadata: filteredMetadata
        };
    },
};
