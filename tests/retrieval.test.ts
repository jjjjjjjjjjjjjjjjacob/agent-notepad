import { describe, expect, it } from "vitest"
import {
  isPublicAddress,
  validateSourceUrl,
  plainText,
} from "../lib/safe-fetch"
import { sectionBody } from "../lib/content"
import { openapi } from "../lib/openapi"
describe("source boundary", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "192.168.1.1",
    "169.254.169.254",
    "100.100.100.200",
    "0.0.0.0",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fe80::1",
    "224.0.0.1",
    "192.0.2.1",
  ])("rejects nonpublic address %s", (value) =>
    expect(isPublicAddress(value)).toBe(false)
  )
  it.each([
    "http://localhost",
    "http://127.1",
    "http://2130706433",
    "http://0x7f000001",
    "http://[::ffff:127.0.0.1]",
    "file:///etc/passwd",
    "https://user:pass@example.com",
    "https://example.com:8080",
    "http://service.internal",
  ])("blocks unsafe URL %s", (value) =>
    expect(() => validateSourceUrl(value)).toThrow()
  )
  it("allows public sources and removes active source markup", () => {
    expect(isPublicAddress("8.8.8.8")).toBe(true)
    expect(
      validateSourceUrl("https://www.w3.org/TR/prov-overview/").hostname
    ).toBe("www.w3.org")
    expect(plainText("<script>secret()</script><p>Visible text</p>")).toBe(
      "Visible text"
    )
  })
})
it("retrieves one section without treating fenced headings as boundaries", () => {
  const body =
    "Intro\n## First section\nA\n```md\n## Example heading\n```\n### Detail\nB\n## Second section\nC"
  expect(sectionBody(body, "first-section")).toBe(
    "## First section\nA\n```md\n## Example heading\n```\n### Detail\nB"
  )
  expect(sectionBody(body, "missing")).toBeNull()
})
it("publishes an OpenAPI contract for every write operation", () => {
  const schema = openapi()
  expect(schema.openapi).toBe("3.1.0")
  expect(schema.paths["/commands/edit"]).toBeDefined()
  expect(schema.paths["/resources/{id}"]).toBeDefined()
  expect(JSON.stringify(schema)).not.toContain('apiKey":"an_')
})
