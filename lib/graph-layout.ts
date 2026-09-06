export type LayoutNode = { slug: string; topic: string }
export type LayoutEdge = { source: string; target: string }
export type Point = { x: number; y: number }

// Deterministic, bounded force layout. Activity updates don't make the map jump.
export function graphLayout(
  nodes: LayoutNode[],
  edges: LayoutEdge[]
): Map<string, Point> {
  const sorted = [...nodes].sort((a, b) => a.slug.localeCompare(b.slug))
  const topics = [...new Set(sorted.map((n) => n.topic))].sort()
  const positions = new Map<string, Point>()
  const anchors = new Map<string, Point>()
  sorted.forEach((n, i) => {
    const group = topics.indexOf(n.topic)
    const angle =
      (group / Math.max(1, topics.length)) * Math.PI * 2 - Math.PI / 2
    const anchor =
      topics.length === 1
        ? { x: 600, y: 400 }
        : { x: 600 + Math.cos(angle) * 280, y: 400 + Math.sin(angle) * 220 }
    anchors.set(n.slug, anchor)
    positions.set(n.slug, {
      x: anchor.x + Math.cos(i * 2.399) * (55 + (i % 5) * 18),
      y: anchor.y + Math.sin(i * 2.399) * (55 + (i % 5) * 18),
    })
  })
  for (let step = 0; step < 140; step++) {
    const forces = new Map(sorted.map((n) => [n.slug, { x: 0, y: 0 }]))
    for (let i = 0; i < sorted.length; i++)
      for (let j = i + 1; j < sorted.length; j++) {
        const a = positions.get(sorted[i].slug)!,
          b = positions.get(sorted[j].slug)!
        const dx = a.x - b.x || 0.01,
          dy = a.y - b.y || 0.01
        const d2 = Math.max(200, dx * dx + dy * dy),
          force = 1200 / d2
        const fa = forces.get(sorted[i].slug)!,
          fb = forces.get(sorted[j].slug)!
        fa.x += dx * force
        fa.y += dy * force
        fb.x -= dx * force
        fb.y -= dy * force
      }
    for (const edge of edges) {
      const a = positions.get(edge.source),
        b = positions.get(edge.target)
      if (!a || !b) continue
      const dx = b.x - a.x,
        dy = b.y - a.y,
        distance = Math.hypot(dx, dy) || 1
      const strength = ((distance - 145) * 0.012) / distance
      const fa = forces.get(edge.source)!,
        fb = forces.get(edge.target)!
      fa.x += dx * strength
      fa.y += dy * strength
      fb.x -= dx * strength
      fb.y -= dy * strength
    }
    for (const node of sorted) {
      const point = positions.get(node.slug)!,
        force = forces.get(node.slug)!,
        anchor = anchors.get(node.slug)!
      const cooling = 1 - step / 170
      point.x +=
        Math.max(-12, Math.min(12, force.x + (anchor.x - point.x) * 0.015)) *
        cooling
      point.y +=
        Math.max(-12, Math.min(12, force.y + (anchor.y - point.y) * 0.015)) *
        cooling
    }
  }
  if (sorted.length) {
    const points = [...positions.values()]
    const minX = Math.min(...points.map((p) => p.x)),
      maxX = Math.max(...points.map((p) => p.x))
    const minY = Math.min(...points.map((p) => p.y)),
      maxY = Math.max(...points.map((p) => p.y))
    const scale = Math.min(
      1.4,
      960 / Math.max(1, maxX - minX),
      610 / Math.max(1, maxY - minY)
    )
    for (const point of points) {
      point.x = 600 + (point.x - (minX + maxX) / 2) * scale
      point.y = 400 + (point.y - (minY + maxY) / 2) * scale
    }
  }
  return positions
}
