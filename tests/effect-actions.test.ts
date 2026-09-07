import { afterEach, expect, it, vi } from "vitest"
import { Effect } from "effect"
import { ConvexError } from "convex/values"
import { z } from "zod"
import { appError } from "../lib/errors"
import { runEffect } from "../lib/effects"
import {
  authAction,
  createActionRunner,
  createWriteIntent,
  jsonRequest,
  runIdempotentMutation,
} from "../lib/action-runner"

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
const options = () => ({
  setBusy: vi.fn(),
  setError: vi.fn(),
  onSuccess: vi.fn(),
  onFailure: vi.fn(),
  onDefect: vi.fn(),
})
it("suppresses duplicate submissions and clears busy state after success", async () => {
  const run = createActionRunner(),
    callbacks = options()
  let resolve!: (value: number) => void
  const operation = vi.fn(
    () =>
      new Promise<number>((done) => {
        resolve = done
      })
  )
  const effect = Effect.promise(operation)
  const first = run(effect, callbacks)
  expect(await run(effect, callbacks)).toEqual({ status: "busy" })
  resolve(4)
  expect(await first).toEqual({ status: "success", value: 4 })
  expect(operation).toHaveBeenCalledOnce()
  expect(callbacks.setBusy.mock.calls).toEqual([[true], [false]])
  expect(callbacks.onSuccess).toHaveBeenCalledWith(4)
})
it("shows expected errors, reports defects safely, and always restores busy state", async () => {
  const run = createActionRunner(),
    callbacks = options()
  await run(
    Effect.fail(appError("RATE_LIMITED", "Busy", { retryAfterSeconds: 12 })),
    callbacks
  )
  expect(callbacks.setError).toHaveBeenLastCalledWith(
    "Please wait 12 seconds before trying again."
  )
  expect(callbacks.onDefect).not.toHaveBeenCalled()
  await run(Effect.die(new Error("private internal detail")), callbacks)
  expect(callbacks.onDefect).toHaveBeenCalledOnce()
  expect(callbacks.setError).toHaveBeenLastCalledWith(
    "The request could not be completed."
  )
  expect(callbacks.setBusy).toHaveBeenLastCalledWith(false)
})
it("contains defects from success callbacks instead of rejecting an event handler", async () => {
  const callbacks = options()
  callbacks.onSuccess.mockImplementation(() => {
    throw new Error("private callback detail")
  })
  expect(
    (await createActionRunner()(Effect.succeed(1), callbacks)).status
  ).toBe("failure")
  expect(callbacks.onDefect).toHaveBeenCalledOnce()
  expect(callbacks.setBusy).toHaveBeenLastCalledWith(false)
})
it("contains failure callback defects and restores busy state", async () => {
  const callbacks = options()
  callbacks.onFailure.mockImplementation(() => {
    throw new Error("private")
  })
  await expect(
    createActionRunner()(
      Effect.fail(appError("VALIDATION", "Invalid input")),
      callbacks
    )
  ).resolves.toMatchObject({ status: "failure", error: { code: "INTERNAL" } })
  expect(callbacks.onDefect).toHaveBeenCalledOnce()
  expect(callbacks.setError).toHaveBeenLastCalledWith(
    "The request could not be completed."
  )
  expect(callbacks.setBusy).toHaveBeenLastCalledWith(false)
})
it("reuses the same write key after uncertain outcomes, then rotates on success or changed input", async () => {
  let sequence = 0
  const intent = createWriteIntent(() => `key-${++sequence}`)
  const mutation = vi
    .fn<(input: { value: number; idempotencyKey: string }) => Promise<number>>()
    .mockRejectedValueOnce(
      new ConvexError({ code: "TIMEOUT", message: "Timed out" })
    )
    .mockResolvedValue(1)
  await expect(
    runIdempotentMutation(intent, mutation, { value: 4 })
  ).rejects.toBeInstanceOf(ConvexError)
  await runIdempotentMutation(intent, mutation, { value: 4 })
  await runIdempotentMutation(intent, mutation, { value: 4 })
  expect(mutation.mock.calls.map(([input]) => input.idempotencyKey)).toEqual([
    "key-1",
    "key-1",
    "key-2",
  ])
  mutation.mockRejectedValueOnce(new Error("unknown completion"))
  await expect(
    runIdempotentMutation(intent, mutation, { value: 4 })
  ).rejects.toThrow()
  await runIdempotentMutation(intent, mutation, { value: 5 })
  expect(mutation.mock.calls.at(-1)?.[0].idempotencyKey).toBe("key-4")
})
it("preserves failure status when an HTTP error response is not JSON", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("upstream private details", { status: 503 }))
  )
  await expect(
    runEffect(jsonRequest("/fixture", {}, z.object({ ok: z.boolean() })))
  ).rejects.toMatchObject({ code: "UNAVAILABLE" })
})
it("rejects malformed successful responses and handles legacy string error envelopes", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ userCode: 3 }))
    .mockResolvedValueOnce(
      Response.json({ error: "private legacy text" }, { status: 403 })
    )
  vi.stubGlobal("fetch", fetch)
  await expect(
    runEffect(jsonRequest("/fixture", {}, z.object({ userCode: z.string() })))
  ).rejects.toMatchObject({ code: "BAD_GATEWAY" })
  await expect(
    runEffect(jsonRequest("/fixture", {}, z.object({})))
  ).rejects.toMatchObject({
    code: "FORBIDDEN",
    message: "This account cannot perform that action.",
  })
})
it("normalizes Better Auth result errors without displaying provider text", async () => {
  await expect(
    runEffect(
      authAction(async () => ({
        error: { status: 401, message: "private provider text" },
      }))
    )
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" })
})
