/* global Zotero */
"use strict";

/**
 * CostEstimator: rough token estimates for an upcoming run.
 *
 * Tokenisation is heuristic (chars / 4 ≈ tokens) on purpose: shipping a real
 * tokenizer (tiktoken / claude-tokenizer) into a Zotero plugin pulls in
 * either WASM or large encoding tables, while the heuristic is accurate to
 * within ~10% on English academic text — plenty for a "should I run this?"
 * check.
 *
 * USD pricing is intentionally NOT hardcoded — provider prices change too
 * often to keep accurate, and a wrong number is worse than no number. The
 * estimator returns input/output/image token counts; users compare those
 * against their provider's current pricing page.
 */
var CostEstimator = {

    /** chars / 4 ≈ tokens. Adequate for English academic text. */
    estimateTokens(text) {
        return Math.ceil(String(text || "").length / 4);
    },

    /**
     * Approximate image-token cost per page image, by provider.
     *  - OpenAI high-detail: ~765 base + 170 / 512px tile ≈ 1500-2000 for a
     *    1200×1500 stitched image.
     *  - Anthropic: width*height/750 ≈ ~1600 for our stitched image.
     *  - Google: fixed 258 per inline image part.
     */
    estimateImageTokens(provider, hasImage) {
        if (!hasImage) return 0;
        if (provider === "openai" || provider === "custom") return 1785;
        if (provider === "anthropic") return 1600;
        if (provider === "google") return 258;
        return 1500;
    },

    /**
     * Estimate token volume for a batch.
     *
     * @param {Object} opts
     * @param {string} opts.provider
     * @param {string} opts.model
     * @param {Array<{textChars: number, hasImage: boolean}>} opts.items
     * @param {number} [opts.systemPromptChars=900]
     * @param {number} [opts.expectedOutputTokens=600]
     * @returns {Object} { itemCount, inputTokens, outputTokens, imageTokens, model, provider }
     */
    estimate(opts) {
        var sysChars = opts.systemPromptChars || 900;
        var outPerItem = opts.expectedOutputTokens || 600;
        var inputTextTokens = 0;
        var imageTokens = 0;

        for (var i = 0; i < opts.items.length; i++) {
            var it = opts.items[i];
            inputTextTokens += Math.ceil((it.textChars || 0) / 4);
            inputTextTokens += Math.ceil(sysChars / 4);
            imageTokens += this.estimateImageTokens(opts.provider, it.hasImage);
        }

        return {
            itemCount: opts.items.length,
            inputTokens: inputTextTokens + imageTokens,
            outputTokens: outPerItem * opts.items.length,
            imageTokens: imageTokens,
            model: opts.model,
            provider: opts.provider,
        };
    },

    /** Pretty-print an estimate as a single line for the UI. */
    formatEstimate(est) {
        if (!est || !est.itemCount) return "(no items)";
        var parts = [
            est.itemCount + " item" + (est.itemCount === 1 ? "" : "s"),
            "~" + this._fmt(est.inputTokens) + " input tokens (incl. ~" + this._fmt(est.imageTokens) + " image)",
            "~" + this._fmt(est.outputTokens) + " output tokens",
        ];
        return parts.join("  ·  ") + "  — check your provider's pricing page (" + est.model + ")";
    },

    _fmt(n) {
        if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
        if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
        return String(n);
    },
};
