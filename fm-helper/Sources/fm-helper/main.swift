// fm-helper — a one-shot CLI that bridges the Zotero Metadata Filler plugin
// to Apple's on-device FoundationModels framework.
//
// Wire protocol (intentionally provider-agnostic — the plugin's existing
// _parseResponse handles JSON-from-text, markdown fences, aliases, and URL
// stripping, so we don't bind to its dynamic field schema here):
//
//   $ fm-helper <inFile> <outFile>
//
//   inFile (UTF-8 JSON):
//     {
//       "instructions": "<system prompt>",
//       "prompt":       "<user content>",
//       "temperature":  0.1,        // optional
//       "maxTokens":    2048,       // optional, advisory only
//       "model":        "..."       // optional, ignored (single on-device model)
//     }
//
//   outFile (UTF-8 JSON):
//     {"text": "..."}                          // success, exit 0
//     {"error": "...", "code": "..."}          // failure, exit 1
//
// Errors that should be visible to the user (model unavailable, Apple
// Intelligence not enabled, guardrail violation) get a stable `code` so the
// plugin can surface a tailored message later if it wants. Today the plugin
// just prints the `error` field.

import Foundation
import FoundationModels

struct Request: Decodable {
    let instructions: String?
    let prompt: String
    let temperature: Double?
    let maxTokens: Int?
    let model: String?
}

struct SuccessOut: Encodable { let text: String }
struct ErrorOut: Encodable {
    let error: String
    let code: String
}

@main
struct Main {
    static func main() async {
        let args = CommandLine.arguments
        guard args.count == 3 else {
            FileHandle.standardError.write(Data(
                "usage: fm-helper <inFile> <outFile>\n".utf8))
            exit(2)
        }
        let inPath = args[1]
        let outPath = args[2]

        do {
            let inData = try Data(contentsOf: URL(fileURLWithPath: inPath))
            let req = try JSONDecoder().decode(Request.self, from: inData)

            // 1. Availability check. Surface the reason verbatim — debugging
            // "model unavailable" without knowing why is awful.
            switch SystemLanguageModel.default.availability {
            case .available:
                break
            case .unavailable(let reason):
                try writeError(outPath,
                    code: "model-unavailable",
                    message: "On-device model unavailable: \(reason). " +
                        "Enable Apple Intelligence in System Settings and " +
                        "wait for the model to download.")
                exit(1)
            }

            // 2. Build a session. Instructions are the system prompt;
            // they're per-session, so we make a fresh session per call.
            let session = LanguageModelSession(
                instructions: req.instructions ?? ""
            )

            // 3. Generate. We use the *unguided* respond(to:) call so the
            // plugin's existing JSON parser stays in charge of the schema.
            // Guided generation (@Generable) would be more reliable but
            // would require this binary to know the plugin's per-item
            // field list, which we'd rather not couple.
            //
            // GenerationOptions lets us pass temperature/maxTokens through.
            // Apple may rename these knobs in future macOS releases — if
            // you hit a "no overload" build error, drop the property that
            // changed and ship.
            var options = GenerationOptions()
            if let t = req.temperature { options.temperature = t }
            if let m = req.maxTokens   { options.maximumResponseTokens = m }

            let response: LanguageModelSession.Response<String>
            do {
                response = try await session.respond(
                    to: req.prompt,
                    options: options
                )
            } catch let e as LanguageModelSession.GenerationError {
                // Map the well-known cases to stable codes. The plugin can
                // pattern-match on these later if it wants tailored UI.
                let (code, msg) = mapGenerationError(e)
                try writeError(outPath, code: code, message: msg)
                exit(1)
            }

            try writeSuccess(outPath, text: response.content)
            exit(0)
        } catch {
            // Any other failure (bad JSON, IO error, etc.) — write what we
            // can and exit non-zero.
            do {
                try writeError(outPath,
                    code: "internal-error",
                    message: "\(error)")
            } catch {
                FileHandle.standardError.write(Data("\(error)\n".utf8))
            }
            exit(1)
        }
    }

    static func writeSuccess(_ path: String, text: String) throws {
        let enc = JSONEncoder()
        let data = try enc.encode(SuccessOut(text: text))
        try data.write(to: URL(fileURLWithPath: path), options: .atomic)
    }

    static func writeError(_ path: String, code: String, message: String) throws {
        let enc = JSONEncoder()
        let data = try enc.encode(ErrorOut(error: message, code: code))
        try data.write(to: URL(fileURLWithPath: path), options: .atomic)
    }

    static func mapGenerationError(_ e: LanguageModelSession.GenerationError) -> (String, String) {
        let desc = String(describing: e)
        // Use a substring check rather than exhaustive case matching so
        // this keeps compiling if Apple adds new cases in macOS updates.
        if desc.contains("guardrailViolation") {
            return ("guardrail",
                "Apple Intelligence guardrail blocked this content. Try a smaller excerpt or a different item.")
        }
        if desc.contains("exceededContextWindow") {
            return ("context-window",
                "Input + expected output exceed the on-device model's context window (~4K tokens). Reduce page count or trim the prompt.")
        }
        return ("generation-failed", desc)
    }
}
