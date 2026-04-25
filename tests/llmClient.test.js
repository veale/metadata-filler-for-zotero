const { test } = require("node:test");
const assert = require("node:assert/strict");
const { makeSandbox, loadLib } = require("./harness");

function client() {
    const sb = makeSandbox();
    loadLib(sb, "lib/llmClient.js");
    return sb.LLMClient;
}

test("_isNewOpenAIModel detects GPT-5/o-series, not GPT-4o", () => {
    const c = client();
    for (const m of ["gpt-5", "gpt-5-mini", "gpt-5.4", "gpt-5-nano",
                     "o1", "o3-mini", "o4-mini", "chatgpt-5-2026-04-01"]) {
        assert.equal(c._isNewOpenAIModel(m), true, m + " should be new-style");
    }
    for (const m of ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-3.5-turbo", ""]) {
        assert.equal(c._isNewOpenAIModel(m), false, m + " should be old-style");
    }
});

test("_openAISupportsTemperature: GPT-4o yes, GPT-5/o-series no", () => {
    const c = client();
    assert.equal(c._openAISupportsTemperature("gpt-4o"), true);
    assert.equal(c._openAISupportsTemperature("gpt-5"), false);
    assert.equal(c._openAISupportsTemperature("o3-mini"), false);
});

test("_buildOpenAIBody picks max_completion_tokens for new models, max_tokens for old", () => {
    const c = client();
    const oldBody = c._buildOpenAIBody("gpt-4o", [], 1024);
    assert.equal(oldBody.max_tokens, 1024);
    assert.equal(oldBody.max_completion_tokens, undefined);
    assert.equal(oldBody.temperature, 0.1);

    const newBody = c._buildOpenAIBody("gpt-5.4", [], 1024);
    assert.equal(newBody.max_completion_tokens, 1024);
    assert.equal(newBody.max_tokens, undefined);
    assert.equal(newBody.temperature, undefined, "GPT-5 must not set temperature");
});

test("_applyBodyOverrides: rename, delete, deep-merge", () => {
    const sb = makeSandbox();
    sb.Zotero.Prefs.set("extensions.metadata-filler.openai.bodyOverrides", JSON.stringify({
        max_tokens: null,
        max_completion_tokens: 4096,
        reasoning: { effort: "low" },
    }));
    loadLib(sb, "lib/llmClient.js");
    const body = { model: "gpt-5", max_tokens: 1024, temperature: 0.1, reasoning: { effort: "high" } };
    const out = sb.LLMClient._applyBodyOverrides(body, "openai");
    assert.equal(out.max_tokens, undefined);
    assert.equal(out.max_completion_tokens, 4096);
    assert.equal(out.reasoning.effort, "low");
});

test("_parseResponse drops hallucinated url/link keys", () => {
    const c = client();
    const fields = [
        { llmKey: "title", label: "Title" },
        { llmKey: "doi", label: "DOI" },
    ];
    const result = c._parseResponse(JSON.stringify({
        title: "Foo",
        doi: "10.1000/abc",
        url: "https://hallucinated.example.com",
        link: "https://also-hallucinated.example.com",
    }), fields);
    assert.equal(result.title, "Foo");
    assert.equal(result.doi, "10.1000/abc");
    assert.equal(result.url, undefined);
    assert.equal(result.link, undefined);
});

test("_parseResponse maps aliases (journal → publicationTitle, author → authors)", () => {
    const c = client();
    const fields = [
        { llmKey: "publicationTitle", label: "Publication" },
        { llmKey: "authors", label: "Authors" },
    ];
    const out = c._parseResponse(JSON.stringify({
        journal: "Nature",
        author: [{ firstName: "J", lastName: "Doe" }],
    }), fields);
    assert.equal(out.publicationTitle, "Nature");
    assert.deepEqual(out.authors, [{ firstName: "J", lastName: "Doe" }]);
});

test("_parseResponse strips markdown code fences", () => {
    const c = client();
    const fields = [{ llmKey: "title", label: "Title" }];
    const out = c._parseResponse('```json\n{"title": "X"}\n```', fields);
    assert.equal(out.title, "X");
});

test("_parseRetryAfter parses seconds and HTTP-date", () => {
    const c = client();
    assert.equal(c._parseRetryAfter("5"), 5000);
    assert.equal(c._parseRetryAfter(null), null);
    const future = new Date(Date.now() + 10000).toUTCString();
    const ms = c._parseRetryAfter(future);
    assert.ok(ms > 5000 && ms < 15000);
});

test("apple provider is registered with macOnly flag", () => {
    const c = client();
    assert.ok(c.providers.apple);
    assert.equal(c.providers.apple.macOnly, true);
    assert.equal(c.providers.apple.endpoint, null);
});

test("apple body overrides go through _applyBodyOverrides like HTTP providers", () => {
    const sb = makeSandbox();
    sb.Zotero.Prefs.set("extensions.metadata-filler.apple.bodyOverrides",
        JSON.stringify({ temperature: 0.7, maxTokens: 1024 }));
    loadLib(sb, "lib/llmClient.js");
    const body = { temperature: 0.1, maxTokens: 2048, prompt: "x" };
    const out = sb.LLMClient._applyBodyOverrides(body, "apple");
    assert.equal(out.temperature, 0.7);
    assert.equal(out.maxTokens, 1024);
    assert.equal(out.prompt, "x");
});

test("_buildSystemPrompt expands {fieldList} and {itemTypeLabel}", () => {
    const c = client();
    const out = c._buildSystemPrompt(
        [{ llmKey: "title", label: "Title" }, { llmKey: "doi", label: "DOI" }],
        "Journal Article"
    );
    assert.match(out, /Journal Article/);
    assert.match(out, /"title": Title/);
    assert.match(out, /"doi": DOI/);
});
