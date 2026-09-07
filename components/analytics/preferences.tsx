"use client"
import { useState, useSyncExternalStore } from "react"
import { ActionButton, FilterToggle } from "@/components/design-system/controls"
import { SectionHeading } from "@/components/design-system/headings"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import { browserConfig } from "@/lib/analytics/browser"
import {
  declined,
  readConsent,
  saveConsent,
  type Consent,
} from "@/lib/analytics/consent"

const subscribe = (notify: () => void) => {
  window.addEventListener("analytics-consent", notify)
  window.addEventListener("storage", notify)
  return () => {
    window.removeEventListener("analytics-consent", notify)
    window.removeEventListener("storage", notify)
  }
}
const snapshot = () => {
  const value = readConsent()
  return value ? JSON.stringify(value) : ""
}
export function AnalyticsPreferences() {
  const stored = useSyncExternalStore(subscribe, snapshot, () => "pending")
  const [dismissed, setDismissed] = useState(false)
  const [open, setOpen] = useState(false)
  const [choice, setChoice] = useState<Consent>(declined)
  if (!browserConfig.enabled) return null
  const save = (value: Consent) => {
    saveConsent(value)
    setDismissed(true)
    setOpen(false)
  }
  const configure = () => {
    setChoice(readConsent() ?? declined)
    setOpen(true)
  }
  return (
    <div data-analytics-private className="ph-no-capture">
      <ActionButton
        type="button"
        variant="outline"
        className="fixed bottom-2 left-[var(--page-inset)] z-30 bg-background shadow-sm"
        onClick={configure}
      >
        Analytics preferences
      </ActionButton>
      {!stored && !dismissed && !open && (
        <aside
          aria-labelledby="analytics-consent-title"
          className="fixed right-[var(--page-inset)] bottom-12 z-40 w-[min(28rem,calc(100vw-2*var(--page-inset)))] space-y-3 rounded-xl border bg-background p-5 text-sm shadow-lg"
        >
          <SectionHeading
            id="analytics-consent-title"
            size="panel"
            title="Help improve Agent Notepad"
          />
          <p className="text-muted-foreground">
            Allow usage analytics and a small sample of masked session
            recordings? Search text, account details, and contributions are
            excluded. You can change your choice anytime.
          </p>
          <div className="flex flex-wrap gap-2">
            <ActionButton
              onClick={() =>
                save({ analytics: true, replay: browserConfig.replay })
              }
            >
              Accept
            </ActionButton>
            <ActionButton variant="outline" onClick={() => save(declined)}>
              Decline
            </ActionButton>
            <ActionButton variant="ghost" onClick={configure}>
              Preferences
            </ActionButton>
          </div>
        </aside>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent data-analytics-private className="ph-no-capture">
          <DialogHeader>
            <DialogTitle>Analytics preferences</DialogTitle>
            <DialogDescription>
              Optional analytics help us understand visits, navigation, and
              search effectiveness. Data is processed by PostHog in the United
              States.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <FilterToggle>
              <input
                type="checkbox"
                checked={choice.analytics}
                onChange={(e) =>
                  setChoice({
                    analytics: e.target.checked,
                    replay: e.target.checked && choice.replay,
                  })
                }
              />
              <span>Usage analytics</span>
            </FilterToggle>
            {browserConfig.replay && (
              <FilterToggle>
                <input
                  type="checkbox"
                  checked={choice.replay}
                  disabled={!choice.analytics}
                  onChange={(e) =>
                    setChoice({ ...choice, replay: e.target.checked })
                  }
                />
                <span>Masked session replay (10% sample)</span>
              </FilterToggle>
            )}
            <p className="text-sm text-muted-foreground">
              Replay masks text and inputs and excludes account and moderation
              screens. Declining clears analytics identifiers stored in this
              browser.
            </p>
          </div>
          <DialogFooter>
            <ActionButton variant="outline" onClick={() => save(declined)}>
              Decline all
            </ActionButton>
            <ActionButton onClick={() => save(choice)}>
              Save preferences
            </ActionButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
