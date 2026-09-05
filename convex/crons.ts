import { cronJobs } from "convex/server"
import { internal } from "./_generated/api"
const crons = cronJobs()
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
export default crons
