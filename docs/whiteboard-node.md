# Whiteboard nodes

A **whiteboard** is a canvas node holding an infinite drawing board, for sketching an idea during a
call or a screenshare: freehand pen, shapes, arrows that stay attached to what they point at, text,
pasted images, undo and export. It embeds [Excalidraw](https://github.com/excalidraw/excalidraw)
(`@excalidraw/excalidraw`, MIT) rather than reimplementing one.

Add one from right-click → **New view → New whiteboard**, the sessions-sidebar "+", the Dock, or
⌘K "New whiteboard" (`node.newWhiteboard`, unbound by default). A new board opens ready to draw.
Double-click (or Enter on) a board to draw on it again; Esc or a click outside finishes — once the
board is saved (see "When a save does not land" below). The header
has **Present** (maximize + Excalidraw's zen mode, restored on Esc) and **Copy as image** (the board
as a PNG on the clipboard). Its default size is a Settings → Behavior → Default node size entry.

## Editing happens in an overlay, not in the node

React Flow scales every node with `transform: scale(zoom)`. Excalidraw sizes its canvas and maps
the pointer from `getBoundingClientRect()`, so inside a scaled node it draws away from the pointer
and its bitmap goes soft. So at rest the node shows a **picture** of the board, and editing mounts
**one** live Excalidraw portaled into `.canvas-root` — outside `.flow-wrap` — laid exactly over the
node's on-screen box (`nodes/WhiteboardNode.tsx`). That also keeps it away from the canvas's
capture-phase wheel listener on `.flow-wrap` (⌘-wheel and pinch always zoom the canvas, even over
`.nowheel`) and from xyflow's middle-button pan. The overlay:

- follows the box as the canvas pans/zooms and the node moves, resizes or maximizes, and calls
  Excalidraw's `refresh()` when it does (Excalidraw caches its offsets otherwise);
- runs Excalidraw at `boardZoom × canvasZoom` (`whiteboard/zoom.ts`), so the drawing scales with the
  canvas like every other node — and stays sharp, since Excalidraw redraws at the real size. The
  file stores only the board zoom;
- is clipped to the canvas area and stacked at z 10, under the sessions sidebar (12) and Dock (20);
- treats a press on the node's own frame (header, Maximize, title) as staying in the board.
- keeps its events out of the node. A portal leaves the node's DOM but not its React tree, so
  React bubbled the editor's events into React Flow's node wrapper: a right-click opened the node
  menu over Excalidraw's own, an arrow key nudging a shape also moved the node (and every other
  selected node), and a double-click (Excalidraw's "add text") flew the camera to the node. The
  portal root stops click, double-click and context-menu, and only the keys the wrapper acts on
  (arrows, Enter, Space, Escape): stopping a React event also stops the native one at the React
  root, so every other key still reaches document and window listeners.

Only one editor is ever mounted, and it unmounts when editing ends — Excalidraw keeps some state
module-global, and one live instance costs ~3 MB the first time. Measured: no heap growth over five
open/close cycles, no running animations open or closed.

## The keyboard belongs to the board while it is open

Excalidraw's focused element is a plain `<div>`, which no "is this a text field" check recognises,
so canvas commands fired over it: Space panned the whole canvas (verified in the dev build),
Delete/⌘Z/⌘[ reached canvas commands. The overlay carries `data-nt-keyboard-owner`; the shared
check `isKeyboardOwnerTarget` (`lib/keyContext.ts`) makes every typing-aware site stand down for
it: the dispatcher's `isTypingTarget`, Space-to-pan, pane-focus release, the zoom shortcuts and the
copy gesture. Esc is caught in the capture phase (Excalidraw does not let it bubble) and ends
editing only when Excalidraw has nothing of its own to cancel. ⌘0 stays with the canvas: main
claims it before the page.

## Storage: a side file addressed by node id

The drawing is **not** in node data — a board with a pasted screenshot is megabytes, and node data
rides the 800 ms whole-workspace save (one ≤8 MiB Server Edition frame), the 256 KB-per-node
team-sync cap, 100 canvas-undo snapshots and the phone mirror. `core/whiteboards.ts` writes:

    <cwd>/.nodeterm/whiteboards/<nodeId>.excalidraw   + <nodeId>.png (the resting picture)

falling back to `<userData>/whiteboards/` for a cwd-less canvas, an SSH project and a deleted or
read-only project folder (the `canvas-images.ts` rules). Writes are atomic (`writeFileAtomic`; the
PNG through `tempNameFor` + `renameAtomic`, since `writeFileAtomic` writes text).

A folder project whose canvas is kept in app data (issue #1145) writes nothing into its folder: its
boards go to the same layout under its own app-data root,
`<userData>/project-files/<projectId>/.nodeterm/whiteboards/`, which is deleted with the project
(`WorkspaceStore.whiteboardLocationForProject`, wired into both shells as `whiteboardLocation`). Not
the shared `<userData>/whiteboards/`: that folder is keyed by node id, and two folders holding the
same committed canvas share node ids, so two such projects would read and overwrite each other's
boards. The folder's boards, drawn before the move, are read after every place a save can land and
never written, so a board still opens after the move and its next save lands in app data. A move
back into the folder first copies the app-data boards over the folder's older files
(`carryWhiteboards`), since the folder is read first again; a folder project reads its app-data
root after its folder for a board that did not copy.

**The core derives the path from (project, node id); it never accepts one.** Node data comes from
the git-shared `project.json`, which anyone with commit access can edit — a path taken from it
could aim a read or an overwrite anywhere. A node id must be a `string` passing `isSafeNodeId`
(the regex alone would accept a number). Node data carries only:

- `whiteboardSource` — the board a **duplicate or reopen** (which get new ids) reads until it saves
  its own. No file is ever copied, and none is deleted when a node is, so undo and ⇧⌘T always find
  the drawing. Re-validated on load like every hand-editable field.
- `boardRev` — epoch ms, bumped once per editing session that changed the board (never per
  stroke), so strokes never reach the workspace save, canvas undo or team sync.

Saves happen 1.5 s after the last change, when editing ends (with the picture), on unmount
(project switch, node closed), and — on the desktop — when the app quits or restarts to update: an
open editor registers its pending save with `lib/quitFlush.ts`, which Canvas's answer to main's
flush request waits for (main caps that wait at ~1 s). A browser tab of the Server Edition has no
such request, so closing it can lose the last ≤1.5 s of strokes. Whether there is anything to save is decided by comparing the
scene's version with the one this editor last saved, not by an `onChange` flag; the unmount flush
writes a snapshot kept from `onChange`, because by cleanup time Excalidraw's api answers an empty
scene. A board whose file does not parse is shown as unreadable and never opened, so an autosave
cannot overwrite it.

**Every save is a compare-and-set against the file on disk.** A board can be open in two places:
two Server Edition tabs, the desktop and a browser on one folder, two Editors of a hosted team, or
a `git pull` that rewrites the file while it is open. Each read returns the scene file's revision
(`rev`: `dev:ino:size:mtimeNs` of the descriptor read — every writer publishes by rename, so it
changes on every write, also on a coarse-mtime filesystem), the editor sends the revision it last
read or wrote with every save (`null` when the node has no board of its own yet — a new board, or a
copy still showing its source), and the core refuses a save whose revision is not the one on disk.
Nothing is written then, and the header says **Changed elsewhere**: the other version was kept.
Saves of one board are serialized inside one core, so two saves racing there cannot both pass the
check; two cores writing one folder (a desktop and a Server Edition) can still interleave in the
moment between the check and the rename. A core on an older build ignores the revision and answers
the bare path, and the save is then unchecked, as before.

**When a save does not land, the board stays open.** Finishing (Esc, a press outside) waits for a
save that succeeded; a failed or refused one keeps the editor open, because once editing ends the
unsaved strokes have nowhere to go. The header says why — **Not saved** (the save could not be
written: a full disk, a board over the Server Edition's 8 MiB frame, a core that went away) or
**Changed elsewhere** (above) — and offers the way forward: **Keep mine** after a conflict saves
over the other version knowingly (it sends that version's revision), and **Discard my changes**
ends editing without the unsaved strokes, leaving the board on disk as it is. A project switch or
deleting the node still flushes what it can on the way out; a failure there is not reported.

**A hosted-team Viewer or Commenter opens the board view-only** (Excalidraw's view mode): the host
refuses their saves, so the editor never offers drawing that cannot be written.

**The project folder is bound by its real path.** `.nodeterm/` is git-shared, so a repository can
commit `.nodeterm` or `.nodeterm/whiteboards` as a symlink to any directory on this machine. Each
existing component is resolved before anything is created through it and must stay inside the
project's real root; a link that leads out (or dangles) means the project folder is not used — a
save lands in the app folder, a read does not look there. A link that stays inside the project is
followed.

The two channels (`files.saveWhiteboard`, `files.readWhiteboard`) are registered in core for both
shells and classified in both relay policies exactly like a canvas image (save: editors only;
both scoped to the shared project).

## Bundle and assets

- Excalidraw is a renderer-only **devDependency**, loaded with `React.lazy` the first time a board
  is opened: its JS (~1.7 MB) and CSS (~145 KB) are their own chunks, never in `boot`.
- **Fonts are served locally** by `scripts/excalidraw-assets-plugin.ts`: Excalidraw fetches
  `${EXCALIDRAW_ASSET_PATH}fonts/<Family>/<file>.woff2` by exact path (default: a CDN, blocked by
  the CSP and absent offline). The plugin serves `dist/prod/fonts` in dev and emits it under
  `excalidraw-assets/` in builds, without Xiaolai (the 12 MB CJK family; CJK text falls back to a
  system font). ~480 KB.
- **Export under the app's CSP (measured, headless Chrome over http, Excalidraw 0.18.1 built by
  this repo's Vite, the exact `index.html` policy):** SVG and PNG export both work, with Workers and
  with Workers unavailable, and the SVG embeds its font. Two things the console shows are expected:
  one `script-src 'eval'` violation — `script-src 'self'` refuses the WebAssembly Excalidraw uses to
  SUBSET fonts, so it embeds the unsubset font file (~33 KB for Latin text: a bigger SVG, not a
  broken one) — and a `font-src` violation per font face for Excalidraw's own CDN (esm.sh), which it
  tries besides the local file; the CDN is blocked and the local font is the one that loads. The
  CSP is deliberately not widened for either. Not run: the packaged desktop app over `file://`.
- `@excalidraw/mermaid-to-excalidraw` is **aliased to a stub** (`whiteboard/mermaid-stub.ts`): it
  pulls in all of mermaid for "text to diagram", ~10 MB of chunks (renderer output 48 MB → 38 MB).
  A pasted mermaid definition falls back to plain text.
- Scoped `overrides` under `@excalidraw/excalidraw` (nanoid, sass, lodash-es, katex, mermaid,
  @mermaid-js/parser) clear the 14 advisories 0.18.1 brings in; without them Dependency review fails.

## Not in this version

Live multi-user drawing (team sync is whole-node, last writer wins), agents reading a linked board
(a follow-up), kanban cards (CLAUDE.md: non-session kinds are not cards), and Excalidraw's own
open/save-file actions (they fail in Electron; saving is ours).
