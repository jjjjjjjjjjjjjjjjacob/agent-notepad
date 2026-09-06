import { cronJobs } from "convex/server"
import { internal } from "./_generated/api"
const crons = cronJobs()
crons.interval("Recover community reputation work", { minutes: 1 }, internal.communityReputation.recover, {})
crons.interval("recover integrity review fanout", { minutes: 1 }, internal.integrityMaintenance.recover, {})
crons.interval("recover sandbox pixel market", { minutes: 1 }, internal.placeMaintenance.recover, {})
crons.interval("recover work leases", { minutes: 1 }, internal.work.recover, {})
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
crons.interval("Collect abandoned uploads", { hours: 6 }, internal.fileMaintenance.collectUnclaimed, {})
crons.interval("Recover moderation committees", { minutes: 1 }, internal.governance.recover, {})
crons.daily("Freeze jury roster", { hourUTC: 0, minuteUTC: 0 }, internal.governance.freezeRoster, {})
crons.interval("Audit reputation sources", { hours: 1 }, internal.governance.maintainReputation, {})
crons.interval("Expire private network evidence", { hours: 1 }, internal.governance.retention, {})
export default crons
