import { Effect, Exit } from "effect"
import { z } from "zod"
import {
  AppError,
  appError,
  decodeErrorData,
  expectedError,
  internalError,
  type ErrorCode,
} from "./errors"
import {
  attempt,
  failureError,
  fetchEffect,
  isExpectedCause,
  reportFailure,
  responseJson,
} from "./effects"
import { stableJson } from "./hash"

export function userErrorMessage(error: AppError): string {
  switch (error.code) {
    case "UNAUTHORIZED":
      return "Sign in again or check your account credentials."
    case "NOT_CONFIGURED":
    case "UNAVAILABLE":
      return "This service is temporarily unavailable. Please try again later."
    case "TIMEOUT":
      return "The request timed out. Its outcome may be uncertain; retry the same request when the service recovers."
    case "BAD_GATEWAY":
      return "The service returned an unexpected response. Please try again later."
    case "INTERNAL":
      return "The request could not be completed."
    case "RATE_LIMITED": {
      const seconds = error.details?.retryAfterSeconds
      return typeof seconds === "number" && seconds > 0
        ? `Please wait ${Math.ceil(seconds)} seconds before trying again.`
        : "Too many requests. Please wait before trying again."
    }
    default:
      return error.message
  }
}
const statusCode = (status: number): ErrorCode =>
  (
    ({
      400: "VALIDATION",
      401: "UNAUTHORIZED",
      403: "FORBIDDEN",
      404: "NOT_FOUND",
      409: "CONFLICT",
      413: "PAYLOAD_TOO_LARGE",
      429: "RATE_LIMITED",
      500: "INTERNAL",
      502: "BAD_GATEWAY",
      503: "UNAVAILABLE",
      504: "TIMEOUT",
    }) as Record<number, ErrorCode>
  )[status] ?? "BAD_GATEWAY"
const statusMessage = (code: ErrorCode) =>
  (
    ({
      VALIDATION: "Check the submitted values and try again.",
      FORBIDDEN: "This account cannot perform that action.",
      NOT_FOUND: "This item is no longer available.",
      CONFLICT: "This item changed. Reload it before submitting a new request.",
      PAYLOAD_TOO_LARGE: "The submitted content is too large.",
    }) as Partial<Record<ErrorCode, string>>
  )[code] ?? "The request could not be completed."

export function jsonRequest<A>(
  url: string,
  input: unknown,
  schema: z.ZodType<A>
) {
  return Effect.gen(function* () {
    const response = yield* fetchEffect(
      () =>
        fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        }),
      "Account service"
    )
    const body = yield* responseJson(response, "Account service").pipe(
      Effect.catchIf(
        () => !response.ok,
        () => Effect.succeed(null)
      )
    )
    const wireError =
      body && typeof body === "object" && "error" in body
        ? body.error
        : undefined
    if (!response.ok || wireError) {
      const known = decodeErrorData(wireError)
      const code = response.ok ? "FORBIDDEN" : statusCode(response.status)
      const retry = Number(response.headers.get("Retry-After"))
      return yield* Effect.fail(
        known ??
          appError(
            code,
            statusMessage(code),
            retry > 0 && Number.isFinite(retry)
              ? { retryAfterSeconds: retry }
              : undefined
          )
      )
    }
    const parsed = schema.safeParse(body)
    if (!parsed.success)
      return yield* Effect.fail(
        appError("BAD_GATEWAY", "The service returned an invalid response.")
      )
    return parsed.data
  })
}

export function authAction<
  A extends {
    error?: { status?: number; message?: string; code?: string } | null
  },
>(operation: () => Promise<A>) {
  return attempt(
    operation,
    (error) =>
      expectedError(error) ??
      (error instanceof TypeError
        ? appError("UNAVAILABLE", "Account service is unavailable.")
        : undefined)
  ).pipe(
    Effect.flatMap((result) => {
      if (!result.error) return Effect.succeed(result)
      const code = statusCode(result.error.status ?? 400)
      return Effect.fail(appError(code, statusMessage(code)))
    })
  )
}

export type ActionOutcome<A> =
  | { status: "success"; value: A }
  | { status: "failure"; error: AppError }
  | { status: "busy" }
export type ActionOptions<A> = {
  setBusy: (busy: boolean) => void
  setError: (message: string) => void
  onSuccess?: (value: A) => void
  onFailure?: (error: AppError) => void
  onDefect?: () => void
}
export function createActionRunner() {
  let busy = false
  return async <A>(
    effect: Effect.Effect<A, AppError>,
    options: ActionOptions<A>
  ): Promise<ActionOutcome<A>> => {
    if (busy) return { status: "busy" }
    busy = true
    try {
      // Success callbacks are part of this boundary too, so their defects cannot reject an event handler.
      const exit = await Effect.runPromiseExit(
        Effect.sync(() => {
          options.setBusy(true)
          options.setError("")
        }).pipe(
          Effect.zipRight(effect),
          Effect.tap((value) => Effect.sync(() => options.onSuccess?.(value)))
        )
      )
      if (Exit.isSuccess(exit)) return { status: "success", value: exit.value }
      let error = failureError(exit.cause)
      const callbacks = Effect.runSyncExit(
        Effect.sync(() => {
          options.setError(userErrorMessage(error))
          options.onFailure?.(error)
        })
      )
      if (Exit.isFailure(callbacks)) {
        error = internalError()
        // Keep a broken callback inside the event boundary as well.
        const feedback = Effect.runSyncExit(
          Effect.sync(() => options.setError(userErrorMessage(error)))
        )
        if (Exit.isFailure(feedback))
          reportFailure("frontend_feedback", feedback.cause)
      }
      if (!isExpectedCause(exit.cause) || Exit.isFailure(callbacks)) {
        const reported = Effect.runSyncExit(
          Effect.sync(() => options.onDefect?.())
        )
        if (Exit.isFailure(reported))
          reportFailure("frontend_reporting", reported.cause)
      }
      return { status: "failure", error }
    } finally {
      busy = false
      const cleanup = Effect.runSyncExit(
        Effect.sync(() => options.setBusy(false))
      )
      if (Exit.isFailure(cleanup))
        reportFailure("frontend_cleanup", cleanup.cause)
    }
  }
}

/** One in-memory write intent; no credentials or payloads are persisted to browser storage. */
export function createWriteIntent(
  newKey: () => string = () => crypto.randomUUID()
) {
  let intent: { fingerprint: string; key: string } | undefined
  return {
    key(input: unknown) {
      const fingerprint = stableJson(input)
      if (!intent || intent.fingerprint !== fingerprint)
        intent = { fingerprint, key: newKey() }
      return intent.key
    },
    complete(key: string) {
      if (intent?.key === key) intent = undefined
    },
  }
}

export async function runIdempotentMutation<
  A extends { idempotencyKey: string },
  R,
>(
  intent: ReturnType<typeof createWriteIntent>,
  mutation: (args: A) => Promise<R>,
  args: Omit<A, "idempotencyKey">
): Promise<R> {
  const key = intent.key(args)
  try {
    const result = await mutation({ ...args, idempotencyKey: key } as A)
    intent.complete(key)
    return result
  } catch (error) {
    const known = expectedError(error)
    if (
      known &&
      !["TIMEOUT", "UNAVAILABLE", "INTERNAL", "BAD_GATEWAY"].includes(
        known.code
      )
    )
      intent.complete(key)
    throw error
  }
}
