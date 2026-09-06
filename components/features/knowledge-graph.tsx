"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import type { Point } from "@/lib/graph-layout"
import { graphLayout } from "@/lib/graph-layout"
import {
  connectionIndex,
  nodeSeed,
  projectPoint,
  unprojectMovement,
  visibleLabels,
  type GraphView,
  type Point3D,
} from "@/lib/graph-scene"
import type { Graph, GraphNode } from "./knowledge-map"
import { useGraphScene, useReducedMotion } from "./use-graph-scene"
import styles from "./knowledge-map.module.css"

const initialCamera = { x: 0, y: 0, zoom: 1 }
const initialRotation = { yaw: -0.35, pitch: 0.22 }
const noNeighbors = new Set<string>()
type Drag = {
  pointerId: number
  start: Point
  camera: typeof initialCamera
  rotation: typeof initialRotation
  kind: "pan" | "orbit" | "node"
  slug?: string
  origin?: Point3D
  screen?: Point
  scale: number
  moved: boolean
}

export function KnowledgeGraph({
  data,
  visible,
  selected,
  onSelect,
  topicColor,
}: {
  data: Graph
  visible: GraphNode[]
  selected: string | null
  onSelect: (slug: string | null) => void
  topicColor: (topic: string) => string
}) {
  const svg = useRef<SVGSVGElement>(null)
  const drag = useRef<Drag | null>(null)
  const suppressClick = useRef(false)
  const [camera, setCamera] = useState(initialCamera)
  const [rotation, setRotation] = useState(initialRotation)
  const [view, setView] = useState<GraphView>("2d")
  const [moving, setMoving] = useState(true)
  const [dragging, setDragging] = useState(false)
  const [unit, setUnit] = useState(1)
  const [hover, setHover] = useState<{ slug: string; anchor: Point } | null>(
    null
  )
  const [focused, setFocused] = useState<string | null>(null)
  const [overrides, setOverrides] = useState(new Map<string, Point3D>())
  const reducedMotion = useReducedMotion()

  // Activity refreshes retain geometry; only a topology change rebuilds it.
  const topology = JSON.stringify({
    nodes: data.nodes
      .map(({ slug, topic }) => ({ slug, topic }))
      .sort((a, b) => a.slug.localeCompare(b.slug)),
    edges: data.edges
      .map(({ source, target }) => ({ source, target }))
      .sort(
        (a, b) =>
          a.source.localeCompare(b.source) || a.target.localeCompare(b.target)
      ),
  })
  const layout = useMemo(() => {
    const { nodes, edges } = JSON.parse(topology)
    return new Map(
      [...graphLayout(nodes, edges)].map(([slug, point]) => [
        slug,
        { ...point, z: (nodeSeed(slug) - 0.5) * 440 },
      ])
    )
  }, [topology])
  const connections = useMemo(() => connectionIndex(data.edges), [data.edges])
  const visibleSlugs = useMemo(
    () => new Set(visible.map((n) => n.slug)),
    [visible]
  )
  const nodeIndex = useMemo(
    () => new Map(data.nodes.map((n) => [n.slug, n])),
    [data.nodes]
  )
  const positions = useMemo(
    () =>
      new Map(
        [...layout]
          .filter(([slug]) => visibleSlugs.has(slug))
          .map(([slug, point]) => [slug, overrides.get(slug) ?? point])
      ),
    [layout, overrides, visibleSlugs]
  )
  const hovered = hover && visibleSlugs.has(hover.slug) ? hover.slug : null
  const focus =
    hovered ?? (focused && visibleSlugs.has(focused) ? focused : null)
  const highlight =
    focus ?? (selected && visibleSlugs.has(selected) ? selected : null)
  const neighbors = (focus && connections.get(focus)) || noNeighbors
  const adjacent = (highlight && connections.get(highlight)) || noNeighbors
  const screenUnit = unit / camera.zoom
  const points = useGraphScene({
    positions,
    view,
    rotation,
    moving: moving && !dragging,
    reducedMotion,
    focus,
    anchor: hovered ? hover!.anchor : undefined,
    neighbors,
    unit: screenUnit,
    pinned: overrides,
  })
  const labels = useMemo(
    () =>
      visibleLabels({
        nodes: visible,
        points,
        connections,
        zoom: camera.zoom,
        unit: screenUnit,
        selected,
        hovered: focus,
      }),
    [visible, points, connections, camera.zoom, screenUnit, selected, focus]
  )
  const ordered = [...visible].sort((a, b) => {
    if (a.slug === focus) return 1
    if (b.slug === focus) return -1
    return (points.get(b.slug)?.depth ?? 0) - (points.get(a.slug)?.depth ?? 0)
  })

  useEffect(() => {
    const element = svg.current
    if (!element) return
    const measure = () => {
      const matrix = element.getScreenCTM()
      if (matrix) setUnit(1 / matrix.a)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      const matrix = element.getScreenCTM()
      if (!matrix) return
      const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(
        matrix.inverse()
      )
      setHover(null)
      setFocused(null)
      setCamera((c) => {
        const zoom = Math.max(
          0.35,
          Math.min(4, c.zoom * Math.exp(-event.deltaY * 0.002))
        )
        const ratio = zoom / c.zoom
        return {
          zoom,
          x: point.x - 600 - (point.x - 600 - c.x) * ratio,
          y: point.y - 400 - (point.y - 400 - c.y) * ratio,
        }
      })
    }
    element.addEventListener("wheel", wheel, { passive: false })
    return () => {
      observer.disconnect()
      element.removeEventListener("wheel", wheel)
    }
  }, [])
  const zoom = (factor: number) => {
    setHover(null)
    setFocused(null)
    setCamera((c) => ({
      ...c,
      zoom: Math.max(0.35, Math.min(4, c.zoom * factor)),
    }))
  }
  const reset = () => {
    setCamera(initialCamera)
    setRotation(initialRotation)
    setOverrides(new Map())
    setHover(null)
    setFocused(null)
  }
  const endDrag = (event: React.PointerEvent<SVGSVGElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return
    suppressClick.current = drag.current.moved
    drag.current = null
    setDragging(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId)
  }

  return (
    <>
      <div className={styles.viewControls}>
        <div
          className={styles.viewSwitch}
          role="group"
          aria-label="Map dimensions"
        >
          {(["2d", "3d"] as const).map((dimension) => (
            <button
              key={dimension}
              aria-label={`${dimension.toUpperCase()} view`}
              aria-pressed={view === dimension}
              onClick={() => {
                setView(dimension)
                setHover(null)
                setFocused(null)
              }}
            >
              {dimension.toUpperCase()}
            </button>
          ))}
        </div>
        <button
          className={styles.motionToggle}
          aria-label={
            moving && !reducedMotion ? "Pause map motion" : "Resume map motion"
          }
          title={
            reducedMotion
              ? "Motion is off to match your reduced motion preference"
              : undefined
          }
          disabled={reducedMotion}
          onClick={() => setMoving(!moving)}
        >
          <span aria-hidden="true">{moving && !reducedMotion ? "Ⅱ" : "▷"}</span>{" "}
          Motion
        </button>
      </div>
      <svg
        ref={svg}
        viewBox="0 0 1200 800"
        role="group"
        aria-label={`Interactive knowledge graph. ${view === "3d" ? "Drag to orbit; Shift-drag to pan." : "Drag to pan."} Drag subjects to move them. Use arrow keys to ${view === "3d" ? "orbit, Shift and arrow keys to pan" : "pan"}, plus or minus to zoom. Select a subject to inspect it.`}
        data-view={view}
        data-motion={moving && !reducedMotion ? "running" : "paused"}
        tabIndex={0}
        onKeyDown={(event) => {
          if (
            [
              "ArrowLeft",
              "ArrowRight",
              "ArrowUp",
              "ArrowDown",
              "+",
              "=",
              "-",
              "0",
              "Escape",
            ].includes(event.key)
          )
            event.preventDefault()
          const dx =
            event.key === "ArrowLeft"
              ? 50
              : event.key === "ArrowRight"
                ? -50
                : 0
          const dy =
            event.key === "ArrowUp" ? 50 : event.key === "ArrowDown" ? -50 : 0
          if (dx || dy) {
            setHover(null)
            setFocused(null)
            if (view === "3d" && !event.shiftKey)
              setRotation((r) => ({
                yaw: r.yaw + dx * 0.004,
                pitch: Math.max(-1.3, Math.min(1.3, r.pitch + dy * 0.004)),
              }))
            else setCamera((c) => ({ ...c, x: c.x + dx, y: c.y + dy }))
          }
          if (["+", "="].includes(event.key)) zoom(1.2)
          if (event.key === "-") zoom(1 / 1.2)
          if (event.key === "0") reset()
          if (event.key === "Escape") {
            onSelect(null)
            setHover(null)
            setFocused(null)
          }
        }}
        onPointerDown={(event) => {
          if (!event.isPrimary || event.button !== 0) return
          const slug = (event.target as Element)
            .closest("[data-node]")
            ?.getAttribute("data-node")
          const screen = slug ? points.get(slug) : undefined
          let origin = slug ? positions.get(slug) : undefined
          // Preserve the grabbed screen position, including a hover expansion.
          if (origin && screen) {
            const projected = projectPoint(origin, view, rotation)
            const offset = unprojectMovement(
              { x: screen.x - projected.x, y: screen.y - projected.y },
              projected.scale,
              view,
              rotation
            )
            origin = {
              x: origin.x + offset.x,
              y: origin.y + offset.y,
              z: origin.z + offset.z,
            }
          }
          suppressClick.current = false
          drag.current = {
            pointerId: event.pointerId,
            start: { x: event.clientX, y: event.clientY },
            camera,
            rotation,
            kind: slug
              ? "node"
              : view === "3d" && !event.shiftKey
                ? "orbit"
                : "pan",
            slug: slug ?? undefined,
            origin,
            screen,
            scale: screen?.scale ?? 1,
            moved: false,
          }
          // Capture only after the drag threshold so a click keeps its node target.
          if (!slug) {
            setHover(null)
            setFocused(null)
          }
        }}
        onPointerMove={(event) => {
          const gesture = drag.current
          if (!gesture || gesture.pointerId !== event.pointerId) return
          const dx = event.clientX - gesture.start.x,
            dy = event.clientY - gesture.start.y
          if (!gesture.moved && Math.hypot(dx, dy) < 4) return
          if (!gesture.moved) {
            gesture.moved = true
            event.currentTarget.setPointerCapture(event.pointerId)
            setDragging(true)
          }
          if (gesture.kind === "pan")
            setCamera({
              ...gesture.camera,
              x: gesture.camera.x + dx * unit,
              y: gesture.camera.y + dy * unit,
            })
          else if (gesture.kind === "orbit")
            setRotation({
              yaw: gesture.rotation.yaw + dx * 0.006,
              pitch: Math.max(
                -1.3,
                Math.min(1.3, gesture.rotation.pitch + dy * 0.006)
              ),
            })
          else if (gesture.slug && gesture.origin && gesture.screen) {
            const delta = { x: dx * screenUnit, y: dy * screenUnit }
            const movement = unprojectMovement(
              delta,
              gesture.scale,
              view,
              gesture.rotation
            )
            setOverrides((before) =>
              new Map(before).set(gesture.slug!, {
                x: gesture.origin!.x + movement.x,
                y: gesture.origin!.y + movement.y,
                z: gesture.origin!.z + movement.z,
              })
            )
            setHover({
              slug: gesture.slug,
              anchor: {
                x: gesture.screen.x + delta.x,
                y: gesture.screen.y + delta.y,
              },
            })
          }
        }}
        onPointerUp={endDrag}
        onPointerCancel={(event) => {
          endDrag(event)
          setHover(null)
        }}
        onLostPointerCapture={(event) => {
          endDrag(event)
        }}
        onPointerLeave={() => {
          if (!drag.current?.moved) setHover(null)
        }}
      >
        <g
          data-camera
          transform={`translate(${camera.x + 600} ${camera.y + 400}) scale(${camera.zoom}) translate(-600 -400)`}
        >
          {data.edges.map((edge) => {
            const a = points.get(edge.source),
              b = points.get(edge.target)
            if (
              !a ||
              !b ||
              !visibleSlugs.has(edge.source) ||
              !visibleSlugs.has(edge.target)
            )
              return null
            const highlighted =
              edge.source === highlight || edge.target === highlight
            return (
              <line
                key={`${edge.source}:${edge.target}:${edge.relationship}`}
                data-source={edge.source}
                data-target={edge.target}
                data-highlighted={highlighted}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke={
                  highlighted
                    ? topicColor(nodeIndex.get(highlight!)?.topic ?? "")
                    : "currentColor"
                }
                strokeWidth={highlighted ? 1.7 : 0.85}
                vectorEffect="non-scaling-stroke"
                strokeDasharray={
                  nodeIndex.get(edge.target)?.missing ? "5 5" : undefined
                }
                opacity={highlight ? (highlighted ? 0.9 : 0.07) : 0.27}
                className={styles.edge}
              >
                <title>{`${edge.source} → ${edge.target} (${edge.relationship})`}</title>
              </line>
            )
          })}
          {ordered.map((node) => {
            const point = points.get(node.slug)
            if (!point) return null
            const count = connections.get(node.slug)?.size ?? 0
            const radius =
              (node.missing ? 5 : 6 + Math.min(7, Math.sqrt(count) * 2)) *
              screenUnit *
              point.scale
            const chosen = node.slug === selected,
              focal = node.slug === focus
            const dim =
              highlight && node.slug !== highlight && !adjacent.has(node.slug)
            const color = topicColor(node.topic)
            return (
              <g
                key={node.slug}
                data-node={node.slug}
                data-label-visible={labels.has(node.slug)}
                data-depth={point.depth.toFixed(2)}
                data-expanded={focal}
                transform={`translate(${point.x} ${point.y})`}
                role="button"
                aria-label={`${node.title}${node.missing ? ", missing article" : `, ${count} connections`}`}
                aria-pressed={chosen}
                tabIndex={0}
                className={styles.node}
                opacity={
                  dim
                    ? 0.2
                    : view === "3d" && !focal
                      ? Math.max(0.55, Math.min(1, point.scale))
                      : 1
                }
                onPointerEnter={() => {
                  if (!drag.current?.moved)
                    setHover({
                      slug: node.slug,
                      anchor: { x: point.x, y: point.y },
                    })
                }}
                onPointerLeave={() => {
                  if (!drag.current?.moved)
                    setHover((h) => (h?.slug === node.slug ? null : h))
                }}
                onFocus={(event) => {
                  if (event.currentTarget.matches(":focus-visible"))
                    setFocused(node.slug)
                }}
                onBlur={() => setFocused(null)}
                onClick={() => {
                  if (suppressClick.current) {
                    suppressClick.current = false
                    return
                  }
                  onSelect(node.slug)
                }}
                onKeyDown={(event) => {
                  if (["Enter", " "].includes(event.key)) {
                    event.preventDefault()
                    event.stopPropagation()
                    onSelect(node.slug)
                  }
                }}
              >
                <circle
                  r={Math.max(20 * screenUnit, radius + 7 * screenUnit)}
                  fill="transparent"
                />
                {!node.missing &&
                  data.generatedAt - node.updatedAt < 86400000 && (
                    <circle
                      r={radius + 5 * screenUnit}
                      fill="none"
                      stroke={color}
                      strokeOpacity=".24"
                      strokeWidth={3 * screenUnit}
                    />
                  )}
                {(chosen || focal) && (
                  <circle
                    r={radius + 9 * screenUnit}
                    fill="none"
                    stroke={color}
                    strokeWidth={screenUnit}
                  />
                )}
                <circle
                  r={radius}
                  fill={node.missing ? "var(--map-background)" : color}
                  stroke={color}
                  strokeWidth={1.8 * screenUnit}
                  strokeDasharray={node.missing ? "3 3" : undefined}
                />
                {node.disputed && (
                  <circle
                    cx={radius}
                    cy={-radius}
                    r={4 * screenUnit}
                    fill="#f18c82"
                  />
                )}
                <text
                  y={radius + 17 * screenUnit}
                  textAnchor="middle"
                  className={styles.nodeLabel}
                  visibility={labels.has(node.slug) ? "visible" : "hidden"}
                  fontSize={
                    (chosen || focal || count > 3 ? 13 : 11) * screenUnit
                  }
                  fontWeight={chosen || focal || count > 3 ? 600 : 400}
                  style={{ strokeWidth: 5 * screenUnit }}
                >
                  {node.title.length > 37 && !focal
                    ? node.title.slice(0, 35) + "…"
                    : node.title}
                </text>
              </g>
            )
          })}
        </g>
      </svg>
      <div className={styles.interactionHint}>
        {view === "3d"
          ? "Drag to orbit · Shift-drag to pan"
          : "Drag to pan · Drag a subject to move it"}
        <span>Hover to spread connections</span>
      </div>
      <div className={styles.zoom}>
        <button aria-label="Zoom in" onClick={() => zoom(1.25)}>
          +
        </button>
        <span>{Math.round(camera.zoom * 100)}%</span>
        <button aria-label="Zoom out" onClick={() => zoom(0.8)}>
          −
        </button>
        <button aria-label="Fit map" onClick={reset}>
          ⊡
        </button>
      </div>
    </>
  )
}
