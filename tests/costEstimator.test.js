const { test } = require("node:test");
const assert = require("node:assert/strict");
const { makeSandbox, loadLib } = require("./harness");

function load() {
    const sb = makeSandbox();
    loadLib(sb, "lib/costEstimator.js");
    return sb;
}

test("estimateTokens approximates chars/4", () => {
    const { CostEstimator } = load();
    assert.equal(CostEstimator.estimateTokens(""), 0);
    assert.equal(CostEstimator.estimateTokens("aaaa"), 1);
    assert.equal(CostEstimator.estimateTokens("a".repeat(4000)), 1000);
});

test("estimate sums input/output token counts", () => {
    const { CostEstimator } = load();
    const est = CostEstimator.estimate({
        provider: "openai",
        model: "gpt-4o-mini",
        items: [{ textChars: 4000, hasImage: true }, { textChars: 4000, hasImage: true }],
        expectedOutputTokens: 500,
    });
    assert.equal(est.itemCount, 2);
    assert.ok(est.inputTokens > 1000, "should have non-trivial input tokens");
    assert.ok(est.imageTokens > 0, "should account for image tokens when sendImages is true");
    assert.equal(est.outputTokens, 1000);
});

test("estimate omits image tokens when no image is sent", () => {
    const { CostEstimator } = load();
    const est = CostEstimator.estimate({
        provider: "openai",
        model: "gpt-4o-mini",
        items: [{ textChars: 1000, hasImage: false }],
    });
    assert.equal(est.imageTokens, 0);
});

test("formatEstimate renders item count and token totals", () => {
    const { CostEstimator } = load();
    const out = CostEstimator.formatEstimate({
        itemCount: 3, inputTokens: 12000, outputTokens: 1800, imageTokens: 5000,
        model: "gpt-4o-mini",
    });
    assert.match(out, /3 items/);
    assert.match(out, /input tokens/);
    assert.match(out, /output tokens/);
    assert.match(out, /gpt-4o-mini/);
});

test("image tokens differ by provider", () => {
    const { CostEstimator } = load();
    assert.ok(CostEstimator.estimateImageTokens("openai", true) >
              CostEstimator.estimateImageTokens("google", true));
    assert.equal(CostEstimator.estimateImageTokens("openai", false), 0);
});
