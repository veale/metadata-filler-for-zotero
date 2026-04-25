# Zotero Metadata Filler

A Zotero 7 plugin that uses multimodal AI to find and fill missing metadata in your library by analysing PDF attachments.

## What it does

1. **Scans** your Zotero library for items with missing metadata (fully customisable: pick which item types and which specific fields to check)
2. **Extracts** text and a rendered image from the first two pages of each item's PDF
3. **Sends** both the text and image to a multimodal LLM, instructing it to return only the missing fields as structured JSON
4. **Presents** all proposed changes for your review — nothing is written to your library until you explicitly approve it

There is also a **right-click "Quick Fill"** mode for orphan PDFs that creates a parent item and writes the AI-extracted metadata in one shot, with a persistent activity log visible from the dialog.

## Supported AI providers

| Provider | Default model | API key source |
|----------|--------------|----------------|
| **OpenAI** | `gpt-4o` | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |
| **Anthropic** | `claude-sonnet-4-20250514` | [console.anthropic.com](https://console.anthropic.com/) |
| **Google Gemini** | `gemini-2.0-flash` | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| **OpenAI-compatible** | _(user-supplied)_ | — |

Each provider has a **custom model** field — type any model identifier and it will be used.

### Newer OpenAI models (GPT-5 / o-series)

OpenAI's GPT-5 family (incl. `gpt-5.4`, `gpt-5-mini`, …) and the o-series reasoning models (`o1`, `o3`, `o4`, …) replaced `max_tokens` with `max_completion_tokens` and dropped support for custom `temperature`. The plugin now:

- Detects new-style models by name and sends `max_completion_tokens` automatically.
- Omits `temperature` for reasoning / GPT-5 models (which only accept the default).
- Falls back transparently if OpenAI returns a parameter-mismatch 400 — it rewrites the body and retries once.
- Lets you **override anything** via the Advanced panel (see below) so you can self-fix issues with future models without waiting for a release.

## Advanced panel — self-fixing for future models

Open the dialog (Tools → Find &amp; Fill Missing Metadata…) and expand **"Advanced — system prompt &amp; request body overrides"** under the provider config. You get:

- **Editable system prompt** with `{itemTypeLabel}` and `{fieldList}` placeholders. Save / Restore default buttons. Edits are stored in Zotero prefs.
- **Per-provider request body overrides (JSON).** This object is deep-merged into the outgoing request body just before it's sent. Use it to:
  - Rename a field that a provider has changed (e.g. `{"max_completion_tokens": 4096, "max_tokens": null}`)
  - Add new required parameters (e.g. `{"reasoning_effort": "low"}`)
  - Strip unsupported parameters (set them to `null`)
  - Tweak `response_format`, `top_p`, etc.

So if OpenAI/Anthropic/Google ship a breaking parameter change tomorrow, you can fix your install in 30 seconds without an update.

## Recent Quick Fill activity panel

Quick Fill (the right-click "Quick Fill Metadata with AI" action) used to fail silently — its only output was Zotero's debug log. It now writes a per-line ring buffer (last ~200 lines) to a Zotero pref, surfaced in a collapsible panel on the dialog's first page so you can see exactly what happened, including errors, without enabling debug logging.

## Supported item types

Journal Article, Book, Book Section, Conference Paper, Thesis, Report, Preprint, Web Page, Magazine Article, Newspaper Article, Patent, Document.

For each type, you choose exactly which fields to check (author, title, date, DOI, publisher, etc.).

## Installation

### From .xpi file (release)

1. Download the latest `.xpi` from the [Releases](../../releases) page.
2. In Zotero 7, go to **Tools → Add-ons**.
3. Click the gear icon → **Install Add-on From File…**
4. Select the `.xpi`.

### Building from source

```bash
git clone https://github.com/<your-fork>/zotero-metadata-filler.git
cd zotero-metadata-filler
./scripts/build.sh
# produces metadata-filler-<version>.xpi at the repo root
```

### CI / GitHub Actions

This repo ships a `.github/workflows/build.yml` workflow. On every push to `main` and on every PR, the workflow:

- Reads the version from `manifest.json`
- Zips the addon and uploads it as a workflow artifact (`metadata-filler-xpi`)

When you push a tag of the form `vX.Y.Z`, the workflow additionally:

- Generates a fresh `update.json` pointing at the tagged release asset (so Zotero's auto-update can find it)
- Creates a GitHub release and attaches both the `.xpi` and `update.json`

Cutting a release is therefore:

```bash
# bump version in manifest.json, commit
git tag v1.1.0
git push --tags
```

## Usage

### Quick start

1. Set your API key in the dialog (Tools → Find &amp; Fill Missing Metadata…)
2. Pick item types and fields to check
3. **Scan**, **Select**, **Process**, **Review**, **Apply**

### Right-click workflow

- **Fill Missing Metadata for Selected…** — opens the dialog pre-filtered to the selected items.
- **Quick Fill Metadata with AI (no dialog)** — for orphan PDFs only, creates parent items in one click. Inspect the run log via the "Recent Quick Fill activity" panel in the dialog.

### How PDF processing works

For each item:

1. The first two pages of the PDF are read.
2. **Text extraction** via Zotero's bundled pdf.js.
3. **Image rasterisation** of both pages, stitched **side-by-side** into a single PNG (halves image-token cost).
4. Both text and combined image are sent to the LLM in a single request.

If pdf.js rendering is unavailable, the plugin falls back to text-only mode using Zotero's full-text index.

## Configuration

Stored as Zotero prefs under `extensions.metadata-filler.*`:

| Pref | Default | Description |
|------|---------|-------------|
| `provider` | `openai` | Active provider |
| `<provider>.apiKey` | _(empty)_ | API key |
| `<provider>.customModel` | _(empty)_ | Override model name |
| `<provider>.bodyOverrides` | _(empty)_ | JSON deep-merged into request body |
| `systemPromptTemplate` | _(empty = default)_ | Override prompt with `{itemTypeLabel}` / `{fieldList}` |
| `concurrency` | `3` | Parallel requests (1–10) |
| `maxTokens` | `2048` | Max response tokens |
| `sendImages` | `true` | Whether to ship rendered page images |
| `quickFillLog` | _(internal)_ | Ring buffer for the Quick Fill activity log |

## Privacy &amp; safety

- **No automatic writes**: the manual flow is review-gated.
- **Quick Fill _does_ write directly** — by design, since it's a one-click action. Use the dialog if you want a review step.
- **API keys stored locally** in Zotero prefs.
- **Only first 2 pages** of each PDF are sent.
- **No telemetry.**

## Critical appraisal (honest)



- **No retry / backoff.** A single 429 or transient 5xx fails the item permanently for that run. There's no jitter, no exponential backoff, no per-item resume.
- **Field-mapping fragility.** `_parseResponse` relies on a hard-coded alias table (`journal` → `publicationTitle`, etc.). Any model that returns `journalShort` or `containerTitle` is dropped silently.
- **No deduplication / DOI lookup.** When the AI extracts a DOI, the plugin doesn't ask CrossRef/OpenAlex/PubMed to confirm or expand other fields — those services are free, deterministic, and far more accurate than an LLM for canonical metadata.
- **No cost transparency.** Users don't see token counts or estimated $ before/after a run.
- **No persistent run history** beyond the Quick Fill log buffer added in v1.1. Failed items can't easily be retried.
- **Trusts the LLM blindly.** No confidence scores, no flagging when the extracted title doesn't match the PDF's first heading, no diff view against existing fields when the user is _replacing_ rather than filling.
- **Single-page assumption.** Fixed at "first two pages." Books and theses often have the metadata page later.
- **No tests.** The whole codebase is untested; adding even a thin smoke test for `_parseResponse` and `_buildOpenAIBody` would prevent a class of regressions.

## Roadmap

Modest, convenience-oriented improvements (in rough priority order):

### v1.2 — convenience &amp; reliability
- [ ] **CrossRef/OpenAlex confirmation step.** When the AI extracts a DOI, hit CrossRef before showing the review screen — replace AI-guessed authors/title/journal with canonical CrossRef data, mark them as "verified".
- [ ] **Retry with backoff** on 429 / 5xx (3 attempts, jittered exponential).
- [ ] **Per-item retry** in the review screen for failed items, without restarting the whole scan.
- [ ] **Keep the run** in memory across "Back to Results" so users can re-process a subset.
- [ ] **Cost estimator.** Before processing, show approx tokens × price for selected items.
- [ ] **Skip-already-good toggle.** When a field already has a value, ignore the AI's proposal unless the user explicitly opts to overwrite.

### v1.3 — better extraction
- [ ] **Configurable page range** (default still 1–2, but allow last-page or middle-page sampling for theses/books where colophon data lives at the back).
- [ ] **Diff view** in the review screen: existing value vs proposed value, side by side.
- [ ] **Confidence flags.** Ask the model to return a `_confidence` per field; surface low-confidence values in yellow.
- [ ] **Embedded PDF metadata first.** Read `/Title`, `/Author`, XMP, etc. from the PDF info dictionary before paying for an LLM call — many publisher PDFs already have correct metadata embedded.
- [ ] **Title-search fallback.** If text extraction yields a clean title and the AI returns nothing else, query OpenAlex/CrossRef by title and offer those results.

### v1.4 — workflow polish
- [ ] **Preferences pane** (Edit → Settings → Metadata Filler) instead of cramming everything into the dialog.
- [ ] **Watcher mode.** Optionally process newly-added attachments automatically (off by default), with a "Drafts" collection users can review.
- [ ] **Localised UI** (currently English only — `addon.ftl` exists but unused).
- [ ] **Keyboard navigation** in the review screen (j/k to move, a/r to accept/reject).
- [ ] **CSV export** of the last run (item key, original fields, proposed fields, decision).
- [ ] **Light unit tests** for `_parseResponse`, `_buildOpenAIBody`, body-override merge, and field mapping aliases.

### Things deliberately out of scope
- Citation generation / formatting. Zotero already does this well.
- Local model integration via Ollama _is welcome_ via the OpenAI-compatible provider — no special-casing needed.
- Bulk operations on hundreds of thousands of items. The plugin will work, but you'd be better served by a one-shot script with batched API calls.

## Troubleshooting

- **"OpenAI API error (400): Unsupported parameter: 'max_tokens'"** — your model is GPT-5/o-series and needs `max_completion_tokens`. The plugin auto-retries on this; if you've pinned an unusual model name, add `{"max_completion_tokens": 4096, "max_tokens": null}` in the Advanced overrides JSON.
- **"OpenAI API error (400): … temperature …"** — same thing for temperature. Add `{"temperature": null}` in Advanced overrides for that provider.
- **"OpenAI API error (401)"** — invalid API key.
- **"No PDF attachment found"** — attach a PDF to the item first.
- **"LLM returned invalid JSON"** — try a different model (`gpt-4o`, `claude-sonnet-4-20250514`, or `gemini-2.0-flash` are reliable for structured output).
- **pdf.js not available** — text-only fallback is used; this is benign.
- **Rate limits** — drop "Concurrent requests" to 1.
- **Quick Fill seemed to do nothing** — open the dialog and expand "Recent Quick Fill activity" to see the per-PDF result.

## Requirements

- **Zotero 7.0+** (not compatible with Zotero 6)
- API key from at least one supported provider
- Internet access

## License

MIT
