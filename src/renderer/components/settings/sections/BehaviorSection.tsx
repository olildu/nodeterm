import { useState } from 'react'
import { useSettings } from '../../../state/settings'
import { SettingsSection } from '../SettingsSection'
import { SearchableRow } from '../SearchableRow'
import { FieldRow } from '../FieldRow'
import { Switch } from '@renderer/ui/Switch'
import { NumberField } from '@renderer/ui/NumberField'
import { Select } from '@renderer/ui/Select'
import { SegmentedPill } from '@renderer/ui/SegmentedPill'
import { Input } from '@renderer/ui/Input'
import { hintLabel, isMacPlatform, isWindowsPlatform } from '@shared/platform-utils'
import { trackpadRoutingSupported } from '@renderer/canvas/wheel-gesture'
import { isBrowserRuntime } from '@renderer/bridge/runtime'
import { backgroundCloseDescription, backgroundCloseRowVisible } from '@renderer/lib/backgroundClose'
import type { BackgroundOnCloseSetting } from '@shared/types'
import { clampWheelZoomSpeed } from '@renderer/canvas/wheel-zoom'
import { DEFAULT_WORKTREE_PATH_TEMPLATE } from '@shared/worktree'
import { resolveTidyLayout } from '@shared/types'
import { resolveNewNodeSize } from '@shared/new-node-size'
import type { NewProjectStorage } from '@shared/project-storage'
import { Button } from '@renderer/ui/Button'
import type { NodeSize } from '@shared/default-node-size'
import {
  NODE_SIZE_CHOICES,
  NODE_SIZE_CHOICE_LABELS,
  nodeSizeField,
  nodeSizePatch,
  nodeSizeResetPatch,
  type NodeSizeChoice
} from '@renderer/lib/defaultNodeSizeSetting'

const ROWS = {
  defaultView: {
    title: 'Default view',
    keywords: ['default', 'view', 'kanban', 'board', 'canvas', 'project']
  },
  omniKanban: {
    title: 'Omni Kanban (global swimlanes)',
    keywords: ['omni', 'kanban', 'swimlane', 'global', 'overview', 'board', 'project']
  },
  omniKanbanDefault: {
    title: 'Omni as default for Cmd+Shift+B',
    keywords: ['omni', 'kanban', 'global', 'default', 'shortcut', 'cmd', 'shift', 'b']
  },
  gridSize: { title: 'Grid size', keywords: ['grid', 'size', 'snap'] },
  nodeSize: {
    title: 'Default node size',
    keywords: [
      'node', 'size', 'width', 'height', 'terminal', 'default', 'sticky', 'note', 'browser', 'web',
      'editor', 'diff', 'file', 'manager', 'video', 'simulator', 'trigger', 'dino'
    ]
  },
  matchLargest: {
    title: 'New nodes match the largest terminal',
    keywords: ['node', 'size', 'largest', 'biggest', 'match', 'terminal', 'new', 'default']
  },
  snap: { title: 'Snap to grid', keywords: ['snap', 'grid', 'align'] },
  autoAlign: {
    title: 'Snap to grid mode (auto-arrange)',
    keywords: ['snap', 'grid', 'align', 'arrange', 'auto', 'mode']
  },
  tidyLayout: {
    title: 'Tidy layout',
    keywords: ['tidy', 'layout', 'cross', 'arrange', 'order', 'grid']
  },
  panHover: { title: 'Pan-hover delay (ms)', keywords: ['pan', 'hover', 'delay', 'focus', 'guard'] },
  focusFollowsPointer: {
    title: 'Terminal focus follows pointer',
    keywords: ['focus', 'hover', 'pointer', 'click', 'follows', 'x11', 'sloppy', 'mouse', 'keyboard', 'terminal', 'mac']
  },
  doubleClick: { title: 'Double-click to focus', keywords: ['double', 'click', 'focus'] },
  focusZoom: {
    title: 'Zoom when going to a node',
    keywords: ['zoom', 'focus', 'go to', 'node', 'jump', 'camera', 'session', 'sidebar']
  },
  closeProjectOnLastSession: {
    title: 'Offer to close a project after its last session',
    keywords: ['close', 'project', 'last', 'session', 'node', 'tab', 'recently closed', 'cleanup', 'agent', 'terminal']
  },
  rememberLock: {
    title: 'Remember the canvas lock',
    keywords: ['lock', 'canvas', 'view', 'pan', 'zoom', 'freeze', 'remember', 'restart', 'persist']
  },
  openLinks: {
    title: 'Allow nodeterm:// links',
    keywords: ['link', 'url', 'scheme', 'deep link', 'nodeterm://', 'open', 'other apps', 'protocol', 'external']
  },
  mdPreview: {
    title: 'Open Markdown in preview',
    keywords: ['markdown', 'md', 'preview', 'render', 'editor', 'docs', 'readme', 'file']
  },
  sidebarCollapse: {
    title: 'Sidebar: collapse inactive by default',
    keywords: ['sidebar', 'sessions', 'collapse', 'expand', 'project', 'switch', 'group', 'tree']
  },
  sidebarGrouping: {
    title: 'Sidebar: group by',
    keywords: ['sidebar', 'sessions', 'group', 'status', 'project', 'attention']
  },
  projectStorage: {
    title: 'New folder projects store their canvas',
    keywords: ['project', 'storage', 'app data', 'nodeterm', 'folder', 'repo', 'project.json', 'git', 'client']
  },
  worktreePath: {
    title: 'Worktree path template',
    keywords: ['worktree', 'git', 'path', 'folder', 'repo', 'branch', 'template']
  },
  wheelZoom: { title: 'Scroll wheel zooms', keywords: ['zoom', 'wheel', 'scroll', 'mouse', 'pan'] },
  wheelZoomSpeed: {
    title: 'Wheel zoom speed',
    keywords: ['zoom', 'wheel', 'speed', 'sensitivity', 'step', 'jump', 'mouse', 'scroll']
  },
  trackpadPan: {
    title: 'Trackpad scroll pans',
    keywords: ['trackpad', 'pan', 'scroll', 'zoom', 'magic', 'mouse', 'two-finger', 'macos', 'windows', 'touchpad']
  },
  dragMode: {
    title: 'Canvas left-drag',
    keywords: ['pan', 'drag', 'select', 'canvas', 'mouse', 'grab', 'figma', 'miro']
  },
  browserSaver: {
    title: 'Browser memory saver',
    keywords: ['browser', 'memory', 'saver', 'ram', 'webview', 'discard', 'page', 'web']
  },
  keepAwake: {
    title: 'Keep awake while agents work',
    keywords: ['sleep', 'awake', 'power', 'battery', 'suspend', 'run', 'lid', 'thermal', 'heat']
  },
  confirmQuit: {
    title: 'Confirm before quitting',
    keywords: ['quit', 'exit', 'close', 'confirm', 'dialog', 'ask']
  },
  backgroundClose: {
    title: 'Keep running when the window closes',
    keywords: ['tray', 'background', 'close', 'minimize', 'notification area', 'system tray', 'quit', 'phone']
  }
}
// The background-close row only exists for a desktop window off macOS, so search must not offer
// it anywhere else. Decided once: neither the platform nor the runtime changes under a live page.
const SHOW_BACKGROUND_CLOSE = backgroundCloseRowVisible(isMacPlatform(), isBrowserRuntime())
// nodeterm:// links are a desktop OS URL scheme: the Server Edition registers none and its bridge
// stub refuses every link, so the switch would do nothing in a browser tab.
const SHOW_OPEN_LINKS = !isBrowserRuntime()
const ENTRIES = Object.values(ROWS).filter(
  (r) => (SHOW_BACKGROUND_CLOSE || r !== ROWS.backgroundClose) && (SHOW_OPEN_LINKS || r !== ROWS.openLinks)
)

export function BehaviorSection({ isActive }: { isActive: boolean }): React.JSX.Element {
  const settings = useSettings((s) => s.settings)
  const update = useSettings((s) => s.update)
  return (
    <SettingsSection id="behavior" title="Behavior" isActive={isActive} searchEntries={ENTRIES}>
      <SearchableRow {...ROWS.defaultView}>
        <FieldRow
          label="Default view"
          description="How a project opens when you haven't switched it. Projects you toggle keep their own choice."
          control={
            <Select
              aria-label="Default view"
              value={settings.defaultProjectView === 'kanban' ? 'kanban' : 'canvas'}
              onChange={(e) => update({ defaultProjectView: e.target.value as 'canvas' | 'kanban' })}
            >
              <option value="canvas">Canvas</option>
              <option value="kanban">Kanban board</option>
            </Select>
          }
        />
      </SearchableRow>
      <SearchableRow {...ROWS.omniKanban}>
        <FieldRow
          label="Omni Kanban (global swimlanes)"
          description="When enabled, the global Kanban overview is available via its dedicated shortcut (Settings → Keyboard Shortcuts → Toggle global kanban). Default OFF — existing users see no change."
          control={
            <Switch
              checked={settings.omniKanbanEnabled === true}
              onChange={(v) => update({ omniKanbanEnabled: v })}
              ariaLabel="Omni Kanban"
            />
          }
        />
      </SearchableRow>
      <SearchableRow {...ROWS.omniKanbanDefault}>
        <FieldRow
          label="Make Omni the default for Cmd+Shift+B"
          description="When enabled, Cmd+Shift+B opens the global overview instead of the per-project board. The dedicated global shortcut always opens Omni regardless. Opt-in, per user."
          control={
            <Switch
              checked={settings.omniKanbanAsDefault === true}
              onChange={(v) => update({ omniKanbanAsDefault: v })}
              ariaLabel="Omni as default"
            />
          }
        />
      </SearchableRow>
      <SearchableRow {...ROWS.gridSize}>
        <FieldRow
          label="Grid size"
          control={
            <NumberField
              value={settings.gridSize}
              min={8}
              max={96}
              onChange={(v) => update({ gridSize: v || 24 })}
            />
          }
        />
      </SearchableRow>
      <SearchableRow {...ROWS.nodeSize}>
        <DefaultNodeSizeRow />
      </SearchableRow>
      <SearchableRow {...ROWS.matchLargest}>
        <FieldRow
          label="New nodes match the largest terminal"
          description="A new terminal or agent node opens at the size of the largest one on the canvas (a maximized node counts at its normal size). With none open, the default size above applies."
          control={
            <Switch
              checked={resolveNewNodeSize(settings.newNodeSize) === 'matchLargest'}
              onChange={(v) => update({ newNodeSize: v ? 'matchLargest' : 'default' })}
              ariaLabel="New nodes match the largest terminal"
            />
          }
        />
      </SearchableRow>
      <SearchableRow {...ROWS.snap}>
        <FieldRow
          label="Snap to grid"
          control={
            <Switch
              checked={settings.snapToGrid}
              onChange={(v) => update({ snapToGrid: v })}
              ariaLabel="Snap to grid"
            />
          }
        />
      </SearchableRow>
      <SearchableRow {...ROWS.autoAlign}>
        <FieldRow
          label="Snap to grid mode"
          description="Arranges every node to the grid at the moment you turn it on — like a desktop “Auto arrange”. Distinct from the drag-snap toggle above, which only constrains dragging."
          control={
            <Switch
              checked={settings.autoAlignGrid}
              onChange={(v) => update({ autoAlignGrid: v })}
              ariaLabel="Snap to grid mode"
            />
          }
        />
      </SearchableRow>
      <SearchableRow {...ROWS.tidyLayout}>
        <FieldRow
          label="Tidy layout"
          description="Cmd+Shift+A arranges up to 5 terminals (Claude and other agent sessions included) as a cross: a row of three, one above the middle, one below. Each node takes the slot nearest to where it is, so drag a node where you want it and press the shortcut. New nodes fill the free slot and the nearest node fills a closed one. Notes, browsers, editors and group frames are left where they are. More than 5 terminals use the normal grid."
          control={
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{ opacity: 0.6 }}>Cross (up to 5 nodes)</span>
              <Switch
                checked={resolveTidyLayout(settings.tidyLayout) === 'cross'}
                onChange={(v) => update({ tidyLayout: v ? 'cross' : 'auto' })}
                ariaLabel="Cross (up to 5 nodes)"
              />
            </div>
          }
        />
      </SearchableRow>
      <SearchableRow {...ROWS.focusFollowsPointer}>
        <FieldRow
          label="Terminal focus follows pointer"
          description={
            settings.terminalFocusFollowsPointer
              ? 'On: hovering a terminal for the pan-hover delay gives it the keyboard. It keeps the keyboard when the pointer moves off — until you hover another terminal, or click another node, the empty canvas or a field. Turn off for click to focus.'
              : 'Off (click to focus): click a terminal to type in it. It keeps the keyboard until you click another node, the empty canvas or a field — moving the pointer away changes nothing.'
          }
          control={
            <Switch
              checked={settings.terminalFocusFollowsPointer}
              onChange={(v) => update({ terminalFocusFollowsPointer: v })}
              ariaLabel="Terminal focus follows pointer"
            />
          }
        />
      </SearchableRow>
      <SearchableRow {...ROWS.panHover}>
        <FieldRow
          label="Pan-hover delay (ms)"
          description={
            settings.terminalFocusFollowsPointer
              ? undefined
              : 'Not used in click-to-focus mode (Terminal focus follows pointer is off): hovering never takes the keyboard.'
          }
          control={
            <NumberField
              value={settings.panHoverDelay}
              min={0}
              max={2000}
              step={50}
              onChange={(v) => update({ panHoverDelay: v || 0 })}
            />
          }
        />
      </SearchableRow>
      <SearchableRow {...ROWS.doubleClick}>
        <FieldRow
          label="Double-click to focus"
          control={
            <Switch
              checked={settings.doubleClickFocus}
              onChange={(v) => update({ doubleClickFocus: v })}
              ariaLabel="Double-click to focus"
            />
          }
        />
      </SearchableRow>
      <SearchableRow {...ROWS.focusZoom}>
        <FieldRow
          label="Zoom when going to a node"
          description="Off: going to a node keeps your current zoom and only pans to it."
          control={
            <Switch
              checked={settings.focusZoomToNode}
              onChange={(v) => update({ focusZoomToNode: v })}
              ariaLabel="Zoom when going to a node"
            />
          }
        />
      </SearchableRow>
      <SearchableRow {...ROWS.closeProjectOnLastSession}>
        <FieldRow
          label="Offer to close a project after its last session"
          description="When you close the last terminal or agent node in a project with ×, ask whether to close the project too. It stays reopenable from Recently closed."
          control={
            <Switch
              checked={settings.offerCloseProjectOnLastSession}
              onChange={(v) => update({ offerCloseProjectOnLastSession: v })}
              ariaLabel="Offer to close a project after its last session"
            />
          }
        />
      </SearchableRow>
      <SearchableRow {...ROWS.rememberLock}>
        <FieldRow
          label="Remember the canvas lock"
          description="The bottom-left lock stays on across restarts until you turn it off. Off: every launch starts unlocked."
          control={
            <Switch
              checked={settings.rememberCanvasLock}
              onChange={(v) => update({ rememberCanvasLock: v })}
              ariaLabel="Remember the canvas lock"
            />
          }
        />
      </SearchableRow>
      {SHOW_OPEN_LINKS && (
        <SearchableRow {...ROWS.openLinks}>
          <FieldRow
            label="Allow nodeterm:// links"
            description="Lets other apps, scripts and web pages ask nodeterm to open one agent or terminal node, or pre-fill a pairing code. Every link shows a confirm sheet first and opens nothing until you click Open. Off: links are ignored."
            control={
              <Switch
                checked={settings.allowOpenLinks}
                onChange={(v) => update({ allowOpenLinks: v })}
                ariaLabel="Allow nodeterm:// links"
              />
            }
          />
        </SearchableRow>
      )}
      <SearchableRow {...ROWS.mdPreview}>
        <FieldRow
          label="Open Markdown in preview"
          description="Markdown files open rendered instead of as editable text. The node's Preview/Edit toggle still switches either way."
          control={
            <Switch
              checked={settings.openMarkdownPreview}
              onChange={(v) => update({ openMarkdownPreview: v })}
              ariaLabel="Open Markdown in preview"
            />
          }
        />
      </SearchableRow>
      <SearchableRow {...ROWS.sidebarCollapse}>
        <FieldRow
          label="Sidebar: collapse inactive by default"
          description="Projects without an explicit choice start collapsed when inactive. Your project and group chevron choices are remembered."
          control={
            <Switch
              checked={settings.sidebarAutoCollapse}
              onChange={(v) => update({ sidebarAutoCollapse: v })}
              ariaLabel="Sidebar: collapse inactive by default"
            />
          }
        />
      </SearchableRow>
      <SearchableRow {...ROWS.sidebarGrouping}>
        <FieldRow
          label="Sidebar: group sessions by"
          description="Group the sessions sidebar by project (the default) or by live status, so sessions needing attention float to the top across all projects. Status reflects local-core sessions; remote sessions show as idle."
          control={
            <SegmentedPill<'project' | 'status'>
              value={settings.sidebarGrouping}
              ariaLabel="Group sessions by"
              options={[
                { value: 'project', label: 'Project' },
                { value: 'status', label: 'Status' }
              ]}
              onChange={(v) => update({ sidebarGrouping: v })}
            />
          }
        />
      </SearchableRow>
      <SearchableRow {...ROWS.projectStorage}>
        <FieldRow
          label="New folder projects store their canvas"
          description="In the folder writes .nodeterm/project.json there, to share through git. In app data writes nothing into the folder. A folder that already has a project.json opens as it is. Move an existing project from its tab menu."
          control={
            <Select
              aria-label="New folder projects store their canvas"
              value={settings.newProjectStorage}
              onChange={(e) => update({ newProjectStorage: e.target.value as NewProjectStorage })}
            >
              <option value="folder">In the folder</option>
              <option value="appData">In app data</option>
            </Select>
          }
        />
      </SearchableRow>
      <SearchableRow {...ROWS.worktreePath}>
        <FieldRow
          label="Worktree path template"
          description={
            'Resolved from the repository root. Supports $repoName (also $reponame or $defaultFolderName) and $branch; a missing branch is appended automatically.'
          }
          control={
            <Input
              className="w-80 font-mono"
              aria-label="Worktree path template"
              placeholder={DEFAULT_WORKTREE_PATH_TEMPLATE}
              value={settings.worktreePathTemplate}
              onChange={(e) => update({ worktreePathTemplate: e.target.value })}
            />
          }
        />
      </SearchableRow>
      <SearchableRow {...ROWS.wheelZoom}>
        <FieldRow
          label="Scroll wheel zooms"
          description={hintLabel('Zoom with a plain mouse wheel (no ⌘). Turns off scroll-to-pan — pan by dragging.')}
          control={
            <Switch
              checked={settings.wheelZoom}
              onChange={(v) => update({ wheelZoom: v })}
              ariaLabel="Scroll wheel zooms"
            />
          }
        />
      </SearchableRow>
      <div
        className={
          'mt-3 space-y-3 border-l border-border pl-4' +
          (settings.wheelZoom ? '' : ' pointer-events-none opacity-40')
        }
        aria-disabled={!settings.wheelZoom}
      >
        <SearchableRow {...ROWS.wheelZoomSpeed}>
          <FieldRow
            label="Wheel zoom speed"
            description="How far one wheel click zooms. Turn it down if a single click jumps too far (common on high-resolution wheels like the MX Master)."
            control={
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={0.2}
                  max={2}
                  step={0.1}
                  value={clampWheelZoomSpeed(settings.wheelZoomSpeed)}
                  aria-label="Wheel zoom speed"
                  onChange={(e) => update({ wheelZoomSpeed: Number(e.target.value) })}
                  className="w-40 accent-[var(--accent)]"
                />
                <span className="w-12 text-right text-[12px] text-muted tabular-nums">
                  {clampWheelZoomSpeed(settings.wheelZoomSpeed).toFixed(1)}×
                </span>
              </div>
            }
          />
        </SearchableRow>
      </div>
      {trackpadRoutingSupported({ mac: isMacPlatform(), windows: isWindowsPlatform() }) && (
        <SearchableRow {...ROWS.trackpadPan}>
          <FieldRow
            label="Trackpad scroll pans"
            description={hintLabel(
              'A two-finger trackpad scroll pans the canvas even with wheel zoom on, while a wheel mouse still zooms. The macOS desktop app tells mouse and trackpad apart directly; on Windows and in the browser (Server Edition) detection is heuristic — turn off if a smooth-scrolling mouse (Magic Mouse, MX) pans when you meant to zoom.'
            )}
            control={
              <Switch
                checked={settings.trackpadPan}
                onChange={(v) => update({ trackpadPan: v })}
                ariaLabel="Trackpad scroll pans"
              />
            }
          />
        </SearchableRow>
      )}
      <SearchableRow {...ROWS.dragMode}>
        <FieldRow
          label="Canvas left-drag"
          description="What dragging empty canvas does. Pan moves the map directly (box-select moves to Shift+drag); Select rubber-band selects, panning stays on middle-drag / two-finger scroll."
          control={
            <Select
              aria-label="Canvas left-drag"
              value={settings.canvasDragMode}
              onChange={(e) => update({ canvasDragMode: e.target.value as 'select' | 'pan' })}
            >
              <option value="select">Select (default)</option>
              <option value="pan">Pan the canvas</option>
            </Select>
          }
        />
      </SearchableRow>
      <SearchableRow {...ROWS.browserSaver}>
        <FieldRow
          label="Browser memory saver"
          description="Free a hidden browser page's memory after 5 minutes; it reloads when shown. Each page is a whole Chromium process."
          control={
            <Switch
              checked={settings.browserMemorySaver}
              onChange={(v) => update({ browserMemorySaver: v })}
              ariaLabel="Browser memory saver"
            />
          }
        />
      </SearchableRow>
      <SearchableRow {...ROWS.keepAwake}>
        <FieldRow
          label="Keep awake while agents work"
          description="Holds off idle sleep while a local agent is running. Lets the machine sleep on battery below 5% or when it runs critically hot. A closed lid still sleeps the machine, except on macOS when plugged in with an external display connected."
          control={
            <Switch
              checked={settings.keepAwakeWhileAgentsWork}
              onChange={(v) => update({ keepAwakeWhileAgentsWork: v })}
              ariaLabel="Keep awake while agents work"
            />
          }
        />
      </SearchableRow>
      <SearchableRow {...ROWS.confirmQuit}>
        <FieldRow
          label="Confirm before quitting"
          description="Ask before the app quits (⌘Q / Ctrl+Q or the title-bar close). Terminal sessions survive a quit either way."
          control={
            <Switch
              checked={settings.confirmBeforeQuit}
              onChange={(v) => update({ confirmBeforeQuit: v })}
              ariaLabel="Confirm before quitting"
            />
          }
        />
      </SearchableRow>
      {SHOW_BACKGROUND_CLOSE && (
        <SearchableRow {...ROWS.backgroundClose}>
          <FieldRow
            label="Keep running when the window closes"
            description={backgroundCloseDescription(isWindowsPlatform())}
            control={
              <Select
                aria-label="Keep running when the window closes"
                value={settings.runInBackgroundOnClose}
                onChange={(e) => update({ runInBackgroundOnClose: e.target.value as BackgroundOnCloseSetting })}
              >
                <option value="auto">Automatic</option>
                <option value="on">Always</option>
                <option value="off">Never (closing quits)</option>
              </Select>
            }
          />
        </SearchableRow>
      )}
    </SettingsSection>
  )
}

/**
 * One width × height pair for whichever kind the picker names. New nodes of that kind open at it;
 * existing nodes keep their size. The model (and why terminal is special) is in
 * lib/defaultNodeSizeSetting.ts.
 */
function DefaultNodeSizeRow(): React.JSX.Element {
  const settings = useSettings((s) => s.settings)
  const update = useSettings((s) => s.update)
  const [choice, setChoice] = useState<NodeSizeChoice>('terminal')
  const field = nodeSizeField(settings, choice)
  const set = (size: NodeSize): void => {
    update(nodeSizePatch(settings, choice, size))
  }
  return (
    <FieldRow
      label="Default node size (px)"
      description="Size new nodes of the chosen kind open at. Existing nodes keep their size."
      control={
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <Select
            aria-label="Node kind"
            value={choice}
            onChange={(e) => setChoice(e.target.value as NodeSizeChoice)}
          >
            {NODE_SIZE_CHOICES.map((c) => (
              <option key={c} value={c}>
                {NODE_SIZE_CHOICE_LABELS[c]}
              </option>
            ))}
          </Select>
          <NumberField
            ariaLabel={`${NODE_SIZE_CHOICE_LABELS[choice]} default width`}
            value={field.size.width}
            min={field.min.width}
            max={field.max.width}
            step={20}
            onChange={(v) => set({ width: v || field.size.width, height: field.size.height })}
          />
          <span style={{ opacity: 0.6 }}>×</span>
          <NumberField
            ariaLabel={`${NODE_SIZE_CHOICE_LABELS[choice]} default height`}
            value={field.size.height}
            min={field.min.height}
            max={field.max.height}
            step={20}
            onChange={(v) => set({ width: field.size.width, height: v || field.size.height })}
          />
          {field.isCustom && (
            <Button variant="ghost" onClick={() => update(nodeSizeResetPatch(settings, choice))}>
              Reset
            </Button>
          )}
        </div>
      }
    />
  )
}
