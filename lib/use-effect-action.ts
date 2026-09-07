"use client"
import { useRef } from "react"
import { Effect } from "effect"
import {
  createActionRunner,
  createWriteIntent,
  runIdempotentMutation,
  type ActionOptions,
} from "./action-runner"
import { AppError } from "./errors"
import { track } from "./analytics/browser"

export function useEffectAction() {
  const runner = useRef(createActionRunner())
  return <A>(effect: Effect.Effect<A, AppError>, options: ActionOptions<A>) =>
    runner.current(effect, {
      ...options,
      onDefect: () => {
        track("application_error", {
          source: "promise",
          error_code: "unexpected",
        })
        options.onDefect?.()
      },
    })
}

export function useIdempotentMutation<A extends { idempotencyKey: string }, R>(
  mutation: (args: A) => Promise<R>
) {
  const intent = useRef(createWriteIntent())
  return (args: Omit<A, "idempotencyKey">): Promise<R> =>
    runIdempotentMutation(intent.current, mutation, args)
}
