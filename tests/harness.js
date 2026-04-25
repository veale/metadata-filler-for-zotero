// Loads addon lib/ scripts (which assign to `var X = {...}` at file scope)
// into the current Node realm so tests get same-realm objects (avoids
// cross-realm prototype issues with assert.deepStrictEqual).
//
// We wrap each lib in an IIFE that returns its top-level `var` bindings as
// an object, then merge those into the harness's return value.

const fs = require("fs");
const path = require("path");

function makeSandbox() {
    return {
        Zotero: {
            debug: () => {},
            Prefs: {
                _store: {},
                get(k) { return this._store[k]; },
                set(k, v) { this._store[k] = v; },
                clear(k) { delete this._store[k]; },
            },
        },
    };
}

const TOP_LEVEL_NAMES = ["LLMClient", "Enrich", "CostEstimator", "PDFProcessor",
    "FieldMappings", "Scanner"];

function loadLib(sandbox, ...relPaths) {
    for (const rel of relPaths) {
        const code = fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
        // Build an IIFE: declare the var bindings inside, then return the
        // names that ended up defined. We ride on the scripts themselves
        // declaring `var Foo = ...` at the top level.
        const exportSnippet = "return { " + TOP_LEVEL_NAMES.map(function(n) {
            return n + ": typeof " + n + " !== 'undefined' ? " + n + " : undefined";
        }).join(", ") + " };";
        const fn = new Function("Zotero", "fetch", "setTimeout", "clearTimeout",
            code + "\n" + exportSnippet);
        const exports = fn(sandbox.Zotero, sandbox.fetch || (async () => { throw new Error("no fetch"); }),
            setTimeout, clearTimeout);
        for (const k in exports) {
            if (exports[k] !== undefined) sandbox[k] = exports[k];
        }
    }
    return sandbox;
}

module.exports = { makeSandbox, loadLib };
