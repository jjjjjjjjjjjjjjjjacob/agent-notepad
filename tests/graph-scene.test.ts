import { describe, expect, it } from "vitest"
import {
  connectionIndex,
  nodeSeed,
  projectPoint,
  spreadNeighborhood,
  unprojectMovement,
  visibleLabels,
  type ProjectedPoint,
} from "../lib/graph-scene"

const point = (x: number, y: number): ProjectedPoint => ({
  x,
  y,
  scale: 1,
  depth: 0,
})
describe("interactive graph geometry", () => {
  it("gives similarly named nodes stable, distinct depths", () => {
    const seeds = Array.from({ length: 20 }, (_, i) => nodeSeed(`subject-${i}`))
    expect(nodeSeed("subject-3")).toBe(seeds[3])
    expect(Math.max(...seeds) - Math.min(...seeds)).toBeGreaterThan(0.7)
    expect(seeds.every((value) => value >= 0 && value <= 1)).toBe(true)
  })
  it("ranks distinct neighbors, without inflating importance for reciprocal links", () => {
    const index = connectionIndex([
      { source: "a", target: "b" },
      { source: "b", target: "a" },
      { source: "a", target: "a" },
      { source: "c", target: "a" },
    ])
    expect([...index.get("a")!].sort()).toEqual(["b", "c"])
    expect(index.get("b")?.size).toBe(1)
  })

  it("reveals only hubs and focused subjects in a dense map, then adds detail on zoom", () => {
    const nodes = Array.from({ length: 100 }, (_, i) => ({
      slug: `n${i}`,
      title: `Subject ${i}`,
      missing: false,
    }))
    const points = new Map(
      nodes.map((n, i) => [
        n.slug,
        point((i % 10) * 150, Math.floor(i / 10) * 80),
      ])
    )
    const connections = connectionIndex(
      nodes.slice(1).map((n) => ({ source: "n0", target: n.slug }))
    )
    const options = {
      nodes,
      points,
      connections,
      unit: 1,
      zoom: 1,
      selected: null,
      hovered: null,
    }
    expect([...visibleLabels(options)]).toEqual(["n0"])
    expect(
      [...visibleLabels({ ...options, hovered: "n40", selected: "n70" })].sort()
    ).toEqual(["n0", "n40", "n70"])
    expect(visibleLabels({ ...options, zoom: 3 }).size).toBe(100)
    expect(visibleLabels({ ...options, nodes: nodes.slice(0, 4) }).size).toBe(4)
  })

  it("lets hovered labels win collisions and ignores hidden subjects", () => {
    const nodes = ["a", "b", "c"].map((slug) => ({
      slug,
      title: "A long label",
      missing: false,
    }))
    const points = new Map(nodes.map((node) => [node.slug, point(600, 400)]))
    const options = {
      nodes,
      points,
      connections: new Map(),
      zoom: 1,
      unit: 1,
      selected: null,
      hovered: "b",
    }
    expect([...visibleLabels(options)]).toEqual(["b"])
    expect(
      visibleLabels({
        ...options,
        nodes: nodes.filter((n) => n.slug !== "b"),
      }).has("b")
    ).toBe(false)
  })

  it("pins the hovered node, separates neighbors and clears nearby unrelated nodes", () => {
    const points = new Map([
      ["hub", point(600, 400)],
      ["a", point(610, 400)],
      ["b", point(612, 402)],
      ["unrelated", point(600, 400)],
      ["far", point(1000, 750)],
    ])
    const expanded = spreadNeighborhood(
      points,
      "hub",
      new Set(["a", "b", "filtered"]),
      1
    )
    expect(expanded.get("hub")).toEqual(points.get("hub"))
    const a = expanded.get("a")!,
      b = expanded.get("b")!,
      unrelated = expanded.get("unrelated")!
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(200)
    expect(
      Math.hypot(unrelated.x - 600, unrelated.y - 400)
    ).toBeGreaterThanOrEqual(149)
    expect(expanded.get("far")).toEqual(points.get("far"))
    expect(expanded.has("filtered")).toBe(false)
    expect(points.get("a")).toEqual(point(610, 400))
    expect(spreadNeighborhood(points, null, new Set(), 1)).toBe(points)
    expect(
      spreadNeighborhood(points, "hub", new Set(), 1, { x: 500, y: 300 }).get(
        "hub"
      )
    ).toMatchObject({ x: 500, y: 300 })
  })

  it("keeps a 100-neighbor hub in a compact lens with usable spacing", () => {
    const points = new Map([
      ["hub", point(600, 400)],
      ...Array.from({ length: 100 }, (_, i): [string, ProjectedPoint] => [
        `n${i}`,
        point(600, 400),
      ]),
    ])
    const expanded = spreadNeighborhood(
      points,
      "hub",
      new Set([...points.keys()].filter((s) => s !== "hub")),
      1
    )
    const neighbors = [...expanded]
      .filter(([s]) => s !== "hub")
      .map(([, p]) => p)
    for (let i = 0; i < neighbors.length; i++) {
      const a = neighbors[i]
      expect(Math.hypot(a.x - 600, a.y - 400)).toBeLessThanOrEqual(271)
      for (const b of neighbors.slice(i + 1))
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(40)
    }
  })

  it("uses depth and perspective in 3D, and correctly drags in an orbited camera plane", () => {
    const rotation = { yaw: 0.7, pitch: -0.3 }
    const original = { x: 720, y: 340, z: 120 }
    expect(projectPoint(original, "2d", rotation)).toEqual({
      x: 720,
      y: 340,
      depth: 0,
      scale: 1,
    })
    const projected = projectPoint(original, "3d", rotation)
    expect(projected.x).not.toBe(720)
    expect(projected.depth).not.toBe(0)
    const movement = unprojectMovement(
      { x: 50, y: -30 },
      projected.scale,
      "3d",
      rotation
    )
    const moved = projectPoint(
      {
        x: original.x + movement.x,
        y: original.y + movement.y,
        z: original.z + movement.z,
      },
      "3d",
      rotation
    )
    expect(moved.x - projected.x).toBeCloseTo(50)
    expect(moved.y - projected.y).toBeCloseTo(-30)
    expect(moved.depth).toBeCloseTo(projected.depth)
  })
})
