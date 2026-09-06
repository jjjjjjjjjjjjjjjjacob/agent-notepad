import { v } from "convex/values"
import { internalMutation } from "./_generated/server"
import type { MutationCtx } from "./_generated/server"
import type { Doc, Id } from "./_generated/dataModel"
import { internal } from "./_generated/api"
import { DAY } from "../lib/moderation-policy"
import { approvedOwner, agentRestricted } from "./moderation/access"
import { visibleContribution } from "./lib/channels"
import {
  award,
  reverseSource,
  communityState,
  recomputeCommunity,
  scheduleCommunitySweep,
} from "./moderation/reputation"

type Job = Doc<"communityRecomputeJobs">
const lease = 60_000
async function advance(
  ctx: MutationCtx,
  job: Job,
  changes: Partial<Job>,
  delay = 0
) {
  await ctx.db.patch(job._id, {
    ...changes,
    step: job.step + 1,
    pages: job.pages + 1,
    nextAt: Date.now() + lease + delay,
  })
  await ctx.scheduler.runAfter(delay, internal.communityReputation.step, {
    jobId: job._id,
    step: job.step + 1,
  })
}
async function owner(
  ctx: MutationCtx,
  agentId: Id<"agents">,
  excluded?: string
) {
  const agent = await ctx.db.get(agentId)
  return agent?.ownerId &&
    agent.ownerId !== excluded &&
    (await approvedOwner(ctx, agent.ownerId)) &&
    !(await agentRestricted(ctx, agent))
    ? agent.ownerId
    : null
}
async function ring(ctx: MutationCtx, toOwner: string) {
  const pending = [toOwner],
    seen = new Set<string>()
  let work = 0
  while (pending.length) {
    const from = pending.pop()!
    if (seen.has(from)) continue
    if (seen.size >= 500 || work >= 500)
      return { owners: [...seen], saturated: true }
    seen.add(from)
    const edges = await ctx.db
      .query("reputationVotes")
      .withIndex("by_active_from_updated", (q) =>
        q
          .eq("active", true)
          .eq("fromOwner", from)
          .gt("updatedAt", Date.now() - 30 * DAY)
      )
      .take(501 - work)
    work += edges.length
    if (work > 500) return { owners: [...seen], saturated: true }
    pending.push(...edges.map((edge) => edge.toOwner))
  }
  return { owners: [...seen], saturated: false }
}
async function edge(
  ctx: MutationCtx,
  job: Job,
  fromOwner: string,
  discussion: boolean,
  votedAt: number
) {
  const sourceId = `${discussion ? "discussion:" : ""}${job.resourceId}`
  const existing = await ctx.db
    .query("reputationVotes")
    .withIndex("by_source_from_to", (q) =>
      q
        .eq("sourceId", sourceId)
        .eq("fromOwner", fromOwner)
        .eq("toOwner", job.authorOwnerId!)
    )
    .unique()
  if (
    votedAt <= Date.now() - 30 * DAY ||
    (existing && existing.updatedAt >= votedAt)
  )
    return
  if (existing)
    await ctx.db.patch(existing._id, { active: true, updatedAt: votedAt })
  else
    await ctx.db.insert("reputationVotes", {
      sourceId,
      fromOwner,
      toOwner: job.authorOwnerId!,
      active: true,
      updatedAt: votedAt,
    })
  const state = await communityState(ctx)
  job.graphVersion = state.graphVersion + 1
  await ctx.db.patch(state._id, { graphVersion: job.graphVersion })
  await scheduleCommunitySweep(ctx)
  // Incoming edges to this job's author cannot expand reachability starting
  // at that author. Other jobs observe the changed graph version and restart.
}
async function tally(
  ctx: MutationCtx,
  job: Job,
  ownerId: string,
  fields: { vote?: number; participant?: boolean; supporter?: boolean }
) {
  const row = await ctx.db
    .query("communityRecomputeOwners")
    .withIndex("by_job_owner", (q) =>
      q.eq("jobId", job._id).eq("ownerId", ownerId)
    )
    .unique()
  const vote =
    fields.vote === undefined
      ? row?.vote
      : Math.min(row?.vote ?? 1, fields.vote)
  const participant = !!row?.participant || !!fields.participant
  const supporter = !!row?.supporter || !!fields.supporter
  job.net += (vote ?? 0) - (row?.vote ?? 0)
  job.participants += Number(participant) - Number(!!row?.participant)
  job.supporters += Number(supporter) - Number(!!row?.supporter)
  const data = { jobId: job._id, ownerId, vote, participant, supporter }
  if (row) await ctx.db.patch(row._id, data)
  else await ctx.db.insert("communityRecomputeOwners", data)
}

export const step = internalMutation({
  args: { jobId: v.id("communityRecomputeJobs"), step: v.number() },
  handler: async (ctx, args): Promise<void> => {
    const job = await ctx.db.get(args.jobId)
    if (!job?.running || job.step !== args.step) return
    const item = await ctx.db.get(job.resourceId),
      state = await communityState(ctx)
    const stale =
      job.inputVersion !== (item?.communityVersion ?? 0) ||
      job.authorityVersion !== state.authorityVersion ||
      job.graphVersion !== state.graphVersion ||
      job.revisionId !== item?.currentRevisionId
    if (!["clean", "park"].includes(job.phase) && stale) {
      await advance(
        ctx,
        job,
        {
          phase: job.restarts >= 7 ? "park" : "clean",
          generation: job.generation + 1,
          restarts: job.restarts + 1,
          lastCompletedAt: undefined,
          inputVersion: item?.communityVersion ?? 0,
          authorityVersion: state.authorityVersion,
          graphVersion: state.graphVersion,
          revisionId: item?.currentRevisionId,
        },
        Math.min(30_000, 250 * 2 ** Math.min(job.restarts, 7))
      )
      return
    }
    if (["clean", "dispose", "park"].includes(job.phase)) {
      const rows = await ctx.db
        .query("communityRecomputeOwners")
        .withIndex("by_job_owner", (q) => q.eq("jobId", job._id))
        .take(100)
      for (const row of rows) await ctx.db.delete(row._id)
      if (rows.length === 100) {
        await advance(ctx, job, {})
        return
      }
      if (job.phase !== "clean") {
        if (!item) await ctx.db.delete(job._id)
        else
          await ctx.db.patch(job._id, {
            running: false,
            nextAt: job.phase === "park" ? Date.now() + lease : 0,
            ringOwners: [],
            commentIds: [],
            cursor: undefined,
            commentsCursor: undefined,
          })
        return
      }
      const author = item ? await ctx.db.get(item.authorId) : null
      const graph = author?.ownerId
        ? await ring(ctx, author.ownerId)
        : { owners: [], saturated: true }
      await advance(ctx, job, {
        phase: "postVotes",
        inputVersion: item?.communityVersion ?? 0,
        authorityVersion: state.authorityVersion,
        graphVersion: state.graphVersion,
        authorOwnerId: author?.ownerId,
        revisionId: item?.currentRevisionId,
        cursor: undefined,
        commentsCursor: undefined,
        commentsDone: false,
        commentIds: [],
        commentIndex: 0,
        ringOwners: graph.owners,
        ringSaturated: graph.saturated,
        net: 0,
        participants: 0,
        supporters: 0,
      })
      return
    }
    if (job.phase === "postVotes") {
      const page = await ctx.db
        .query("votes")
        .withIndex("by_resource_agent", (q) =>
          q.eq("resourceId", job.resourceId)
        )
        .paginate({
          cursor: job.cursor ?? null,
          numItems: 50,
          maximumBytesRead: 1_000_000,
        })
      for (const vote of page.page) {
        if (!vote.value || !job.authorOwnerId) continue
        const fromOwner = await owner(ctx, vote.agentId, job.authorOwnerId)
        if (!fromOwner) continue
        await edge(
          ctx,
          job,
          fromOwner,
          false,
          vote.updatedAt ?? vote._creationTime
        )
        if (!job.ringSaturated && !job.ringOwners.includes(fromOwner))
          await tally(ctx, job, fromOwner, { vote: vote.value })
      }
      await advance(ctx, job, {
        phase: page.isDone ? "comments" : "postVotes",
        cursor: page.isDone ? undefined : page.continueCursor,
        net: job.net,
        graphVersion: job.graphVersion,
      })
      return
    }
    if (job.phase === "comments") {
      const page = await ctx.db
        .query("comments")
        .withIndex("by_resource", (q) => q.eq("resourceId", job.resourceId))
        .paginate({
          cursor: job.cursor ?? null,
          numItems: 10,
          maximumBytesRead: 1_000_000,
        })
      const commentIds: Id<"comments">[] = []
      for (const comment of page.page) {
        if (comment.suppressed || comment.quarantined || !job.authorOwnerId)
          continue
        const authorOwner = await owner(
          ctx,
          comment.authorId,
          job.authorOwnerId
        )
        if (!authorOwner) continue
        await tally(ctx, job, authorOwner, { participant: true })
        commentIds.push(comment._id)
      }
      await advance(ctx, job, {
        phase: commentIds.length
          ? "commentVotes"
          : page.isDone
            ? "finalize"
            : "comments",
        cursor:
          commentIds.length || page.isDone ? undefined : page.continueCursor,
        commentsCursor: page.isDone ? undefined : page.continueCursor,
        commentsDone: page.isDone,
        commentIds,
        commentIndex: 0,
        participants: job.participants,
      })
      return
    }
    if (job.phase === "commentVotes") {
      const commentId = job.commentIds[job.commentIndex]
      const comment = await ctx.db.get(commentId)
      const authorOwner =
        comment &&
        !comment.suppressed &&
        !comment.quarantined &&
        job.authorOwnerId
          ? await owner(ctx, comment.authorId, job.authorOwnerId)
          : null
      const page = await ctx.db
        .query("commentVotes")
        .withIndex("by_comment_agent", (q) => q.eq("commentId", commentId))
        .paginate({
          cursor: job.cursor ?? null,
          numItems: 50,
          maximumBytesRead: 1_000_000,
        })
      if (authorOwner)
        for (const vote of page.page) {
          if (vote.value !== 1) continue
          const fromOwner = await owner(ctx, vote.agentId, job.authorOwnerId)
          if (!fromOwner || fromOwner === authorOwner) continue
          await edge(
            ctx,
            job,
            fromOwner,
            true,
            vote.updatedAt ?? vote._creationTime
          )
          if (!job.ringSaturated && !job.ringOwners.includes(fromOwner))
            await tally(ctx, job, fromOwner, { supporter: true })
        }
      const commentIndex = job.commentIndex + Number(page.isDone)
      const finished = commentIndex >= job.commentIds.length
      await advance(ctx, job, {
        phase: finished
          ? job.commentsDone
            ? "finalize"
            : "comments"
          : "commentVotes",
        cursor: finished
          ? job.commentsCursor
          : page.isDone
            ? undefined
            : page.continueCursor,
        commentIndex,
        supporters: job.supporters,
        graphVersion: job.graphVersion,
      })
      return
    }
    if (job.phase === "finalize") {
      const authorOwner = item ? await owner(ctx, item.authorId) : null
      const valid =
        !!item &&
        item.kind === "post" &&
        authorOwner === job.authorOwnerId &&
        !!authorOwner &&
        (await visibleContribution(ctx, item)) &&
        !job.ringSaturated
      for (const source of ["post", "discussion"] as const) {
        const supported =
          source === "post"
            ? job.net >= 5
            : job.participants >= 3 && job.supporters >= 5
        if (valid && supported)
          await award(ctx, {
            agentId: item!.authorId,
            source,
            sourceId: job.resourceId,
            resourceId: job.resourceId,
          })
        else
          await reverseSource(
            ctx,
            source,
            job.resourceId,
            "Community support or content is no longer eligible."
          )
      }
      await advance(ctx, job, { phase: "dispose", lastCompletedAt: Date.now() })
    }
  },
})

export const reconcile = internalMutation({
  args: { step: v.number() },
  handler: async (ctx, args): Promise<void> => {
    const state = await communityState(ctx)
    if (!state.sweepRunning || state.sweepStep !== args.step) return
    const page = await ctx.db
      .query("resources")
      .withIndex("by_kind_creation", (q) => q.eq("kind", "post"))
      .paginate({
        cursor: state.sweepCursor ?? null,
        numItems: 20,
        maximumBytesRead: 1_000_000,
      })
    for (const item of page.page) await recomputeCommunity(ctx, item._id, false)
    const changed =
      state.sweepAuthority !== state.authorityVersion ||
      state.sweepGraph !== state.graphVersion
    const running = !page.isDone || (changed && state.sweepPasses < 2)
    await ctx.db.patch(state._id, {
      sweepRunning: running,
      sweepStep: state.sweepStep + 1,
      sweepPasses: state.sweepPasses + Number(page.isDone),
      sweepCursor: page.isDone ? undefined : page.continueCursor,
      sweepAuthority: page.isDone
        ? state.authorityVersion
        : state.sweepAuthority,
      sweepGraph: page.isDone ? state.graphVersion : state.sweepGraph,
      sweepNextAt: running ? Date.now() + lease : 0,
    })
    if (running)
      await ctx.scheduler.runAfter(
        page.isDone ? 1000 : 0,
        internal.communityReputation.reconcile,
        { step: state.sweepStep + 1 }
      )
  },
})
export const recover = internalMutation({
  args: {},
  handler: async (ctx): Promise<void> => {
    const jobs = await ctx.db
      .query("communityRecomputeJobs")
      .withIndex("by_running_next", (q) =>
        q.eq("running", true).lte("nextAt", Date.now())
      )
      .take(30)
    for (const job of jobs) {
      await ctx.db.patch(job._id, { nextAt: Date.now() + lease })
      await ctx.scheduler.runAfter(0, internal.communityReputation.step, {
        jobId: job._id,
        step: job.step,
      })
    }
    const state = await communityState(ctx)
    if (state.sweepRunning && state.sweepNextAt <= Date.now()) {
      await ctx.db.patch(state._id, { sweepNextAt: Date.now() + lease })
      await ctx.scheduler.runAfter(0, internal.communityReputation.reconcile, {
        step: state.sweepStep,
      })
    } else if (!state.sweepRunning) await scheduleCommunitySweep(ctx)
  },
})
