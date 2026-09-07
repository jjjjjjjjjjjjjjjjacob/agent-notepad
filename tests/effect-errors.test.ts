import { afterEach, describe, expect, it, vi } from "vitest"
import { Cause, Effect, Exit } from "effect"
import { ConvexError } from "convex/values"
import { z } from "zod"
import {
  appError,
  decodeErrorData,
  errorData,
  errorStatuses,
  expectedError,
  externalError,
  isTransient,
} from "../lib/errors"
import {
  attempt,
  attemptSync,
  errorResponse,
  failureError,
  fetchEffect,
  runConvex,
  runEffect,
  runHttp,
  validate,
} from "../lib/effects"

afterEach(() => vi.restoreAllMocks())
describe("typed failure boundaries", () => {
  it("round-trips application errors across Convex without serializing Effect internals", async () => {
    const error = appError("RATE_LIMITED", "Wait before retrying.", {
      retryAfterSeconds: 2,
    })
    await expect(
      runConvex(Effect.fail(error), "fixture")
    ).rejects.toBeInstanceOf(ConvexError)
    const remote = new ConvexError(
      JSON.stringify({ ...errorData(error), stack: "private", cause: "secret" })
    )
    const decoded = expectedError(remote)!
    expect(decoded.code).toBe("RATE_LIMITED")
    const response = errorResponse(decoded)
    expect(response.status).toBe(429)
    expect(response.headers.get("Retry-After")).toBe("2")
    expect(await response.json()).toEqual({
      error: {
        code: "RATE_LIMITED",
        message: "Wait before retrying.",
        details: { retryAfterSeconds: 2 },
      },
    })
  })
  it.each([
    "invalid JSON",
    { code: "MADE_UP", message: "x" },
    { code: "FORBIDDEN", message: 5 },
    {
      code: "RATE_LIMITED",
      message: "x",
      details: { retryAfterSeconds: Infinity },
    },
  ])("rejects malformed remote errors: %j", (input) => {
    expect(decodeErrorData(input)).toBeUndefined()
  })
  it("models validation failures without treating programming bugs as invalid input", async () => {
    await expect(
      runEffect(validate(z.object({ value: z.number() }), { value: "secret" }))
    ).rejects.toMatchObject({ code: "VALIDATION" })
    const error = new TypeError("private programmer detail")
    const exit = await Effect.runPromiseExit(
      attemptSync(() => {
        throw error
      })
    )
    expect(Exit.isFailure(exit) && Cause.isDie(exit.cause)).toBe(true)
    expect(expectedError(error)).toBeUndefined()
    expect(externalError(error, "Fixture")).toBeUndefined()
  })
  it("only serializes approved error details", () => {
    const decoded = decodeErrorData({
      code: "RATE_LIMITED",
      message: "Wait.",
      details: {
        retryAfterSeconds: 3,
        caseId: "moderation-case-fixture",
        credentials: "private",
        providerBody: "private",
        stack: "private",
      },
    })!
    expect(errorData(decoded).details).toEqual({
      retryAfterSeconds: 3,
      caseId: "moderation-case-fixture",
    })
  })
  it.each([
    ["VALIDATION", 400],
    ["UNAUTHORIZED", 401],
    ["FORBIDDEN", 403],
    ["NOT_FOUND", 404],
    ["METHOD_NOT_ALLOWED", 405],
    ["CONFLICT", 409],
    ["RATE_LIMITED", 429],
    ["NOT_CONFIGURED", 503],
    ["UNAVAILABLE", 503],
    ["TIMEOUT", 504],
    ["BAD_GATEWAY", 502],
    ["PAYLOAD_TOO_LARGE", 413],
    ["INTERNAL", 500],
  ] as const)("maps %s to HTTP %s", async (code, status) => {
    const response = await runHttp(
      Effect.fail(appError(code, "Safe message")),
      "fixture"
    )
    expect(response.status).toBe(status)
    expect(response.headers.get("Cache-Control")).toBe("no-store")
    expect((await response.json()).error.code).toBe(code)
  })
  it("keeps defects private, including a combined expected failure and cleanup defect", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    const cause = Cause.sequential(
      Cause.fail(appError("UNAVAILABLE", "Outage")),
      Cause.die(new Error("private cleanup detail"))
    )
    expect(failureError(cause).code).toBe("INTERNAL")
    const response = await runHttp(Effect.failCause(cause), "fixture")
    expect(response.status).toBe(500)
    expect(await response.text()).not.toMatch(/private|Fiber|cause|stack/)
    expect(JSON.stringify(log.mock.calls)).not.toContain(
      "private cleanup detail"
    )
    expect(log).toHaveBeenCalledTimes(1)
    await expect(
      runConvex(Effect.die(new Error("private defect")), "fixture")
    ).rejects.not.toBeInstanceOf(ConvexError)
  })
  it("preserves known fetch/SDK failures without reading provider messages", async () => {
    expect(
      externalError({ status: 503, message: "secret" }, "Provider")
    ).toMatchObject({ code: "UNAVAILABLE" })
    expect(externalError({ status: 401 }, "Provider")).toMatchObject({
      code: "NOT_CONFIGURED",
    })
    expect(externalError({ status: 400 }, "Provider")).toMatchObject({
      code: "BAD_GATEWAY",
    })
    expect(externalError({ code: "ERR_JWKS_TIMEOUT" }, "WorkOS")).toMatchObject(
      { code: "TIMEOUT" }
    )
    expect(externalError({ code: "ERR_JWKS_INVALID" }, "WorkOS")).toMatchObject(
      { code: "BAD_GATEWAY" }
    )
    expect(
      externalError({ $metadata: { httpStatusCode: 429 } }, "Provider")
    ).toMatchObject({ code: "RATE_LIMITED" })
    expect(
      externalError(new Error("looks like a timeout"), "Provider")
    ).toBeUndefined()
    await expect(
      runEffect(
        fetchEffect(
          () => Promise.reject(new DOMException("private", "TimeoutError")),
          "Provider"
        )
      )
    ).rejects.toMatchObject({ code: "TIMEOUT" })
    await expect(
      runEffect(
        fetchEffect(
          () => Promise.reject(new TypeError("network failed")),
          "Provider"
        )
      )
    ).rejects.toMatchObject({ code: "UNAVAILABLE" })
    for (const code of Object.keys(
      errorStatuses
    ) as (keyof typeof errorStatuses)[]) {
      expect(isTransient(appError(code, "test"))).toBe(
        ["UNAVAILABLE", "TIMEOUT", "RATE_LIMITED"].includes(code)
      )
    }
  })
  it("does not let an unknown Promise rejection enter the expected error channel", async () => {
    const exit = await Effect.runPromiseExit(
      attempt(() => Promise.reject("private"))
    )
    expect(Exit.isFailure(exit) && Cause.isDie(exit.cause)).toBe(true)
  })
})
