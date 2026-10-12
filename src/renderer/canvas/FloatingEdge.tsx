// The canvas's ONE edge type. Reads both nodes' absolute rectangles from React Flow's internals
// (so nodes inside group frames resolve correctly) and draws a bezier between the midpoints of
// their facing sides — see lib/floatingEdge.ts. `data.anchor === 'horizontal'` (context and note
// links) restricts both ends to the left/right sides, where the bridge handles are drawn. An UNMEASURED node draws nothing this frame: React Flow's
// internals report a 0×0 rectangle for the first tick after mount, and a path drawn from it would
// point at the node's top-left corner, or at the origin.
import { BaseEdge, getBezierPath, useInternalNode, type EdgeProps } from '@xyflow/react'
import { floatingEdgeParams, type AnchorSides, type Rect } from '../lib/floatingEdge'
import { useEdgeAnchorInsets, type EdgeInsets } from '../state/edgeAnchorInsets'

function rectOf(n: ReturnType<typeof useInternalNode>, inset?: EdgeInsets): Rect | null {
  if (!n) return null
  const width = n.measured?.width ?? 0
  const height = n.measured?.height ?? 0
  if (!(width > 0) || !(height > 0)) return null
  const r = { x: n.internals.positionAbsolute.x, y: n.internals.positionAbsolute.y, width, height }
  if (!inset) return r
  // A node whose visible body is smaller than its box (the folded Simulator node): meet the body.
  const w = width - inset.left - inset.right
  const h = height - inset.top - inset.bottom
  if (!(w > 0) || !(h > 0)) return r
  return { x: r.x + inset.left, y: r.y + inset.top, width: w, height: h }
}

export function FloatingEdge(props: EdgeProps) {
  const {
    id,
    source,
    target,
    style,
    markerEnd,
    markerStart,
    label,
    labelStyle,
    labelShowBg,
    labelBgStyle,
    labelBgPadding,
    labelBgBorderRadius,
    interactionWidth
  } = props
  const sourceInset = useEdgeAnchorInsets((s) => s.byId[source])
  const targetInset = useEdgeAnchorInsets((s) => s.byId[target])
  const a = rectOf(useInternalNode(source), sourceInset)
  const b = rectOf(useInternalNode(target), targetInset)
  if (!a || !b) return null
  const anchor = (props.data as { anchor?: AnchorSides } | undefined)?.anchor
  const p = floatingEdgeParams(a, b, anchor === 'horizontal' ? 'horizontal' : 'all')
  const [path, labelX, labelY] = getBezierPath({
    sourceX: p.sx,
    sourceY: p.sy,
    sourcePosition: p.sourcePosition,
    targetX: p.tx,
    targetY: p.ty,
    targetPosition: p.targetPosition
  })
  return (
    <BaseEdge
      id={id}
      path={path}
      style={style}
      markerEnd={markerEnd}
      markerStart={markerStart}
      label={label}
      labelX={labelX}
      labelY={labelY}
      labelStyle={labelStyle}
      labelShowBg={labelShowBg}
      labelBgStyle={labelBgStyle}
      labelBgPadding={labelBgPadding}
      labelBgBorderRadius={labelBgBorderRadius}
      interactionWidth={interactionWidth}
    />
  )
}
