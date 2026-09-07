import { cp, readdir, rm } from "node:fs/promises"
import type { Dirent } from "node:fs"
import { join } from "node:path"

async function pruneDeletedSource(source: string, destination: string) {
  const originals = new Map(
    (await readdir(source, { withFileTypes: true })).map((entry) => [
      entry.name,
      entry,
    ])
  )
  let entries: Dirent[]
  try {
    entries = await readdir(destination, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    entries = []
  }
  for (const entry of entries) {
    const original = originals.get(entry.name)
    const copied = join(destination, entry.name)
    if (
      !original ||
      original.isDirectory() !== entry.isDirectory() ||
      original.isSymbolicLink() !== entry.isSymbolicLink()
    ) {
      await rm(copied, { recursive: true, force: true })
    } else if (entry.isDirectory()) {
      await pruneDeletedSource(join(source, entry.name), copied)
    }
  }
}

// Only prune the copied source directory, never the isolated backend's data.
export async function syncTestSource(source: string, destination: string) {
  await pruneDeletedSource(source, destination)
  await cp(source, destination, { recursive: true, force: true })
}
