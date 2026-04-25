/* global Zotero, IOUtils, PathUtils, ChromeUtils */
"use strict";

/**
 * PDFProcessor: Reads a PDF attachment's first 2 pages, extracts text,
 * and rasterises them into a single side-by-side image (base64 PNG).
 *
 * Uses Zotero's bundled pdf.js for both text extraction and rendering.
 */
var PDFProcessor = {

    _pdfjsLib: null,

    /**
     * Lazily load pdf.js from Zotero's bundled copy.
     * Falls back to several known paths across Zotero 7.x versions.
     */
    async _getPDFJS() {
        if (this._pdfjsLib) return this._pdfjsLib;

        const paths = [
            "chrome://zotero/content/xpcom/pdfWorker/pdfjs/pdf.mjs",
            "resource://zotero/reader/pdf.js/build/pdf.mjs",
            "chrome://zotero/content/lib/pdfjs/pdf.mjs",
        ];

        for (const path of paths) {
            try {
                const mod = ChromeUtils.importESModule(path);
                if (mod && (mod.getDocument || mod.default?.getDocument || mod.pdfjsLib)) {
                    this._pdfjsLib = mod.pdfjsLib || mod.default || mod;
                    return this._pdfjsLib;
                }
            } catch (e) {
                // Try next path
            }
        }

        // Last resort: try to import via dynamic import in a sandbox
        try {
            const sandbox = new Cu.Sandbox("chrome://zotero/content/", {
                wantGlobalProperties: ["ChromeUtils"],
            });
            Cu.evalInSandbox(
                `this.pdfjsLib = ChromeUtils.importESModule("chrome://zotero/content/xpcom/pdfWorker/pdfjs/pdf.mjs");`,
                sandbox
            );
            if (sandbox.pdfjsLib) {
                this._pdfjsLib = sandbox.pdfjsLib;
                return this._pdfjsLib;
            }
        } catch (e) {
            // Fall through
        }

        return null;
    },

    /**
     * Process a Zotero attachment item:
     *  1. Extract text from pages 1–2
     *  2. Render pages 1–2 as images
     *  3. Stitch images side-by-side into one PNG
     *
     * @param {Zotero.Item} attachment – A PDF attachment item
     * @returns {Promise<{text: string, imageBase64: string|null, pageCount: number}>}
     */
    async process(attachment) {
        const filePath = await attachment.getFilePathAsync();
        if (!filePath) {
            throw new Error("PDF file path not found for attachment " + attachment.id);
        }

        const pdfjsLib = await this._getPDFJS();

        // ── Strategy A: Use pdf.js directly ──
        if (pdfjsLib && pdfjsLib.getDocument) {
            Zotero.debug("[MetadataFiller] Using pdf.js for text+image extraction");
            try {
                const data = await IOUtils.read(filePath);
                return await this._processWithPDFJS(pdfjsLib, data);
            } catch(e) {
                Zotero.debug("[MetadataFiller] pdf.js processing failed: " + e + ", falling back to Zotero fulltext");
            }
        } else {
            Zotero.debug("[MetadataFiller] pdf.js not available, using Zotero fulltext extraction");
        }

        // ── Strategy B: Text-only via Zotero's indexer ──
        return this._processTextOnly(attachment);
    },

    /**
     * Full processing path using pdf.js
     */
    async _processWithPDFJS(pdfjsLib, data) {
        const loadingTask = pdfjsLib.getDocument({ data });
        const pdf = await loadingTask.promise;
        const pageCount = pdf.numPages;
        const pagesToRead = Math.min(2, pageCount);

        let fullText = "";
        const pageImages = [];

        for (let i = 1; i <= pagesToRead; i++) {
            const page = await pdf.getPage(i);

            // ── Text extraction ──
            const textContent = await page.getTextContent();
            const pageText = textContent.items.map((item) => item.str).join(" ");
            fullText += `--- Page ${i} ---\n${pageText}\n\n`;

            // ── Rasterisation ──
            // Use a scale that gives ~1200px width (good detail, reasonable size)
            const viewport = page.getViewport({ scale: 1.0 });
            const targetWidth = 1200;
            const scale = targetWidth / viewport.width;
            const scaledViewport = page.getViewport({ scale });

            // Create a canvas in the current window context
            const canvas = Zotero.getMainWindow().document.createElement("canvas");
            canvas.width = scaledViewport.width;
            canvas.height = scaledViewport.height;
            const ctx = canvas.getContext("2d");

            await page.render({ canvasContext: ctx, viewport: scaledViewport }).promise;

            pageImages.push({
                canvas,
                width: scaledViewport.width,
                height: scaledViewport.height,
            });
        }

        // ── Stitch pages side-by-side ──
        const imageBase64 = this._stitchImages(pageImages);

        return { text: fullText.trim(), imageBase64, pageCount };
    },

    /**
     * Stitch multiple page canvases side-by-side into a single base64 PNG.
     */
    _stitchImages(pageImages) {
        if (pageImages.length === 0) return null;

        const doc = Zotero.getMainWindow().document;
        const totalWidth = pageImages.reduce((sum, p) => sum + p.width, 0);
        const maxHeight = Math.max(...pageImages.map((p) => p.height));

        const combined = doc.createElement("canvas");
        combined.width = totalWidth;
        combined.height = maxHeight;
        const ctx = combined.getContext("2d");

        // White background
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, totalWidth, maxHeight);

        let xOffset = 0;
        for (const { canvas, width } of pageImages) {
            ctx.drawImage(canvas, xOffset, 0);
            xOffset += width;
        }

        // Convert to base64 PNG (strip data URI prefix)
        const dataURL = combined.toDataURL("image/png", 0.85);
        return dataURL.replace(/^data:image\/png;base64,/, "");
    },

    /**
     * Text-only fallback when pdf.js rendering is unavailable.
     * Uses Zotero's built-in full-text indexer on the attachment item.
     */
    async _processTextOnly(attachment) {
        var text = "";
        var attachmentID = attachment.id;

        // Strategy 1: Try to get already-indexed full text for this attachment
        try {
            Zotero.debug("[MetadataFiller] Trying Fulltext.getItemContent for attachment " + attachmentID);
            var content = await Zotero.Fulltext.getItemContent(attachmentID);
            if (content && content.content && content.content.trim().length > 50) {
                text = content.content.substring(0, 8000);
                Zotero.debug("[MetadataFiller] Got indexed text: " + text.length + " chars");
            }
        } catch (e) {
            Zotero.debug("[MetadataFiller] getItemContent failed: " + e);
        }

        // Strategy 2: If no indexed text, trigger indexing and retry
        if (!text) {
            try {
                Zotero.debug("[MetadataFiller] No indexed text, triggering indexItems for " + attachmentID);
                await Zotero.Fulltext.indexItems([attachmentID], { complete: true });
                // Wait briefly for indexing
                await new Promise(function(r) { setTimeout(r, 2000); });

                var content2 = await Zotero.Fulltext.getItemContent(attachmentID);
                if (content2 && content2.content && content2.content.trim().length > 50) {
                    text = content2.content.substring(0, 8000);
                    Zotero.debug("[MetadataFiller] Got text after indexing: " + text.length + " chars");
                }
            } catch (e) {
                Zotero.debug("[MetadataFiller] Indexing failed: " + e);
            }
        }

        // Strategy 3: Try Zotero.PDFWorker if available
        if (!text) {
            try {
                var filePath = await attachment.getFilePathAsync();
                if (Zotero.PDFWorker && Zotero.PDFWorker.getFullText) {
                    Zotero.debug("[MetadataFiller] Trying PDFWorker.getFullText");
                    var result = await Zotero.PDFWorker.getFullText(attachmentID);
                    if (result && result.text && result.text.trim().length > 50) {
                        text = result.text.substring(0, 8000);
                        Zotero.debug("[MetadataFiller] Got text from PDFWorker: " + text.length + " chars");
                    }
                }
            } catch (e) {
                Zotero.debug("[MetadataFiller] PDFWorker failed: " + e);
            }
        }

        // Strategy 4: Use Zotero.File to get recognizable text via pdftotext-style extraction
        if (!text) {
            try {
                Zotero.debug("[MetadataFiller] Trying pdfinfo/recognition");
                var recognizer = await Zotero.RecognizeDocument?.recognizeItems?.([attachment]);
                if (recognizer) {
                    Zotero.debug("[MetadataFiller] RecognizeDocument attempted");
                }
            } catch(e) {
                Zotero.debug("[MetadataFiller] RecognizeDocument failed: " + e);
            }
        }

        if (!text) {
            text = "[Could not extract readable text from PDF. The file may be scanned/image-based, or full-text indexing is not available.]";
            Zotero.debug("[MetadataFiller] All text extraction strategies failed for attachment " + attachmentID);
        }

        return { text: text, imageBase64: null, pageCount: 0 };
    },
};
