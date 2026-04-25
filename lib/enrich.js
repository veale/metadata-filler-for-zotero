/* global Zotero */
"use strict";

/**
 * Enrich: pulls canonical bibliographic data from OpenAlex (and CrossRef as a
 * fallback) to confirm or extend AI-extracted metadata. OpenAlex is preferred
 * because it returns reconstructable abstracts and rich author affiliations
 * without an API key.
 *
 * Two entry points:
 *   - fetchByDOI(doi)         – exact lookup, used to confirm an LLM-returned DOI
 *   - searchByTitle(title)    – fuzzy lookup, used as a fallback when the LLM
 *                               returned nothing useful but text extraction
 *                               yielded a clean title
 *
 * Both return a normalised object with the same key set as the LLM result, so
 * `mergeOver()` can splice them together.
 */
var Enrich = {

    OPENALEX_BASE: "https://api.openalex.org",
    CROSSREF_BASE: "https://api.crossref.org",

    // OpenAlex DOI regex. Matches the canonical "10.NNNN/anything" form,
    // which covers https://doi.org/10... URLs and "doi:10..." prefixes
    // because we only extract the core part. Stop chars chosen to avoid
    // greedy capture of trailing punctuation / whitespace.
    DOI_REGEX: /\b(10\.\d{4,9}\/[-._;()/:A-Z0-9<>+\[\]]+)/i,

    /**
     * Extract the first plausible DOI from arbitrary text. Strips trailing
     * punctuation (. , ; ) ] ) that often gets glommed onto the match.
     */
    extractDOIFromText(text) {
        if (!text) return null;
        var m = String(text).match(this.DOI_REGEX);
        if (!m) return null;
        var doi = m[1].replace(/[.,;)\]>]+$/, "");
        return doi;
    },

    /**
     * Append OpenAlex polite-pool / API-key params from prefs.
     * Without these, OpenAlex rate-limits to ~10 req/s; with mailto, 100k/day.
     */
    _withOpenAlexAuth(url) {
        var sep = url.indexOf("?") >= 0 ? "&" : "?";
        try {
            var mailto = Zotero.Prefs.get("extensions.metadata-filler.openalex.mailto");
            if (mailto && String(mailto).trim()) {
                url += sep + "mailto=" + encodeURIComponent(String(mailto).trim());
                sep = "&";
            }
        } catch (e) {}
        try {
            var apiKey = Zotero.Prefs.get("extensions.metadata-filler.openalex.apiKey");
            if (apiKey && String(apiKey).trim()) {
                url += sep + "api_key=" + encodeURIComponent(String(apiKey).trim());
            }
        } catch (e) {}
        return url;
    },

    /**
     * Fetch by DOI from OpenAlex, falling back to CrossRef on miss.
     * Returns null on any failure — callers should treat enrichment as
     * best-effort.
     */
    async fetchByDOI(doi) {
        var clean = this._cleanDOI(doi);
        if (!clean) return null;

        try {
            var r = await fetch(this._withOpenAlexAuth(this.OPENALEX_BASE + "/works/doi:" + encodeURIComponent(clean)));
            if (r.ok) {
                var w = await r.json();
                return this._normaliseOpenAlex(w);
            }
        } catch (e) {
            this._debug("OpenAlex DOI fetch failed: " + e.message);
        }

        // CrossRef fallback
        try {
            var r2 = await fetch(this.CROSSREF_BASE + "/works/" + encodeURIComponent(clean));
            if (r2.ok) {
                var data = await r2.json();
                return this._normaliseCrossRef(data.message);
            }
        } catch (e) {
            this._debug("CrossRef DOI fetch failed: " + e.message);
        }

        return null;
    },

    /**
     * Fuzzy title search via OpenAlex. Only returns a hit if the top result's
     * title is plausibly the same document (rough substring overlap on the
     * first 40 chars), to avoid wildly wrong "matches".
     */
    async searchByTitle(title) {
        var t = String(title || "").trim();
        if (t.length < 8) return null;

        try {
            var url = this._withOpenAlexAuth(this.OPENALEX_BASE + "/works?search=" + encodeURIComponent(t) + "&per-page=5");
            var r = await fetch(url);
            if (!r.ok) return null;
            var data = await r.json();
            var hits = data.results || [];
            if (!hits.length) return null;

            var probe = t.toLowerCase().substring(0, Math.min(60, t.length));
            for (var i = 0; i < hits.length; i++) {
                var ht = String(hits[i].title || "").toLowerCase();
                if (!ht) continue;
                if (ht.indexOf(probe.substring(0, 30)) !== -1
                    || probe.indexOf(ht.substring(0, 30)) !== -1) {
                    return this._normaliseOpenAlex(hits[i]);
                }
            }
            return null;
        } catch (e) {
            this._debug("OpenAlex title search failed: " + e.message);
            return null;
        }
    },

    _cleanDOI(doi) {
        if (!doi) return null;
        return String(doi)
            .trim()
            .replace(/^doi:\s*/i, "")
            .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
            .replace(/\s+/g, "")
            || null;
    },

    _normaliseOpenAlex(w) {
        if (!w) return null;
        var authors = (w.authorships || []).map(function(a) {
            var name = (a.author && a.author.display_name) || "";
            var parts = name.trim().split(/\s+/).filter(Boolean);
            if (!parts.length) return null;
            var lastName = parts.pop();
            var firstName = parts.join(" ");
            return { firstName: firstName, lastName: lastName };
        }).filter(Boolean);

        var primary = w.primary_location || {};
        var src = primary.source || {};
        var biblio = w.biblio || {};

        var pages = "";
        if (biblio.first_page && biblio.last_page) {
            pages = biblio.first_page + "-" + biblio.last_page;
        } else if (biblio.first_page) {
            pages = biblio.first_page;
        }

        var date = w.publication_date
            || (w.publication_year ? String(w.publication_year) : "");

        var doi = this._cleanDOI(w.doi || "");
        var issn = src.issn_l || (Array.isArray(src.issn) && src.issn[0]) || "";

        return this._stripEmpty({
            title: w.title,
            authors: authors.length ? authors : undefined,
            doi: doi,
            date: date,
            publicationTitle: src.display_name,
            volume: biblio.volume,
            issue: biblio.issue,
            pages: pages,
            ISSN: issn,
            url: w.id,
            abstract: this._reconstructAbstract(w.abstract_inverted_index),
            _source: "openalex",
            _id: w.id,
        });
    },

    _normaliseCrossRef(m) {
        if (!m) return null;
        var authors = (m.author || []).map(function(a) {
            var first = a.given || "";
            var last = a.family || "";
            if (!first && !last) return null;
            return { firstName: first, lastName: last };
        }).filter(Boolean);

        var dateParts = (m.issued && m.issued["date-parts"] && m.issued["date-parts"][0]) || [];
        var date = dateParts.length === 3
            ? dateParts.join("-")
            : dateParts.length ? String(dateParts[0]) : "";

        var pages = m.page || "";

        return this._stripEmpty({
            title: Array.isArray(m.title) ? m.title[0] : m.title,
            authors: authors.length ? authors : undefined,
            doi: this._cleanDOI(m.DOI || ""),
            date: date,
            publicationTitle: Array.isArray(m["container-title"]) ? m["container-title"][0] : m["container-title"],
            volume: m.volume,
            issue: m.issue,
            pages: pages,
            ISSN: Array.isArray(m.ISSN) ? m.ISSN[0] : m.ISSN,
            url: m.URL,
            abstract: m.abstract,
            _source: "crossref",
        });
    },

    _reconstructAbstract(inverted) {
        if (!inverted || typeof inverted !== "object") return undefined;
        var positions = [];
        for (var word in inverted) {
            if (!Object.prototype.hasOwnProperty.call(inverted, word)) continue;
            var posList = inverted[word];
            for (var j = 0; j < posList.length; j++) {
                positions[posList[j]] = word;
            }
        }
        var joined = positions.filter(Boolean).join(" ");
        return joined || undefined;
    },

    _stripEmpty(obj) {
        var out = {};
        for (var k in obj) {
            if (obj[k] === undefined || obj[k] === null || obj[k] === "") continue;
            out[k] = obj[k];
        }
        return out;
    },

    /**
     * Merge enriched data over an existing object.
     *
     * For canonical bibliographic fields (title, doi, authors, date, journal,
     * volume, issue, pages, ISSN) the enriched value wins, since OpenAlex /
     * CrossRef are far more reliable than an LLM. For abstract / url, only
     * fill if missing on the LLM result.
     */
    mergeOver(llmData, enriched) {
        if (!enriched) return llmData;
        var out = Object.assign({}, llmData || {});
        var canonical = ["title", "doi", "authors", "date", "publicationTitle",
            "volume", "issue", "pages", "ISSN"];
        for (var i = 0; i < canonical.length; i++) {
            var k = canonical[i];
            if (enriched[k] !== undefined && enriched[k] !== null && enriched[k] !== "") {
                out[k] = enriched[k];
            }
        }
        if (!out.abstract && enriched.abstract) out.abstract = enriched.abstract;
        if (!out.url && enriched.url) out.url = enriched.url;
        return out;
    },

    _debug(msg) {
        try { Zotero.debug("[MetadataFiller/Enrich] " + msg); } catch (e) {}
    },
};
