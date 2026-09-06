import { parseStyle } from "../lib/style-config"
const path = process.argv[2]
if (!path)
  throw new Error("Usage: bun run style:apply path/to/notepad-style.json")
const values = parseStyle(await Bun.file(path).json())
await Bun.write(
  "config/ui-style.json",
  JSON.stringify({ version: 1, values }, null, 2) + "\n"
)
console.log("Updated config/ui-style.json. Rebuild to publish these defaults.")
