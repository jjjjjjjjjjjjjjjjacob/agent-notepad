import type { LayoutEdge, Point } from "./graph-layout"

export type Point3D = Point & { z: number }
export type ProjectedPoint = Point & { depth: number; scale: number }
export type Rotation = { yaw: number; pitch: number }
export type GraphView = "2d" | "3d"

export function connectionIndex(edges: LayoutEdge[]) {
  const index = new Map<string, Set<string>>()
  for (const { source, target } of edges) {
    if (source === target) continue
    if (!index.has(source)) index.set(source, new Set())
    if (!index.has(target)) index.set(target, new Set())
    index.get(source)!.add(target)
    index.get(target)!.add(source)
  }
  return index
}

export function nodeSeed(slug: string) {
  let hash = 2166136261
  for (const char of slug) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
  // Mix every bit so similarly named subjects don't all share the same depth.
  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b)
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35)
  return ((hash ^ (hash >>> 16)) >>> 0) / 0xffffffff
}

export function projectPoint(
  point: Point3D,
  view: GraphView,
  { yaw, pitch }: Rotation
): ProjectedPoint {
  if (view === "2d") return { x: point.x, y: point.y, depth: 0, scale: 1 }
  const x = point.x - 600,
    y = point.y - 400
  const rx = x * Math.cos(yaw) + point.z * Math.sin(yaw)
  const rz = -x * Math.sin(yaw) + point.z * Math.cos(yaw)
  const ry = y * Math.cos(pitch) - rz * Math.sin(pitch)
  const depth = y * Math.sin(pitch) + rz * Math.cos(pitch)
  const scale = 1200 / Math.max(400, 1200 + depth)
  return { x: 600 + rx * scale, y: 400 + ry * scale, depth, scale }
}

// Move in the camera's plane so dragging also works after orbiting the map.
export function unprojectMovement(
  delta: Point,
  scale: number,
  view: GraphView,
  { yaw, pitch }: Rotation
): Point3D {
  if (view === "2d") return { ...delta, z: 0 }
  const x = delta.x / scale,
    y = delta.y / scale
  return {
    x: x * Math.cos(yaw) + y * Math.sin(pitch) * Math.sin(yaw),
    y: y * Math.cos(pitch),
    z: x * Math.sin(yaw) - y * Math.sin(pitch) * Math.cos(yaw),
  }
}

// Expand in screen space: the lens stays readable at every zoom and in 3D.
export function spreadNeighborhood(
  points: Map<string, ProjectedPoint>,
  focus: string | null,
  neighbors: ReadonlySet<string>,
  unit: number,
  anchor?: Point
) {
  const center = anchor ?? (focus ? points.get(focus) : undefined)
  if (!focus || !center) return points
  const result = new Map(points)
  const focalPoint = points.get(focus)
  if (focalPoint) result.set(focus, { ...focalPoint, ...center })
  const connected = [...neighbors]
    .filter((slug) => points.has(slug))
    .sort((a, b) => {
      const pa = points.get(a)!,
        pb = points.get(b)!
      return (
        Math.atan2(pa.y - center.y, pa.x - center.x) -
          Math.atan2(pb.y - center.y, pb.x - center.x) || a.localeCompare(b)
      )
    })
  // Larger rings hold more neighbors; even a large hub stays in a compact lens.
  const rings: string[][] = []
  for (let offset = 0; offset < connected.length;) {
    const capacity = Math.floor((2 * Math.PI * (105 + rings.length * 55)) / 45)
    rings.push(connected.slice(offset, offset + capacity))
    offset += capacity
  }
  const outerRadius = (105 + Math.max(0, rings.length - 1) * 55) * unit
  rings.forEach((members, ring) =>
    members.forEach((slug, index) => {
      const point = points.get(slug)!
      const first = points.get(members[0])!
      const startAngle = Math.atan2(first.y - center.y, first.x - center.x)
      const angle = startAngle + (index / members.length) * Math.PI * 2
      const radius = (105 + ring * 55) * unit
      result.set(slug, {
        ...point,
        x: center.x + Math.cos(angle) * radius,
        y: center.y + Math.sin(angle) * radius,
      })
    })
  )
  for (const [slug, point] of points) {
    if (slug === focus || neighbors.has(slug)) continue
    const dx = point.x - center.x,
      dy = point.y - center.y
    const distance = Math.hypot(dx, dy)
    const clearance = outerRadius + 45 * unit
    if (distance >= clearance) continue
    const angle =
      distance < 0.01 ? nodeSeed(slug) * Math.PI * 2 : Math.atan2(dy, dx)
    result.set(slug, {
      ...point,
      x: center.x + Math.cos(angle) * clearance,
      y: center.y + Math.sin(angle) * clearance,
    })
  }
  return result
}

type LabelNode = { slug: string; title: string; missing: boolean }

export function visibleLabels({
  nodes,
  points,
  connections,
  zoom,
  unit,
  selected,
  hovered,
}: {
  nodes: LabelNode[]
  points: Map<string, ProjectedPoint>
  connections: Map<string, Set<string>>
  zoom: number
  unit: number
  selected: string | null
  hovered: string | null
}) {
  const count = (slug: string) => connections.get(slug)?.size ?? 0
  const ranked = [...nodes].sort(
    (a, b) =>
      count(b.slug) - count(a.slug) ||
      Number(a.missing) - Number(b.missing) ||
      a.slug.localeCompare(b.slug)
  )
  const dense = nodes.length / (zoom * zoom) > 32
  const budget = Math.max(4, Math.min(24, Math.round(10 * zoom)))
  const candidates = new Set(
    (dense
      ? ranked.filter((n) => count(n.slug) >= 2).slice(0, budget)
      : ranked
    ).map((n) => n.slug)
  )
  const labels = new Set<string>()
  const occupied: { x: number; y: number; width: number }[] = []
  // Focus always wins a collision, including low-degree and missing subjects.
  const ordered = [...ranked].sort((a, b) => {
    const priority = (slug: string) =>
      slug === hovered ? 2 : slug === selected ? 1 : 0
    return priority(b.slug) - priority(a.slug)
  })
  for (const node of ordered) {
    const point = points.get(node.slug)
    if (!point) continue
    const forced = node.slug === hovered || node.slug === selected
    if (!forced && !candidates.has(node.slug)) continue
    const width = (Math.min(37, node.title.length) * 6.5 + 12) * unit
    const rect = { x: point.x, y: point.y + 26 * unit, width }
    const overlaps = occupied.some(
      (other) =>
        Math.abs(other.x - rect.x) < (other.width + width) / 2 &&
        Math.abs(other.y - rect.y) < 19 * unit
    )
    if (!forced && overlaps) continue
    labels.add(node.slug)
    occupied.push(rect)
  }
  return labels
}
