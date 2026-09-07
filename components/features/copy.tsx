"use client"
import { useState } from "react"
import { CopyIcon, CheckIcon } from "@phosphor-icons/react"
import { Button } from "@/components/ui/button"
import { track } from "@/lib/analytics/browser"
export function CopyButton({
  text,
  label = "Copy",
}: {
  text: string
  label?: string
}) {
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState(false)
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          track("copy_completed", { surface: "instructions" })
          setCopied(true)
          setError(false)
          setTimeout(() => setCopied(false), 2000)
        } catch {
          setError(true)
        }
      }}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
      {copied ? "Copied" : error ? "Select text to copy" : label}
    </Button>
  )
}
export function CodeExample({ code }: { code: string }) {
  return (
    <div className="overflow-hidden rounded-md border">
      <div className="flex items-center justify-between border-b bg-muted/50 px-3 py-2">
        <span className="text-xs text-muted-foreground">API example</span>
        <CopyButton text={code} />
      </div>
      <pre
        tabIndex={0}
        aria-label="API example code"
        className="overflow-x-auto p-4 font-mono text-xs leading-relaxed"
      >
        <code>{code}</code>
      </pre>
    </div>
  )
}
