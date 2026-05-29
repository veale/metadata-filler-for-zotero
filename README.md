# Metadata Filler for Zotero

Version: 0.1

A Zotero 7 plugin that uses multimodal AI, cloud or local, to find and fill missing metadata in your library by analysing text and or images from the first few pages of PDF attachments. Supports Apple Foundation Models with an extra step, and also uses OpenAlex to augment.

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
| **Apple Intelligence (on-device)** | _(single model)_ | — _(macOS only, see below)_ |

If you don't want to pay for a model, or send your data externally, then download Ollama and install an open source model, and point your OpenAI-compatible endpoint to Ollama in the way described by the software.

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

## Apple Intelligence (on-device, macOS only)

The plugin can route requests to Apple's on-device foundation model instead of an HTTP API. **It runs entirely on the user's Mac — no API keys, no network, no per-token cost.**

### Requirements

- Apple Silicon Mac (M-series)
- macOS 26 (Tahoe) or later
- Apple Intelligence enabled in System Settings → Apple Intelligence (allow time for the model to download on first enable)

### Why opt-in for non-Mac users

The "Apple Intelligence" provider entry is **removed from the dropdown** on Linux and Windows so non-Mac users never see it. The Swift helper binary is shipped only inside builds that successfully built it on a macOS CI runner — Linux/Windows users get a `.xpi` that doesn't even contain `bin/fm-helper`. Cross-platform users see no extra prompts, no missing-feature errors, no behaviour change.

### How it works

A small Swift CLI (`fm-helper`) wraps Apple's `FoundationModels` framework. The plugin invokes it as a subprocess: writes the prompt to a temp JSON file, runs the helper, reads the JSON result back, deletes both. The helper is generic text-in / text-out, so the plugin's existing JSON parser (with its alias table, markdown-fence stripping, and never-trust-LLM-URLs rule) works unchanged.

```
JS plugin  ── writes ──►  /tmp/mf-apple-in-*.json
   │                              │
   │                       fm-helper (Swift)
   │                              │
   │                       LanguageModelSession
   │                              │
JS plugin  ── reads ───  /tmp/mf-apple-out-*.json
```

The on-device model is **text-only** as of macOS 26, so the Apple provider drops image parts before sending. Everything else (page-range, embedded PDF metadata, OpenAlex enrichment, DOI shortcut, retry, diff view) works the same.

### Getting the helper installed

Three paths, in order of convenience.

#### Path 1 — "Build helper now" button (recommended)

Open the dialog (Tools → Find &amp; Fill Missing Metadata…), select **Apple Intelligence (on-device)** as the provider, and click **Build helper now**.

The plugin will:
1. Check for Xcode CLI tools (`xcode-select -p`). If missing, you get a precise instruction: run `xcode-select --install` and re-click.
2. Compile `fm-helper/` from the source bundled inside the .xpi (`swift build -c release --arch arm64`). Takes 30–60 seconds the first time.
3. Copy the resulting binary to `<Zotero data dir>/fm-helper`, ad-hoc sign it, `chmod +x`, and strip the quarantine attribute.
4. Auto-fill the helper-path field.

Compile output and any errors are shown in a panel below the buttons — copy/paste straight into a bug report if it fails.

#### Path 2 — released `.xpi` with a pre-built helper

Tagged releases (`vX.Y.Z`) attempt to include a CI-built, ad-hoc-signed `bin/fm-helper`. On startup the plugin copies it to `<Zotero data dir>/fm-helper`, `chmod +x`'s it, and strips `com.apple.quarantine`.

**Important caveat (Apr 2026):** GitHub's hosted runners don't yet have the macOS 26 SDK that `FoundationModels` requires. The CI workflow tries `macos-26` and `macos-latest` runners in parallel — once GitHub publishes either with the macOS 26 SDK, the workflow auto-picks it with no code change. Until then, released `.xpi`s ship without a pre-built helper, and Path 1 is the way.

The CI does **not** require an Apple Developer account — it does ad-hoc signing only.

#### Path 3 — manual build from a Terminal

```bash
cd /path/to/zotero-metadata-filler/fm-helper
swift build -c release --arch arm64
codesign --sign - --force --timestamp=none .build/arm64-apple-macosx/release/fm-helper
cp .build/arm64-apple-macosx/release/fm-helper "$ZOTERO_DATA_DIR/fm-helper"
chmod +x "$ZOTERO_DATA_DIR/fm-helper"
```

Or `MF_BUILD_HELPER=1 ./scripts/build.sh` to build helper + .xpi in one shot. The script gates on `xcode-select -p` so it won't trigger an Xcode CLI install prompt on machines that don't have it.

The plugin looks for a helper at: `extensions.metadata-filler.apple.helperPath` pref → `<Zotero data dir>/fm-helper` → `<addon root>/bin/fm-helper`.

### Verifying it works

In the dialog, pick "Apple Intelligence (on-device)" as the provider. Click **Test** next to the helper-path field — it reports the path it found, or what's missing.

### What if it fails?

When the Apple provider hits an error, the dialog now shows a multi-line message with concrete next steps. Common failure modes:

- **"helper binary not found"** — the message lists every path checked (✓/✗) and tells you exactly what to run. Easiest fix: click **Build helper now**.
- **"On-device model unavailable"** — Apple Intelligence isn't enabled, or the model is still downloading. The error includes the steps: System Settings → Apple Intelligence &amp; Siri → enable, then wait for the download.
- **"guardrail blocked this content"** — Apple's safety filter caught something. The message tells you to try a different item or fall back to OpenAI/Anthropic/Google for that one.
- **"context-window"** — input + expected output exceeded the ~4K-token budget. The message tells you to reduce `pageRange.short` to 1, or use the Advanced panel to trim the prompt, or switch providers.
- **"binary couldn't be executed" (exit 126/127)** — typically a quarantine attribute. The error message includes the exact `xattr -d` and `chmod +x` commands to copy/paste. Also suggests **Build helper now** as a one-click rebuild.
- **swift build fails** — the build status panel shows the exit code. Most common cause is missing macOS 26 SDK (update macOS / Xcode). The message includes the exact command to re-run from Terminal for full output.

For *any* failure, the **Last raw model response (debug)** disclosure on the dialog's first page shows the exact text the helper emitted (or the JSON error payload), useful for filing an issue.

### Limits to design around

- **~4K-token total context** (input + output combined). Roughly 12–15 KB of English text. Fine for two-page metadata extraction; not fine for long-document summarisation.
- **Single model.** No model selection — the "Model" field is ignored for the Apple provider.
- **Text-only.** Image parts are stripped. The plugin still extracts page images for *other* providers in the same scan.
- **English works best.** Other languages work, accuracy varies.

## Seeing what the model actually returned (debug)

Two ways to inspect raw model output without enabling Zotero's debug log:

- **"Last raw model response (debug)"** disclosure on the dialog's first page. Shows the exact text from the most recent call (any provider, any flow — manual, Quick Fill, Apple). Has Refresh / Copy / Clear buttons.
- **"raw" button on each review card** in the manual flow. Toggles a panel under the card showing exactly what came back for *that* item. For DOI-shortcut hits, this shows the OpenAlex/CrossRef JSON instead.

This is the first thing to check when an item came back wrong, before re-running.

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
| `doiShortcut` | `true` | DOI on page 1 → OpenAlex shortcut, skip LLM |
| `forceLLM` | `false` | Override the DOI shortcut, always use the model |
| `enrich` | `true` | Confirm/extend via OpenAlex/CrossRef after LLM |
| `skipExisting` | `true` | Don't overwrite a non-empty field unless explicitly accepted |
| `pageRange.short` | `2` | Pages to read for short docs |
| `pageRange.long` | `4` | Pages to read for docs ≥ threshold |
| `pageRange.longThreshold` | `50` | Page count above which "long" rules apply |
| `openalex.mailto` | _(empty)_ | OpenAlex polite-pool email (higher rate limit) |
| `openalex.apiKey` | _(empty)_ | Optional OpenAlex API key |
| `quickFillLog` | _(internal)_ | Ring buffer for the Quick Fill activity log |

## Privacy &amp; safety

- **No automatic writes**: the manual flow is review-gated.
- **Quick Fill _does_ write directly** — by design, since it's a one-click action. Use the dialog if you want a review step.
- **API keys stored locally** in Zotero prefs.
- **Only first 2 pages** of each PDF are sent.
- **No telemetry.**

## What v1.2 added

- **DOI shortcut.** First-page DOI is regex-extracted; if found, the plugin queries OpenAlex (with CrossRef fallback) and skips the LLM entirely. Configurable + toggleable per-run via "Force LLM (skip DOI shortcut)". Both the manual flow and the right-click Quick Fill use this path.
- **OpenAlex / CrossRef confirmation.** When the LLM does run and returns a DOI, the result is reconciled against OpenAlex; canonical fields (title, authors, journal, volume/issue/pages, ISSN, date) come from the verified source, abstracts/URLs only fill if the LLM left them blank. Each review card shows a green ✓ source badge when this happened.
- **Title-search fallback.** When the LLM returns sparse results without a DOI, the plugin tries an OpenAlex title search and offers the top match if it plausibly aligns with the extracted title.
- **OpenAlex polite-pool / API key prefs** for higher rate limits.
- **Configurable page range, adaptive for long docs.** Defaults: 2 pages for short docs, 4 pages for docs ≥50 pages (theses, books). All three numbers (short / threshold / long) are editable in the dialog.
- **Embedded PDF metadata** (`/Title`, `/Author`, `/Subject`, XMP) is extracted via pdf.js and passed to the LLM as a soft prior — explicitly framed as "verify against the page content; ignore if obviously wrong" so the model doesn't blindly trust the PDF Author field that often holds a vendor name.
- **Diff view** in the review screen: existing value (struck-through) → proposed value (highlighted), with per-field "keep new" / "keep old" buttons.
- **Skip-already-good toggle** (default on). Non-empty fields aren't overwritten unless either (a) the user clicks "keep new" on the diff, or (b) the source is verified (OpenAlex/CrossRef).
- **Run preservation.** "Back to Results" no longer clears the run; reopen the review without re-scanning.
- **Cost estimator** (token-only). Click "Estimate cost" on the Select Items step to see approximate input/output/image tokens for the selection. USD figures are intentionally not shown — provider prices change too often for a hardcoded table to be safer than no number.
- **Retry with jittered exponential backoff** on 429 and 5xx for every provider call (3 attempts; honours `Retry-After`).
- **Never-trust-LLM-URLs.** The parser drops any `url`, `link`, `html_url`, or `homepage` key returned by the LLM. URLs only land on items via OpenAlex/CrossRef enrichment.
- **Tests.** 23 unit tests under `tests/` covering the OpenAI body builder, body-override merge, response parsing (incl. URL stripping), DOI extraction, OpenAlex normalisation, abstract reconstruction, retry-after parsing, prompt templating, and token estimation. Run with `npm test`. Wired into CI.

## to improve

- **Field-mapping aliases are still hand-rolled.** `_parseResponse` knows about `journal`/`containerTitle`/`journalName` but a model that returns `journalShort` or `series` is dropped silently. A schema-driven alias table or per-type Zod-style validator would scale better.
- **No per-item retry in the UI.** Backoff handles transient HTTP errors, but if all 3 attempts fail, the only remedy is re-running the whole scan.
- **No confidence scoring.** The model is never asked to mark uncertain fields, so the diff view treats "obviously hallucinated" the same as "verbatim from page 1".
- **No abstract / page-image hash for change-detection.** Re-running the same item makes the same API call.
- **PDF info-dict priority is soft.** Embedded metadata is shown to the model as a hint, not used as a deterministic fast-path for items where it's clearly correct (e.g. Crossref-stamped publisher PDFs).
- **No CSV / JSON export of a run** for audit / replay.
- **No localisation.** Strings are inline English; `locale/en-US/addon.ftl` is unused.

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

- **Zotero 7, 8, or 9** (not compatible with Zotero 6)
- API key from at least one supported provider
- Internet access

## License

MIT
