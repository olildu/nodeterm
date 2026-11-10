// Stands in for `@excalidraw/mermaid-to-excalidraw` (aliased in electron.vite.config.ts).
//
// Excalidraw imports it lazily for "text to diagram" and for pasting text that looks like a
// mermaid definition. The real package pulls in mermaid and its diagram engines: ~7.3 MB of
// chunks in every download, for a feature a sketching board does not need. Rejecting here makes
// a mermaid-looking paste fall back to plain text; the dialog's entry is hidden in the editor.
export async function parseMermaidToExcalidraw(): Promise<never> {
  throw new Error('Text to diagram is not available in nodeterm')
}
