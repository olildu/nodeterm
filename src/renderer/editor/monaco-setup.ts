import * as monaco from 'monaco-editor'
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker'
import JsonWorker from 'monaco-editor/language/json/json.worker.js?worker'
import CssWorker from 'monaco-editor/language/css/css.worker.js?worker'
import HtmlWorker from 'monaco-editor/language/html/html.worker.js?worker'
import TsWorker from 'monaco-editor/language/typescript/ts.worker.js?worker'
import { createTsWorkerReaper } from './tsWorkerReaper'

// Bundle Monaco's language workers locally (no CDN) so it works offline in Electron.
// The un-prefixed paths are monaco >= 0.56 'exports' entries ("./*" -> "./esm/vs/*.js");
// the old monaco-editor/esm/vs/... deep paths double-prefix under that map and fail to resolve.
self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === 'json') return new JsonWorker()
    if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker()
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new HtmlWorker()
    if (label === 'typescript' || label === 'javascript') return new TsWorker()
    return new EditorWorker()
  }
}

// The TS/JS worker never idles out on its own: stop it once the last
// TS/JS model is gone. `monaco.typescript` is the 0.57 namespace; `monaco.languages.typescript`
// is a deprecated stub there. See tsWorkerReaper.ts for the mechanism and the grace period.
const tsDefaults = {
  typescript: monaco.typescript.typescriptDefaults,
  javascript: monaco.typescript.javascriptDefaults
} as const
const tsWorkerReaper = createTsWorkerReaper({
  liveLanguageIds: () => monaco.editor.getModels().map((m) => m.getLanguageId()),
  stopWorker: (language) => {
    const defaults = tsDefaults[language]
    defaults.setCompilerOptions(defaults.getCompilerOptions())
  }
})
// Models created before this ran (none today: this module is what loads Monaco) would be missed;
// seed from the live list so the reaper never under-counts.
for (const model of monaco.editor.getModels()) tsWorkerReaper.modelEntered(model.getLanguageId())
monaco.editor.onDidCreateModel((model) => tsWorkerReaper.modelEntered(model.getLanguageId()))
monaco.editor.onWillDisposeModel((model) => tsWorkerReaper.modelLeft(model.getLanguageId()))
monaco.editor.onDidChangeModelLanguage(({ model, oldLanguage }) => {
  tsWorkerReaper.modelLeft(oldLanguage)
  tsWorkerReaper.modelEntered(model.getLanguageId())
})

export { monaco }
