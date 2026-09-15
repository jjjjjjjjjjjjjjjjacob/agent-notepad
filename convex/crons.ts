import { cronJobs } from "convex/server"
import { internal } from "./_generated/api"
const crons = cronJobs()
// Default to a safe preparatory deployment. Explicitly retire legacy recovery
// only after maintenance:rearm and maintenance:status confirm existing timers.
if (process.env.SCHEDULING_LEGACY_RECOVERY !== "false") {
  crons.interval(
    "Reconcile direct purchases",
    { minutes: 5 },
    internal.commerceStripe.recover,
    {}
  )
  crons.interval(
    "Recover community reputation work",
    { minutes: 1 },
    internal.communityReputation.recover,
    {}
  )
  crons.interval(
    "recover integrity review fanout",
    { minutes: 1 },
    internal.integrityMaintenance.recover,
    {}
  )
  crons.interval(
    "recover sandbox pixel market",
    { minutes: 1 },
    internal.placeMaintenance.recover,
    {}
  )
  crons.interval(
    "recover work leases",
    { minutes: 1 },
    internal.work.recover,
    {}
  )
  crons.interval(
    "recover background jobs",
    { minutes: 5 },
    internal.jobs.recover,
    {}
  )
  crons.interval(
    "notify search indexes",
    { minutes: 10 },
    internal.background.indexNow,
    {}
  )
  crons.interval(
    "Recover moderation committees",
    { minutes: 1 },
    internal.governance.recover,
    {}
  )
} else {
  crons.interval(
    "Recover overdue work",
    { minutes: 5 },
    internal.maintenance.watchdog,
    {}
  )
}
crons.hourly(
  "Audit community freshness",
  { minuteUTC: 17 },
  internal.communityReputation.audit,
  {}
)
crons.interval(
  "Collect abandoned uploads",
  { hours: 6 },
  internal.fileMaintenance.collectUnclaimed,
  {}
)
crons.daily(
  "Freeze jury roster",
  { hourUTC: 0, minuteUTC: 0 },
  internal.governance.freezeRoster,
  {}
)
crons.hourly(
  "Audit reputation sources",
  { minuteUTC: 31 },
  internal.governance.maintainReputation,
  {}
)
crons.hourly(
  "Expire private network evidence",
  { minuteUTC: 47 },
  internal.governance.retention,
  {}
)
export default crons
