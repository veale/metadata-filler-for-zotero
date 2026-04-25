/* global Zotero, FieldMappings */
"use strict";

/**
 * Scanner: Searches the Zotero library for items with missing metadata
 * based on user-selected item types and fields.
 */
var Scanner = {

    /**
     * Scan the library (or a subset of items) for missing metadata.
     *
     * @param {Object}   config
     * @param {Object}   config.typeFieldSelections  – { itemTypeKey: [fieldDef, …], … }
     * @param {number[]|null} config.itemIDs          – restrict to these IDs (null = whole library)
     * @param {number|null}   config.libraryID        – library to scan (null = active)
     * @param {Function} config.onProgress            – callback(current, total)
     *
     * @returns {Promise<Array<{item, typeKey, missingFields, hasPDF}>>}
     */
    async scan(config) {
        const { typeFieldSelections, itemIDs, libraryID, onProgress } = config;

        // Determine which library to use
        const libID = libraryID ?? Zotero.Libraries.userLibraryID;

        // Get candidate items
        let items;
        if (itemIDs && itemIDs.length) {
            items = await Zotero.Items.getAsync(itemIDs);
        } else {
            items = await Zotero.Items.getAll(libID, false, false); // non-trash, non-deleted
        }

        // Filter to regular (non-attachment, non-note) items
        items = items.filter((it) => it.isRegularItem());

        const results = [];
        const total = items.length;

        for (let i = 0; i < items.length; i++) {
            if (onProgress) onProgress(i, total);

            const item = items[i];
            const typeKey = FieldMappings.getTypeKeyForItem(item);

            // Skip item types the user didn't select
            if (!typeKey || !typeFieldSelections[typeKey]) continue;

            const selectedFields = typeFieldSelections[typeKey];
            const missingFields = [];

            for (const fieldDef of selectedFields) {
                if (FieldMappings.isFieldMissingFull(item, fieldDef)) {
                    missingFields.push(fieldDef);
                }
            }

            if (missingFields.length === 0) continue;

            // Check for PDF attachment
            const hasPDF = await this._hasPDFAttachment(item);

            results.push({
                item,
                typeKey,
                missingFields,
                hasPDF,
            });
        }

        if (onProgress) onProgress(total, total);
        return results;
    },

    /**
     * Check whether an item has at least one PDF attachment.
     */
    async _hasPDFAttachment(item) {
        const attachmentIDs = item.getAttachments();
        for (const aid of attachmentIDs) {
            const att = await Zotero.Items.getAsync(aid);
            if (att && att.attachmentContentType === "application/pdf") {
                return true;
            }
        }
        return false;
    },

    /**
     * Get the first PDF attachment for an item.
     * Returns the Zotero attachment item, or null.
     */
    async getPDFAttachment(item) {
        const attachmentIDs = item.getAttachments();
        for (const aid of attachmentIDs) {
            const att = await Zotero.Items.getAsync(aid);
            if (att && att.attachmentContentType === "application/pdf") {
                return att;
            }
        }
        return null;
    },

    /**
     * Scan for standalone PDF attachments (no parent item).
     *
     * @param {Object}   config
     * @param {number[]|null} config.itemIDs   – restrict to these IDs (null = whole library)
     * @param {number|null}   config.libraryID – library to scan
     * @param {Function} config.onProgress     – callback(current, total)
     *
     * @returns {Promise<Array<{item, isOrphan: true}>>}
     */
    async scanOrphanPDFs(config) {
        var itemIDs = config.itemIDs;
        var libraryID = config.libraryID;
        var onProgress = config.onProgress;

        var libID = libraryID || Zotero.Libraries.userLibraryID;

        var items;
        if (itemIDs && itemIDs.length) {
            items = await Zotero.Items.getAsync(itemIDs);
        } else {
            items = await Zotero.Items.getAll(libID, false, false);
        }

        // Filter to attachment items that are PDFs with no parent
        var results = [];
        var total = items.length;

        for (var i = 0; i < items.length; i++) {
            if (onProgress) onProgress(i, total);

            var item = items[i];
            if (!item.isAttachment()) continue;
            if (item.parentItemID) continue; // has a parent — skip
            if (item.attachmentContentType !== "application/pdf") continue;

            // Check it actually has a file
            var path = null;
            try { path = await item.getFilePathAsync(); } catch(e) {}
            if (!path) continue;

            results.push({
                item: item,
                isOrphan: true,
                hasPDF: true,
                typeKey: null,
                missingFields: [],
            });
        }

        if (onProgress) onProgress(total, total);
        return results;
    },
};
