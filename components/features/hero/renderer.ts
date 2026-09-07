import {
  init,
  draw,
  compute,
  storage,
  surface,
  frame,
  frameLoop,
  type FrameLoopHandle,
} from "vgpu"
import { HERO_MAX_PARTICLES, type HeroSettings } from "@/lib/hero-settings"
import shader from "./particles.wgsl"
import flowShader from "./flow.wgsl"
import { createHeroPointer } from "./pointer"

export type HeroStatus = "initializing" | "running" | "paused" | "fallback"

export async function createHeroRenderer(
  canvas: HTMLCanvasElement,
  initial: HeroSettings,
  status: (value: HeroStatus) => void,
  signal: AbortSignal
) {
  const gpu = await init({ powerPreference: "low-power" })
  if (signal.aborted) {
    gpu.dispose()
    throw new DOMException("Aborted", "AbortError")
  }
  let disposed = false
  let failed = false
  let visible = false
  let settings = initial
  let loop: FrameLoopHandle | undefined
  let elapsed = 0
  let previous = 0
  const cursor = createHeroPointer()
  const pointer = cursor.position
  const pointerMotion = cursor.motion
  const scatter = [-10, -10, 0, 0]
  let settling = 0
  const stop = () => {
    loop?.stop()
    loop = undefined
    previous = 0
  }
  const fail = (error?: unknown) => {
    if (disposed || failed) return
    failed = true
    stop()
    if (process.env.NODE_ENV === "development")
      console.warn("Hero particles: GPU unavailable.", error)
    status("fallback")
    gpu.dispose()
  }
  const unsubscribe = gpu.onError(fail)
  void gpu.gpu.lost.then(fail)
  try {
    const target = surface(gpu, canvas, {
      dpr: [1, initial.mobile ? 1 : 1.5],
      alphaMode: "premultiplied",
      clearColor: [0, 0, 0, 0],
    })
    // Allocate the full desktop budget once; density changes reuse the device
    // and preserve existing trajectories. Each particle holds its position,
    // current velocity, layout displacement, and interaction velocity.
    const seeds = new Float32Array(HERO_MAX_PARTICLES * 8)
    for (let i = 0; i < HERO_MAX_PARTICLES; i++) {
      seeds[i * 8] = Math.random()
      seeds[i * 8 + 1] = Math.random()
    }
    const particleState = storage(gpu, seeds.byteLength)
    particleState.write(seeds)
    const uniforms = {
      resolution: [1, 1],
      time: 0,
      mode: settings.mode,
      pointSize: settings.size,
      tint: [...settings.color.slice(0, 3), settings.opacity],
      pointer,
      response: settings.response,
      particleState,
      pointerMotion,
      appearance: [
        settings.sizeVariation,
        settings.opacityVariation,
        settings.softness,
        settings.centerFade,
      ],
      hover: [settings.pointerRadius, settings.highlight],
    }
    const flow = compute(gpu, flowShader, { label: "hero-liquid" })
    const particles = draw(gpu, {
      shader,
      vertices: 6,
      blend: "alpha",
      set: uniforms,
    })
    await particles.compile({ colors: [target.format] })
    if (signal.aborted) throw new DOMException("Aborted", "AbortError")
    const render = (pass: import("vgpu").Frame) => {
      const now = performance.now()
      const frameDelta = previous
        ? Math.min((now - previous) / 1000, 0.05)
        : 1 / 60
      const delta = previous ? frameDelta * settings.speed : 0
      elapsed += delta
      previous = now
      // Resolution is in CSS pixels so a point stays the same size at every DPR.
      uniforms.resolution[0] = Math.max(canvas.clientWidth, 1)
      uniforms.resolution[1] = Math.max(canvas.clientHeight, 1)
      uniforms.time = elapsed
      cursor.update(
        frameDelta,
        [uniforms.resolution[0] / 360, uniforms.resolution[1] / 360],
        settings.response > 0 && !settings.mobile
      )
      if (cursor.active) settling = settings.settling * 1.5
      else settling = Math.max(0, settling - frameDelta)
      if (settings.speed > 0 || cursor.active || settling > 0) {
        flow.set({
          particleState,
          resolution: uniforms.resolution,
          time: elapsed,
          delta: frameDelta,
          liquid: [
            settings.wind,
            settings.convection,
            settings.viscosity,
            settings.speed,
          ],
          flowShape: [
            360 / settings.currentSize,
            settings.turbulence,
            settings.evolution,
            0,
          ],
          interaction: [
            settings.pointerRadius / 360,
            settings.pointerSwirl,
            settings.scatterRadius / 360,
            settings.settling,
          ],
          pointer,
          pointerMotion,
          response: settings.response,
          count: settings.count,
          mode: settings.mode,
          scatter,
        })
        flow.dispatch(Math.ceil(settings.count / 64))
        scatter[2] = 0
      }
      particles.set(uniforms)
      pass.pass(target, (commands) => {
        commands.draw(particles, { instances: settings.count })
      })
    }
    const syncLoop = () => {
      stop()
      if (disposed || failed) return
      if (!visible || document.hidden) {
        cursor.leave()
        status("paused")
        return
      }
      try {
        frame(gpu, render)
        if (settings.speed > 0 || cursor.active || settling > 0)
          loop = frameLoop(
            gpu,
            (pass) => {
              try {
                render(pass)
                if (settings.speed === 0 && !cursor.active && settling === 0)
                  stop()
              } catch (error) {
                pass.cancel()
                fail(error)
              }
            },
            { fps: settings.mobile ? 30 : 60 }
          )
        status("running")
      } catch {
        fail()
      }
    }
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting
      syncLoop()
    })
    observer.observe(canvas)
    const host = canvas.closest<HTMLElement>("[data-particle-stage]")!
    const move = (event: PointerEvent) => {
      if (
        event.pointerType !== "mouse" ||
        settings.mobile ||
        settings.response === 0
      )
        return
      const rect = canvas.getBoundingClientRect()
      cursor.move(
        (event.clientX - rect.left) / rect.width,
        (event.clientY - rect.top) / rect.height
      )
      if (!loop && settings.response > 0) syncLoop()
    }
    const leave = () => {
      cursor.leave()
    }
    const scatterParticles = (event: PointerEvent) => {
      if (
        event.pointerType !== "mouse" ||
        event.button !== 0 ||
        settings.mobile ||
        settings.scatter === 0
      )
        return
      // Leave links, forms, text editing, and their native behavior alone.
      if (
        event.target instanceof Element &&
        event.target.closest(
          'a, button, input, textarea, select, [role="button"], [contenteditable="true"]'
        )
      )
        return
      const rect = canvas.getBoundingClientRect()
      const x = (event.clientX - rect.left) / rect.width
      const y = (event.clientY - rect.top) / rect.height
      if (x < 0 || x > 1 || y < 0 || y > 1) return
      scatter[0] = x
      scatter[1] = y
      scatter[2] = settings.scatter
      settling = settings.settling * 1.5
      if (!loop) syncLoop()
    }
    host.addEventListener("pointermove", move, { passive: true })
    host.addEventListener("pointerdown", scatterParticles, { passive: true })
    host.addEventListener("pointerleave", leave)
    window.addEventListener("blur", leave)
    document.addEventListener("visibilitychange", syncLoop)
    const resize = new ResizeObserver(() => {
      if (!loop) syncLoop()
    })
    resize.observe(canvas)
    return {
      update(next: HeroSettings) {
        const restart =
          next.mobile !== settings.mobile || next.speed !== settings.speed
        if (settling > 0 && next.settling !== settings.settling)
          settling = Math.max(settling, next.settling * 1.5)
        settings = next
        uniforms.mode = next.mode
        uniforms.pointSize = next.size
        uniforms.response = next.response
        uniforms.tint = [...next.color.slice(0, 3), next.opacity]
        uniforms.appearance = [
          next.sizeVariation,
          next.opacityVariation,
          next.softness,
          next.centerFade,
        ]
        uniforms.hover = [next.pointerRadius, next.highlight]
        if (next.mobile || next.response === 0) cursor.leave()
        if (restart || !loop) syncLoop()
      },
      dispose() {
        disposed = true
        stop()
        observer.disconnect()
        resize.disconnect()
        host.removeEventListener("pointermove", move)
        host.removeEventListener("pointerdown", scatterParticles)
        host.removeEventListener("pointerleave", leave)
        window.removeEventListener("blur", leave)
        document.removeEventListener("visibilitychange", syncLoop)
        unsubscribe()
        gpu.dispose()
      },
    }
  } catch (error) {
    disposed = true
    unsubscribe()
    gpu.dispose()
    throw error
  }
}
