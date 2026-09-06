// Coordinates are normalized to the canvas; velocity uses 360 CSS pixels/sec.
// The uniform arrays keep their identity so vgpu can reuse its bindings.
export function createHeroPointer() {
  const position = [-10, -10]
  const motion = [0, 0, 0, 0]
  const destination = [-10, -10]
  let inside = false

  return {
    position,
    motion,
    get active() {
      return inside || motion[2] > 0
    },
    move(x: number, y: number) {
      if (x < 0 || x > 1 || y < 0 || y > 1) {
        inside = false
        return
      }
      if (!inside) {
        position[0] = x
        position[1] = y
        motion[0] = motion[1] = 0
      }
      destination[0] = x
      destination[1] = y
      inside = true
    },
    leave() {
      inside = false
    },
    update(delta: number, scale: [number, number], enabled: boolean) {
      const follow = 1 - Math.exp(-delta * 18)
      const inertia = 1 - Math.exp(-delta * 10)
      const dx = (destination[0] - position[0]) * follow
      const dy = (destination[1] - position[1]) * follow
      position[0] += dx
      position[1] += dy
      const vx = (dx * scale[0]) / Math.max(delta, 0.001)
      const vy = (dy * scale[1]) / Math.max(delta, 0.001)
      const limit = Math.max(1, Math.hypot(vx, vy) / 3)
      motion[0] += (vx / limit - motion[0]) * inertia
      motion[1] += (vy / limit - motion[1]) * inertia
      const energy = Math.min(1, Math.hypot(motion[0], motion[1]) * 0.7)
      motion[3] += (energy - motion[3]) * inertia
      const hovered = inside && enabled
      motion[2] +=
        ((hovered ? 1 : 0) - motion[2]) *
        (1 - Math.exp(-delta * (hovered ? 12 : 5)))
      if (!hovered && motion[2] < 0.001) motion.fill(0)
    },
  }
}
