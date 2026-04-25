/* global */
"use strict";

/**
 * Mapping of Zotero item types to their metadata fields.
 * Each field entry has:
 *   - label:  Human-readable name for display
 *   - zotero: Internal Zotero field name (used with item.getField())
 *   - llmKey: Key name the LLM should use in its JSON response
 */
var FieldMappings = {

    // ── Item type definitions ──────────────────────────────────
    types: {
        journalArticle: {
            label: "Journal Article",
            fields: [
                { label: "Title",           zotero: "title",          llmKey: "title" },
                { label: "Author(s)",       zotero: "creators",      llmKey: "authors",       isCreator: true, creatorType: "author" },
                { label: "Date",            zotero: "date",           llmKey: "date" },
                { label: "Publication",     zotero: "publicationTitle", llmKey: "publicationTitle" },
                { label: "Volume",          zotero: "volume",         llmKey: "volume" },
                { label: "Issue",           zotero: "issue",          llmKey: "issue" },
                { label: "Pages",           zotero: "pages",          llmKey: "pages" },
                { label: "DOI",             zotero: "DOI",            llmKey: "doi" },
                { label: "ISSN",            zotero: "ISSN",           llmKey: "issn" },
                { label: "Abstract",        zotero: "abstractNote",   llmKey: "abstract" },
                { label: "Language",        zotero: "language",       llmKey: "language" },
                { label: "URL",             zotero: "url",            llmKey: "url" },
            ],
        },
        book: {
            label: "Book",
            fields: [
                { label: "Title",           zotero: "title",          llmKey: "title" },
                { label: "Author(s)",       zotero: "creators",      llmKey: "authors",       isCreator: true, creatorType: "author" },
                { label: "Editor(s)",       zotero: "creators",      llmKey: "editors",       isCreator: true, creatorType: "editor" },
                { label: "Date",            zotero: "date",           llmKey: "date" },
                { label: "Publisher",       zotero: "publisher",      llmKey: "publisher" },
                { label: "Place",           zotero: "place",          llmKey: "place" },
                { label: "ISBN",            zotero: "ISBN",           llmKey: "isbn" },
                { label: "Edition",         zotero: "edition",        llmKey: "edition" },
                { label: "Pages",           zotero: "numPages",       llmKey: "numPages" },
                { label: "Series",          zotero: "series",         llmKey: "series" },
                { label: "Abstract",        zotero: "abstractNote",   llmKey: "abstract" },
                { label: "Language",        zotero: "language",       llmKey: "language" },
                { label: "URL",             zotero: "url",            llmKey: "url" },
            ],
        },
        bookSection: {
            label: "Book Section",
            fields: [
                { label: "Title",           zotero: "title",          llmKey: "title" },
                { label: "Author(s)",       zotero: "creators",      llmKey: "authors",       isCreator: true, creatorType: "author" },
                { label: "Editor(s)",       zotero: "creators",      llmKey: "editors",       isCreator: true, creatorType: "editor" },
                { label: "Book Title",      zotero: "bookTitle",      llmKey: "bookTitle" },
                { label: "Date",            zotero: "date",           llmKey: "date" },
                { label: "Publisher",       zotero: "publisher",      llmKey: "publisher" },
                { label: "Pages",           zotero: "pages",          llmKey: "pages" },
                { label: "ISBN",            zotero: "ISBN",           llmKey: "isbn" },
                { label: "Abstract",        zotero: "abstractNote",   llmKey: "abstract" },
            ],
        },
        conferencePaper: {
            label: "Conference Paper",
            fields: [
                { label: "Title",           zotero: "title",          llmKey: "title" },
                { label: "Author(s)",       zotero: "creators",      llmKey: "authors",       isCreator: true, creatorType: "author" },
                { label: "Date",            zotero: "date",           llmKey: "date" },
                { label: "Proceedings Title", zotero: "proceedingsTitle", llmKey: "proceedingsTitle" },
                { label: "Conference Name", zotero: "conferenceName", llmKey: "conferenceName" },
                { label: "Pages",           zotero: "pages",          llmKey: "pages" },
                { label: "DOI",             zotero: "DOI",            llmKey: "doi" },
                { label: "Publisher",       zotero: "publisher",      llmKey: "publisher" },
                { label: "Abstract",        zotero: "abstractNote",   llmKey: "abstract" },
                { label: "URL",             zotero: "url",            llmKey: "url" },
            ],
        },
        thesis: {
            label: "Thesis",
            fields: [
                { label: "Title",           zotero: "title",          llmKey: "title" },
                { label: "Author(s)",       zotero: "creators",      llmKey: "authors",       isCreator: true, creatorType: "author" },
                { label: "Date",            zotero: "date",           llmKey: "date" },
                { label: "University",      zotero: "university",     llmKey: "university" },
                { label: "Thesis Type",     zotero: "thesisType",     llmKey: "thesisType" },
                { label: "Pages",           zotero: "numPages",       llmKey: "numPages" },
                { label: "Abstract",        zotero: "abstractNote",   llmKey: "abstract" },
                { label: "Language",        zotero: "language",       llmKey: "language" },
                { label: "URL",             zotero: "url",            llmKey: "url" },
            ],
        },
        report: {
            label: "Report",
            fields: [
                { label: "Title",           zotero: "title",          llmKey: "title" },
                { label: "Author(s)",       zotero: "creators",      llmKey: "authors",       isCreator: true, creatorType: "author" },
                { label: "Date",            zotero: "date",           llmKey: "date" },
                { label: "Institution",     zotero: "institution",    llmKey: "institution" },
                { label: "Report Type",     zotero: "reportType",     llmKey: "reportType" },
                { label: "Report Number",   zotero: "reportNumber",   llmKey: "reportNumber" },
                { label: "Pages",           zotero: "numPages",       llmKey: "numPages" },
                { label: "Abstract",        zotero: "abstractNote",   llmKey: "abstract" },
                { label: "URL",             zotero: "url",            llmKey: "url" },
            ],
        },
        preprint: {
            label: "Preprint",
            fields: [
                { label: "Title",           zotero: "title",          llmKey: "title" },
                { label: "Author(s)",       zotero: "creators",      llmKey: "authors",       isCreator: true, creatorType: "author" },
                { label: "Date",            zotero: "date",           llmKey: "date" },
                { label: "Repository",      zotero: "repository",     llmKey: "repository" },
                { label: "Archive ID",      zotero: "archiveID",      llmKey: "archiveID" },
                { label: "DOI",             zotero: "DOI",            llmKey: "doi" },
                { label: "Abstract",        zotero: "abstractNote",   llmKey: "abstract" },
                { label: "URL",             zotero: "url",            llmKey: "url" },
            ],
        },
        webpage: {
            label: "Web Page",
            fields: [
                { label: "Title",           zotero: "title",          llmKey: "title" },
                { label: "Author(s)",       zotero: "creators",      llmKey: "authors",       isCreator: true, creatorType: "author" },
                { label: "Date",            zotero: "date",           llmKey: "date" },
                { label: "Website Title",   zotero: "websiteTitle",   llmKey: "websiteTitle" },
                { label: "URL",             zotero: "url",            llmKey: "url" },
            ],
        },
        magazineArticle: {
            label: "Magazine Article",
            fields: [
                { label: "Title",           zotero: "title",          llmKey: "title" },
                { label: "Author(s)",       zotero: "creators",      llmKey: "authors",       isCreator: true, creatorType: "author" },
                { label: "Date",            zotero: "date",           llmKey: "date" },
                { label: "Publication",     zotero: "publicationTitle", llmKey: "publicationTitle" },
                { label: "Volume",          zotero: "volume",         llmKey: "volume" },
                { label: "Issue",           zotero: "issue",          llmKey: "issue" },
                { label: "Pages",           zotero: "pages",          llmKey: "pages" },
                { label: "ISSN",            zotero: "ISSN",           llmKey: "issn" },
                { label: "URL",             zotero: "url",            llmKey: "url" },
            ],
        },
        newspaperArticle: {
            label: "Newspaper Article",
            fields: [
                { label: "Title",           zotero: "title",          llmKey: "title" },
                { label: "Author(s)",       zotero: "creators",      llmKey: "authors",       isCreator: true, creatorType: "author" },
                { label: "Date",            zotero: "date",           llmKey: "date" },
                { label: "Publication",     zotero: "publicationTitle", llmKey: "publicationTitle" },
                { label: "Edition",         zotero: "edition",        llmKey: "edition" },
                { label: "Section",         zotero: "section",        llmKey: "section" },
                { label: "Pages",           zotero: "pages",          llmKey: "pages" },
                { label: "ISSN",            zotero: "ISSN",           llmKey: "issn" },
                { label: "URL",             zotero: "url",            llmKey: "url" },
            ],
        },
        patent: {
            label: "Patent",
            fields: [
                { label: "Title",           zotero: "title",          llmKey: "title" },
                { label: "Inventor(s)",     zotero: "creators",      llmKey: "inventors",     isCreator: true, creatorType: "inventor" },
                { label: "Date",            zotero: "date",           llmKey: "date" },
                { label: "Issuing Authority", zotero: "issuingAuthority", llmKey: "issuingAuthority" },
                { label: "Patent Number",   zotero: "patentNumber",   llmKey: "patentNumber" },
                { label: "Application Number", zotero: "applicationNumber", llmKey: "applicationNumber" },
                { label: "Abstract",        zotero: "abstractNote",   llmKey: "abstract" },
                { label: "URL",             zotero: "url",            llmKey: "url" },
            ],
        },
        document: {
            label: "Document",
            fields: [
                { label: "Title",           zotero: "title",          llmKey: "title" },
                { label: "Author(s)",       zotero: "creators",      llmKey: "authors",       isCreator: true, creatorType: "author" },
                { label: "Date",            zotero: "date",           llmKey: "date" },
                { label: "Publisher",       zotero: "publisher",      llmKey: "publisher" },
                { label: "Abstract",        zotero: "abstractNote",   llmKey: "abstract" },
                { label: "Language",        zotero: "language",       llmKey: "language" },
                { label: "URL",             zotero: "url",            llmKey: "url" },
            ],
        },
    },

    // ── Helpers ────────────────────────────────────────────────

    /** Get sorted list of type keys */
    getTypeKeys() {
        return Object.keys(this.types).sort((a, b) =>
            this.types[a].label.localeCompare(this.types[b].label)
        );
    },

    /** Return fields for a given item type key */
    getFieldsForType(typeKey) {
        return this.types[typeKey]?.fields || [];
    },

    /** Given a Zotero item, determine our type key (or null if unsupported) */
    getTypeKeyForItem(item) {
        const zt = Zotero.ItemTypes.getName(item.itemTypeID);
        return this.types[zt] ? zt : null;
    },

    /**
     * Check whether a field is "missing" on an item.
     * For creator fields, checks if any creator of that type exists.
     * For regular fields, checks empty/whitespace-only.
     */
    isFieldMissing(item, fieldDef) {
        if (fieldDef.isCreator) {
            const creators = item.getCreators();
            return !creators.some(
                (c) => c.creatorType === Zotero.CreatorTypes.getName(c.creatorTypeID)
                    ? Zotero.CreatorTypes.getName(c.creatorTypeID) === fieldDef.creatorType
                    : false
            );
        }
        try {
            const val = item.getField(fieldDef.zotero);
            return !val || !val.toString().trim();
        } catch (e) {
            // Field doesn't exist for this item type — treat as not applicable
            return false;
        }
    },

    /**
     * For a given item, filter a list of field defs down to only those
     * whose isCreator status matches and that check via getCreators properly.
     */
    isFieldMissingFull(item, fieldDef) {
        if (fieldDef.isCreator) {
            const creators = item.getCreators();
            return !creators.some((c) => {
                const typeName = Zotero.CreatorTypes.getName(c.creatorTypeID);
                return typeName === fieldDef.creatorType;
            });
        }
        try {
            const val = item.getField(fieldDef.zotero);
            return !val || !val.toString().trim();
        } catch (e) {
            return false;
        }
    },
};
