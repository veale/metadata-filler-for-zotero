const { test } = require("node:test");
const assert = require("node:assert/strict");
const { makeSandbox, loadLib } = require("./harness");

function load() {
    const sb = makeSandbox();
    loadLib(sb, "lib/enrich.js");
    return sb;
}

test("extractDOIFromText pulls a bare DOI", () => {
    const { Enrich } = load();
    assert.equal(Enrich.extractDOIFromText("blah 10.1038/s41586-020-2649-2 etc"), "10.1038/s41586-020-2649-2");
});

test("extractDOIFromText pulls from doi: prefix", () => {
    const { Enrich } = load();
    assert.equal(Enrich.extractDOIFromText("doi: 10.1145/3447548.3467329"), "10.1145/3447548.3467329");
});

test("extractDOIFromText pulls from doi.org URL", () => {
    const { Enrich } = load();
    assert.equal(Enrich.extractDOIFromText("see https://doi.org/10.1234/foo.bar"), "10.1234/foo.bar");
});

test("extractDOIFromText returns null when no DOI present", () => {
    const { Enrich } = load();
    assert.equal(Enrich.extractDOIFromText("nothing to see here"), null);
    assert.equal(Enrich.extractDOIFromText(""), null);
    assert.equal(Enrich.extractDOIFromText(null), null);
});

test("extractDOIFromText strips trailing punctuation", () => {
    const { Enrich } = load();
    assert.equal(Enrich.extractDOIFromText("(see 10.1000/abc)."), "10.1000/abc");
});

test("_cleanDOI normalises common forms", () => {
    const { Enrich } = load();
    assert.equal(Enrich._cleanDOI("doi: 10.1/abc"), "10.1/abc");
    assert.equal(Enrich._cleanDOI("https://doi.org/10.1/abc"), "10.1/abc");
    assert.equal(Enrich._cleanDOI("https://dx.doi.org/10.1/abc"), "10.1/abc");
    assert.equal(Enrich._cleanDOI(""), null);
});

test("_normaliseOpenAlex extracts authors, journal, biblio, and reconstructs abstract", () => {
    const { Enrich } = load();
    const work = {
        title: "Attention Is All You Need",
        doi: "https://doi.org/10.5555/3295222.3295349",
        publication_year: 2017,
        publication_date: "2017-06-12",
        authorships: [
            { author: { display_name: "Ashish Vaswani" } },
            { author: { display_name: "Noam Shazeer" } },
        ],
        primary_location: { source: { display_name: "NeurIPS", issn_l: "1234-5678" } },
        biblio: { volume: "30", issue: "1", first_page: "5998", last_page: "6008" },
        id: "https://openalex.org/W2964121944",
        abstract_inverted_index: { "Hello": [0, 2], "world": [1] }, // "Hello world Hello"
    };
    const out = Enrich._normaliseOpenAlex(work);
    assert.equal(out.title, "Attention Is All You Need");
    assert.equal(out.doi, "10.5555/3295222.3295349");
    assert.equal(out.publicationTitle, "NeurIPS");
    assert.equal(out.volume, "30");
    assert.equal(out.pages, "5998-6008");
    assert.equal(out.ISSN, "1234-5678");
    assert.deepEqual(out.authors, [
        { firstName: "Ashish", lastName: "Vaswani" },
        { firstName: "Noam", lastName: "Shazeer" },
    ]);
    assert.equal(out.abstract, "Hello world Hello");
    assert.equal(out._source, "openalex");
});

test("mergeOver lets canonical fields win, fills only missing for abstract/url", () => {
    const { Enrich } = load();
    const llmData = { title: "wrong", abstract: "kept", doi: "10.x/wrong" };
    const enriched = { title: "right", doi: "10.x/right", url: "https://oa.example/W123", abstract: "should-not-replace" };
    const merged = Enrich.mergeOver(llmData, enriched);
    assert.equal(merged.title, "right");
    assert.equal(merged.doi, "10.x/right");
    assert.equal(merged.abstract, "kept", "abstract should not overwrite when llm already had one");
    assert.equal(merged.url, "https://oa.example/W123", "url should fill since llm didn't have one");
});

test("mergeOver handles null enrichment safely", () => {
    const { Enrich } = load();
    assert.deepEqual(Enrich.mergeOver({ title: "x" }, null), { title: "x" });
});
