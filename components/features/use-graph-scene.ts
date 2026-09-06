import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import type { Point } from "@/lib/graph-layout"
import {
  nodeSeed,
  projectPoint,
  spreadNeighborhood,
  type GraphView,
  type Point3D,
  type ProjectedPoint,
  type Rotation,
} from "@/lib/graph-scene"

const motionQuery = "(prefers-reduced-motion: reduce)"
function subscribeMotion(callback: () => void) {
  const media = window.matchMedia(motionQuery)
  media.addEventListener("change", callback)
  return () => media.removeEventListener("change", callback)
}
export function useReducedMotion() {
  return useSyncExternalStore(
    subscribeMotion,
    () => window.matchMedia(motionQuery).matches,
    () => false
  )
}

export function useGraphScene({
  positions,
  view,
  rotation,
  moving,
  reducedMotion,
  focus,
  anchor,
  neighbors,
  unit,
  pinned,
}: {
  positions: Map<string, Point3D>
  view: GraphView
  rotation: Rotation
  moving: boolean
  reducedMotion: boolean
  focus: string | null
  anchor?: Point
  neighbors: ReadonlySet<string>
  unit: number
  pinned: ReadonlyMap<string, Point3D>
}) {
  const [points, setPoints] = useState(
    () =>
      new Map(
        [...positions].map(([slug, point]) => [
          slug,
          projectPoint(point, view, rotation),
        ])
      )
  )
  const current = useRef(points)
  const elapsed = useRef(0)
  useEffect(() => {
    let frame = 0,
      previous = 0
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick)
      if (previous && now - previous < 1000 / 30) return
      const delta = previous ? Math.min(64, now - previous) : 32
      previous = now
      if (moving && !reducedMotion && !focus) elapsed.current += delta / 1000
      const targets = new Map<string, ProjectedPoint>()
      for (const [slug, position] of positions) {
        const phase = nodeSeed(slug) * Math.PI * 2
        const t = pinned.has(slug) ? 0 : elapsed.current
        targets.set(
          slug,
          projectPoint(
            {
              x:
                position.x +
                (Math.sin(t * 0.38 + phase) - Math.sin(phase)) * 12,
              y:
                position.y +
                (Math.cos(t * 0.31 + phase) - Math.cos(phase)) * 10,
              z:
                position.z +
                (Math.sin(t * 0.27 + phase) - Math.sin(phase)) * 16,
            },
            view,
            rotation
          )
        )
      }
      const expanded = spreadNeighborhood(
        targets,
        focus,
        neighbors,
        unit,
        anchor
      )
      const next = new Map<string, ProjectedPoint>()
      let changed = current.current.size !== expanded.size
      const blend = reducedMotion ? 1 : 1 - Math.exp(-delta / 85)
      for (const [slug, target] of expanded) {
        if (!current.current.has(slug)) changed = true
        const before = current.current.get(slug) ?? target
        const settled =
          Math.abs(before.x - target.x) +
            Math.abs(before.y - target.y) +
            Math.abs(before.depth - target.depth) <
          0.08
        const snap = settled || slug === focus
        const point = {
          x: snap ? target.x : before.x + (target.x - before.x) * blend,
          y: snap ? target.y : before.y + (target.y - before.y) * blend,
          depth: before.depth + (target.depth - before.depth) * blend,
          scale: before.scale + (target.scale - before.scale) * blend,
        }
        if (
          Math.abs(point.x - before.x) +
            Math.abs(point.y - before.y) +
            Math.abs(point.depth - before.depth) +
            Math.abs(point.scale - before.scale) >
          0.001
        )
          changed = true
        next.set(slug, point)
      }
      current.current = next
      if (changed) setPoints(next)
      if (
        (!moving || reducedMotion || focus || positions.size === 0) &&
        !changed
      )
        cancelAnimationFrame(frame)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [
    positions,
    view,
    rotation,
    moving,
    reducedMotion,
    focus,
    anchor,
    neighbors,
    unit,
    pinned,
  ])
  return points
}
