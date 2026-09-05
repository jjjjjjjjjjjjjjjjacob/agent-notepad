/// <reference types="vite/client" />
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"
import { convexTest } from "convex-test"
import schema from "../convex/schema"
import { internal, api } from "../convex/_generated/api"
import { digest } from "../lib/hash"
import type { Id } from "../convex/_generated/dataModel"
const modules = import.meta.glob("../convex/**/*.ts")
function setup() {
  return convexTest(schema, modules)
}
type Test = ReturnType<typeof setup>
async function agent(
  t: Test,
  slug: string,
  role: "editor" | "moderator" | "operator" = "editor"
) {
  const token = `test-key-${slug}`
  const result = await t.mutation(internal.agents.create, {
    input: { name: slug, slug },
    hash: digest(token),
    prefix: "test-key",
  })
  if (role !== "editor")
    await t.run(async (ctx) => ctx.db.patch(result.agentId, { role }))
  return { token, ...result }
}
async function command(
  t: Test,
  token: string,
  operation: string,
  input: unknown,
  idempotencyKey?: string
) {
  return t.mutation(internal.commands.execute, {
    token,
    operation,
    input,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  })
}
async function article(t: Test, token: string, slug = "test-article") {
  return (await command(t, token, "publish", {
    kind: "wiki",
    slug,
    title: "Test article",
    body: "Original sourced claim.",
  })) as { id: Id<"resources">; revisionId: Id<"revisions">; slug: string }
}
beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})
describe("publication and permissions", () => {
  it("publishes immediately, rejects stale writes, and appends attributed reverts", async () => {
    const t = setup()
    const a = await agent(t, "writer-a")
    const b = await agent(t, "writer-b")
    const first = await article(t, a.token)
    const read = await t.query(api.public.getResource, { slugOrId: first.id })
    expect(read?.revision.id).toBe(first.revisionId)
    const edit = (await command(t, b.token, "edit", {
      id: first.id,
      baseRevisionId: first.revisionId,
      body: "A corrected claim.",
      summary: "Correct the example",
    })) as { revisionId: Id<"revisions"> }
    await expect(
      command(t, a.token, "edit", {
        id: first.id,
        baseRevisionId: first.revisionId,
        body: "Stale overwrite",
        summary: "Stale",
      })
    ).rejects.toThrow("CONFLICT")
    const revert = (await command(t, a.token, "revert", {
      id: first.id,
      baseRevisionId: edit.revisionId,
      targetRevisionId: first.revisionId,
      summary: "Restore the earlier wording",
    })) as { revisionId: string }
    expect(revert.revisionId).not.toBe(first.revisionId)
    const current = await t.query(api.public.getResource, {
      slugOrId: first.id,
    })
    expect(current?.revision.body).toBe("Original sourced claim.")
    expect(current?.revision.author.id).toBe(a.agentId)
    expect(
      (
        await t.query(api.public.history, {
          resourceId: first.id,
          paginationOpts: { cursor: null, numItems: 25 },
        })
      ).items
    ).toHaveLength(3)
  })
  it("retries atomically and detects idempotency-key reuse", async () => {
    const t = setup()
    const a = await agent(t, "idempotent-agent")
    const input = { kind: "note", title: "A note", body: "One effect" }
    const results = await Promise.all([
      command(t, a.token, "publish", input, "request-1"),
      command(t, a.token, "publish", input, "request-1"),
    ])
    expect(results[0]).toEqual(results[1])
    await expect(
      command(
        t,
        a.token,
        "publish",
        { ...input, body: "Different effect" },
        "request-1"
      )
    ).rejects.toThrow("CONFLICT")
    expect(
      (
        await t.query(api.public.listResources, {
          kind: "note",
          paginationOpts: { cursor: null, numItems: 25 },
        })
      ).items
    ).toHaveLength(1)
  })
  it("enforces key scopes separately from roles and immediately honors revocation", async () => {
    const t = setup()
    const a = await agent(t, "scoped-agent")
    const page = await article(t, a.token)
    await expect(
      command(t, a.token, "protect", {
        resourceId: page.id,
        mode: "locked",
        reason: "No global role",
      })
    ).rejects.toThrow("FORBIDDEN")
    const key = await t.mutation(internal.agents.issueKey, {
      tokenHash: digest(a.token),
      hash: digest("narrow-key"),
      prefix: "narrow",
      scopes: ["social:write"],
      label: "Social only",
    })
    await expect(
      command(t, "narrow-key", "publish", {
        kind: "wiki",
        slug: "blocked-article",
        title: "No",
        body: "No",
      })
    ).rejects.toThrow("FORBIDDEN")
    await expect(
      command(t, "narrow-key", "edit", {
        id: page.id,
        baseRevisionId: page.revisionId,
        body: "No",
        summary: "No",
      })
    ).rejects.toThrow("FORBIDDEN")
    await command(t, a.token, "revoke_key", { keyId: key.keyId })
    await expect(
      command(t, "narrow-key", "publish", {
        kind: "note",
        title: "No",
        body: "No",
      })
    ).rejects.toThrow("UNAUTHORIZED")
  })
  it("holds protected edits, forbids self-review, and rejects an outdated pending base", async () => {
    const t = setup()
    const a = await agent(t, "ordinary-agent")
    const mod = await agent(t, "moderator-agent", "moderator")
    const other = await agent(t, "second-moderator", "moderator")
    const page = await article(t, a.token)
    await command(t, mod.token, "protect", {
      resourceId: page.id,
      mode: "pending",
      reason: "Temporary edit dispute",
      hours: 1,
    })
    const pending = (await command(t, a.token, "edit", {
      id: page.id,
      baseRevisionId: page.revisionId,
      body: "Pending claim",
      summary: "Proposed change",
    })) as { revisionId: Id<"revisions">; status: string }
    expect(pending.status).toBe("pending")
    expect(
      (await t.query(api.public.getResource, { slugOrId: page.id }))?.revision
        .id
    ).toBe(page.revisionId)
    await t.run(async (ctx) => ctx.db.patch(a.agentId, { role: "moderator" }))
    await expect(
      command(t, a.token, "review_pending", {
        resourceId: page.id,
        revisionId: pending.revisionId,
        verdict: "accept",
        reason: "My own change",
      })
    ).rejects.toThrow("FORBIDDEN")
    await command(t, other.token, "edit", {
      id: page.id,
      baseRevisionId: page.revisionId,
      body: "Another published change",
      summary: "A concurrent change",
    })
    await expect(
      command(t, mod.token, "review_pending", {
        resourceId: page.id,
        revisionId: pending.revisionId,
        verdict: "accept",
        reason: "Accept old edit",
      })
    ).rejects.toThrow("CONFLICT")
    await command(t, mod.token, "review_pending", {
      resourceId: page.id,
      revisionId: pending.revisionId,
      verdict: "reject",
      reason: "Needs rebasing on current revision",
    })
    vi.advanceTimersByTime(61 * 60000)
    expect(
      (await t.query(api.public.getResource, { slugOrId: page.id }))?.protection
    ).toBe("open")
  })
})
describe("task coordination", () => {
  it("clears superseded work beyond the first batch while retaining a new pending edit", async () => {
    const t = setup()
    const author = await agent(t, "long-history-author")
    const mod = await agent(t, "long-history-moderator", "moderator")
    const page = await article(t, author.token)
    await t.run(async (ctx) => {
      for (let i = 0; i < 305; i++)
        await ctx.db.insert("tasks", {
          type: "maintenance",
          topic: "general",
          title: "Historical maintenance",
          description: "Synthetic long-history fixture",
          targetId: page.id,
          revisionId: page.revisionId,
          creatorId: author.agentId,
          dedupeKey: `history-${i}`,
          status: "open",
          issueOpen: false,
          random: i / 306,
          updatedAt: Date.now(),
        })
    })
    const next = (await command(t, author.token, "edit", {
      id: page.id,
      baseRevisionId: page.revisionId,
      body: "New current revision",
      summary: "Supersede historical work",
    })) as { revisionId: Id<"revisions"> }
    await command(t, mod.token, "protect", {
      resourceId: page.id,
      mode: "pending",
      reason: "Temporary protection",
    })
    const pending = (await command(t, author.token, "edit", {
      id: page.id,
      baseRevisionId: next.revisionId,
      body: "Pending change based on the new revision",
      summary: "Current pending proposal",
    })) as { revisionId: Id<"revisions"> }
    await t.finishAllScheduledFunctions(() => vi.runAllTimers())
    const tasks = await t.run((ctx) =>
      ctx.db
        .query("tasks")
        .withIndex("by_target", (q) => q.eq("targetId", page.id))
        .collect()
    )
    expect(
      tasks
        .filter((task) => task.revisionId === page.revisionId)
        .every((task) => task.status === "cancelled")
    ).toBe(true)
    expect(
      tasks.find((task) => task.revisionId === pending.revisionId)?.status
    ).toBe("open")
    expect(
      tasks.find((task) => task.revisionId === next.revisionId)?.status
    ).toBe("open")
  })
  it("excludes the author and grants a task to only one concurrent claimant", async () => {
    const t = setup()
    const author = await agent(t, "task-author")
    const workers = await Promise.all([
      agent(t, "worker-one"),
      agent(t, "worker-two"),
      agent(t, "worker-three"),
    ])
    await article(t, author.token)
    const own = (await command(t, author.token, "request_work", {
      types: ["patrol"],
    })) as { status: string }
    expect(own.status).toBe("waiting")
    await Promise.all(
      workers.map((w) =>
        command(t, w.token, "request_work", { types: ["patrol"] })
      )
    )
    const active = await t.run((ctx) =>
      ctx.db
        .query("assignments")
        .filter((q) => q.eq(q.field("status"), "active"))
        .collect()
    )
    expect(active).toHaveLength(1)
    const repeat = await command(t, workers[0].token, "request_work", {
      types: ["patrol"],
    })
    expect(repeat).toBeTruthy()
    const all = await t.run((ctx) => ctx.db.query("assignments").collect())
    expect(all.filter((a) => a.agentId === workers[0].agentId)).toHaveLength(1)
  })
  it("preserves FIFO eligibility and recovers expired leases", async () => {
    const t = setup()
    const author = await agent(t, "fifo-author")
    const first = await agent(t, "fifo-first")
    const second = await agent(t, "fifo-second")
    await command(t, first.token, "request_work", {
      types: ["patrol"],
      budgetMinutes: 1,
    })
    vi.advanceTimersByTime(1)
    await command(t, second.token, "request_work", {
      types: ["patrol"],
      budgetMinutes: 20,
    })
    await article(t, author.token)
    await t.mutation(internal.work.matchWaiting, {})
    expect(
      (await t.query(api.public.myWork, { token: first.token }))?.status
    ).toBe("active")
    vi.advanceTimersByTime(61000)
    await t.mutation(internal.work.recover, {})
    await t.mutation(internal.work.matchWaiting, {})
    expect(
      (await t.query(api.public.myWork, { token: second.token }))?.status
    ).toBe("active")
  })
  it("requires real pending decisions before a reviewer can complete work", async () => {
    const t = setup()
    const author = await agent(t, "pending-author")
    const mod = await agent(t, "pending-reviewer", "moderator")
    const page = await article(t, author.token)
    await command(t, mod.token, "protect", {
      resourceId: page.id,
      mode: "pending",
      reason: "Selected protected page",
    })
    const pending = (await command(t, author.token, "edit", {
      id: page.id,
      baseRevisionId: page.revisionId,
      body: "Proposed wording",
      summary: "Evidence-based correction",
    })) as { revisionId: Id<"revisions"> }
    const lease = (await command(t, mod.token, "request_work", {
      types: ["edit_request"],
    })) as { _id: Id<"assignments"> }
    const input = {
      assignmentId: lease._id,
      verdict: "checked",
      report: "Checked the exact proposed revision and its evidence.",
      log: "Read revision and inspected supplied sources.",
    }
    await expect(command(t, mod.token, "submit_work", input)).rejects.toThrow(
      "CONFLICT"
    )
    await command(t, mod.token, "review_pending", {
      resourceId: page.id,
      revisionId: pending.revisionId,
      verdict: "accept",
      reason: "The evidence supports this change",
    })
    await command(t, mod.token, "submit_work", input)
    expect(await t.query(api.public.myWork, { token: mod.token })).toBeNull()
  })
  it("records a worker's correction against the old revision without changing a newer one", async () => {
    const t = setup()
    const author = await agent(t, "correction-author")
    const worker = await agent(t, "correction-worker")
    const page = await article(t, author.token)
    const lease = (await command(t, worker.token, "request_work", {
      types: ["patrol"],
    })) as { _id: Id<"assignments"> }
    const correction = (await command(t, worker.token, "edit", {
      id: page.id,
      baseRevisionId: page.revisionId,
      body: "Corrected claim",
      summary: "Fix based on source evidence",
    })) as { revisionId: Id<"revisions"> }
    const newer = (await command(t, author.token, "edit", {
      id: page.id,
      baseRevisionId: correction.revisionId,
      body: "Newer independent revision",
      summary: "Add more context",
    })) as { revisionId: Id<"revisions"> }
    const report = (await command(t, worker.token, "submit_work", {
      assignmentId: lease._id,
      verdict: "corrected",
      report: "Corrected the assigned revision based on the source.",
      resultResourceId: page.id,
      resultRevisionId: correction.revisionId,
      log: "Retrieved revision; inspected source; published correction.",
    })) as { reportId: Id<"reports"> }
    expect(
      (await t.query(api.public.getResource, { slugOrId: page.id }))?.revision
        .id
    ).toBe(newer.revisionId)
    expect(
      (await t.query(api.public.getReport, { id: report.reportId }))?.historical
    ).toBe(true)
    expect(await t.query(api.public.myWork, { token: worker.token })).toBeNull()
  })
  it("rejects stale claims that did not produce a verifiable correction", async () => {
    const t = setup()
    const author = await agent(t, "stale-author")
    const worker = await agent(t, "stale-worker")
    const page = await article(t, author.token)
    const lease = (await command(t, worker.token, "request_work", {
      types: ["patrol"],
    })) as { _id: Id<"assignments"> }
    await command(t, author.token, "edit", {
      id: page.id,
      baseRevisionId: page.revisionId,
      body: "New facts",
      summary: "New revision",
    })
    await expect(
      command(t, worker.token, "submit_work", {
        assignmentId: lease._id,
        verdict: "issue",
        report: "This report refers to an outdated version.",
        log: "Old evidence",
      })
    ).rejects.toThrow("CONFLICT")
    expect(
      (await t.query(api.public.getResource, { slugOrId: page.id }))?.disputed
    ).toBe(false)
  })
})
describe("takedowns and files", () => {
  it("removes knowledge-gap reports and logs with their resulting contribution", async () => {
    const t = setup()
    const author = await agent(t, "gap-requester")
    const worker = await agent(t, "gap-worker")
    const moderator = await agent(t, "gap-moderator", "moderator")
    await command(t, author.token, "raise_issue", {
      type: "knowledge_gap",
      description: "Write a useful public explanation.",
    })
    const lease = (await command(t, worker.token, "request_work", {
      types: ["knowledge_gap"],
    })) as { _id: Id<"assignments"> }
    const page = await article(t, worker.token, "gap-result")
    const report = (await command(t, worker.token, "submit_work", {
      assignmentId: lease._id,
      verdict: "checked",
      resultResourceId: page.id,
      report: "Created the requested article.",
      log: "Public task output that must follow the article takedown.",
    })) as { reportId: Id<"reports"> }
    expect(
      (await t.query(api.public.getReport, { id: report.reportId }))?.targetId
    ).toBe(page.id)
    await command(t, moderator.token, "suppress", {
      resourceId: page.id,
      reason: "Synthetic takedown verification",
    })
    expect(
      await t.query(api.public.getReport, { id: report.reportId })
    ).toBeNull()
    await t.mutation(internal.moderationCleanup.purge, {
      resourceId: page.id,
      phase: "reports",
    })
    expect(
      await t.query(api.public.getReport, { id: report.reportId })
    ).toBeNull()
    const stored = await t.run((ctx) => ctx.db.get(report.reportId))
    expect(stored?.log).toBeUndefined()
    expect(stored?.report).toBe("[Removed]")
  })
  it("hides every revision and search result synchronously, then purges stored evidence", async () => {
    const t = setup()
    const author = await agent(t, "takedown-author")
    const moderator = await agent(t, "takedown-moderator", "moderator")
    const page = await article(t, author.token)
    await command(t, author.token, "comment", {
      resourceId: page.id,
      body: "Comment to remove",
    })
    await command(t, moderator.token, "suppress", {
      resourceId: page.id,
      reason: "Valid content removal request",
    })
    expect(
      await t.query(api.public.getResource, { slugOrId: page.id })
    ).toBeNull()
    expect(
      await t.query(api.public.getResource, {
        slugOrId: page.id,
        revisionId: page.revisionId,
      })
    ).toBeNull()
    await expect(
      t.query(api.public.history, {
        resourceId: page.id,
        paginationOpts: { cursor: null, numItems: 25 },
      })
    ).rejects.toThrow("NOT_FOUND")
    expect(
      await t.query(api.search.keyword, { query: "Original" })
    ).toHaveLength(0)
    for (const phase of [
      "revisions",
      "comments",
      "tasks",
      "reports",
      "events",
    ] as const)
      await t.mutation(internal.moderationCleanup.purge, {
        resourceId: page.id,
        phase,
      })
    const rev = await t.run((ctx) => ctx.db.get(page.revisionId))
    expect(rev?.body).toBe("[Removed]")
    const comments = await t.run((ctx) => ctx.db.query("comments").collect())
    expect(comments[0].body).toBe("[Removed]")
  })
  it("prevents attaching another agent's files and claiming already-owned storage bytes", async () => {
    const t = setup()
    const first = await agent(t, "file-owner")
    const second = await agent(t, "file-intruder")
    const firstIntent = (await command(t, first.token, "create_upload", {
      filename: "evidence.txt",
      contentType: "text/plain",
    })) as { uploadId: Id<"files"> }
    const secondIntent = (await command(t, second.token, "create_upload", {
      filename: "other.txt",
      contentType: "text/plain",
    })) as { uploadId: Id<"files"> }
    const storageId = await t.run((ctx) =>
      ctx.storage.store(new Blob(["Public evidence"], { type: "text/plain" }))
    )
    await command(t, first.token, "finish_upload", {
      uploadId: firstIntent.uploadId,
      storageId,
    })
    await expect(
      command(t, second.token, "finish_upload", {
        uploadId: secondIntent.uploadId,
        storageId,
      })
    ).rejects.toThrow("FORBIDDEN")
    await expect(
      command(t, second.token, "publish", {
        kind: "note",
        title: "Wrong file",
        body: "Attempt",
        attachmentIds: [firstIntent.uploadId],
      })
    ).rejects.toThrow("FORBIDDEN")
  })
})

describe("recovery and source jobs", () => {
  it("ignores a late completion from an earlier external-action attempt", async () => {
    const t = setup()
    const a = await agent(t, "late-job-author")
    const page = await article(t, a.token)
    const jobId = await t.run((ctx) =>
      ctx.db.insert("jobs", {
        kind: "source",
        resourceId: page.id,
        revisionId: page.revisionId,
        status: "pending",
        attempts: 0,
        nextAt: Date.now(),
      })
    )
    const first = await t.mutation(internal.jobs.start, { jobId })
    expect(first?.attempt).toBe(1)
    vi.advanceTimersByTime(11 * 60000)
    await t.mutation(internal.jobs.recover, {})
    const second = await t.mutation(internal.jobs.start, { jobId })
    expect(second?.attempt).toBe(2)
    await t.mutation(internal.jobs.finish, { jobId, attempt: 1 })
    expect((await t.run((ctx) => ctx.db.get(jobId)))?.status).toBe("running")
    await t.mutation(internal.jobs.finish, { jobId, attempt: 2 })
    expect((await t.run((ctx) => ctx.db.get(jobId)))?.status).toBe("completed")
  })
  it("reapplies takedowns before restored data can re-enter public reads", async () => {
    const t = setup()
    const a = await agent(t, "restore-author")
    const mod = await agent(t, "restore-moderator", "moderator")
    const page = await article(t, a.token)
    const note = (await command(t, a.token, "comment", {
      resourceId: page.id,
      body: "Private test fixture to redact",
    })) as { id: Id<"comments"> }
    await command(t, mod.token, "redact_comment", {
      commentId: note.id,
      reason: "Remove the synthetic sensitive fixture",
    })
    await command(t, mod.token, "suppress", {
      resourceId: page.id,
      reason: "Test a complete takedown replay",
    })
    const ledger = await t.query(internal.admin.takedownLedger, {})
    expect(ledger.entries.map((e) => e.action)).toContain("comment_redaction")
    // Simulate importing an older snapshot while the deployment is closed.
    await t.run(async (ctx) => {
      await ctx.db.patch(page.id, { suppressed: false })
      await ctx.db.patch(note.id, {
        body: "Private test fixture to redact",
        suppressed: false,
      })
    })
    await t.mutation(internal.admin.reapplyTakedowns, {
      entries: ledger.entries,
    })
    expect(
      await t.query(api.public.getResource, { slugOrId: page.id })
    ).toBeNull()
    expect((await t.run((ctx) => ctx.db.get(note.id)))?.body).toBe("[Removed]")
  })
  it("recovers lost scheduled actions and stops after the attempt budget", async () => {
    const t = setup()
    const a = await agent(t, "job-author")
    const page = await article(t, a.token)
    const jobId = await t.run((ctx) =>
      ctx.db.insert("jobs", {
        kind: "source",
        resourceId: page.id,
        revisionId: page.revisionId,
        status: "pending",
        attempts: 0,
        nextAt: Date.now() - 1,
      })
    )
    await t.mutation(internal.jobs.recover, {})
    expect((await t.run((ctx) => ctx.db.get(jobId)))?.status).toBe("retry")
    await t.run((ctx) =>
      ctx.db.patch(jobId, {
        status: "running",
        attempts: 4,
        nextAt: Date.now() - 1,
      })
    )
    await t.mutation(internal.jobs.recover, {})
    expect((await t.run((ctx) => ctx.db.get(jobId)))?.status).toBe("failed")
  })
  it("bounds external work without blocking ordinary publication", async () => {
    const t = setup()
    const a = await agent(t, "budget-author")
    const page = (await command(t, a.token, "publish", {
      kind: "wiki",
      slug: "budget-test",
      title: "Budget example",
      body: "A published claim with a source.",
      citations: [{ url: "https://example.com/", title: "Example" }],
    })) as { id: Id<"resources">; revisionId: Id<"revisions"> }
    await t.run((ctx) =>
      ctx.db.insert("limits", {
        bucket: "external:source",
        count: 1200,
        resetAt: Date.now() + 60000,
      })
    )
    const job = await t.run((ctx) =>
      ctx.db
        .query("jobs")
        .filter((q) =>
          q.and(
            q.eq(q.field("kind"), "source"),
            q.eq(q.field("resourceId"), page.id)
          )
        )
        .first()
    )
    expect(
      await t.mutation(internal.jobs.start, { jobId: job!._id })
    ).toBeNull()
    expect(
      (await t.query(api.public.getResource, { slugOrId: page.id }))?.revision
        .id
    ).toBe(page.revisionId)
    expect((await t.run((ctx) => ctx.db.get(job!._id)))?.status).toBe("retry")
  })
})
