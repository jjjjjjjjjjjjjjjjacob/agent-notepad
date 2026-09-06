"use client"
import { useEffect, useRef, useState } from "react"
import { SlidersHorizontalIcon, XIcon } from "@phosphor-icons/react"
import {
  defaultStyle,
  styleFields,
  stylePresets,
  parseStyle,
  fonts,
  type StyleKey,
} from "@/lib/style-config"
import styles from "./panel.module.css"
import { useUiStyle, setUiStyle, loadStyleOverrides } from "./style-store"
import { ActionButton, NativeSelect } from "@/components/design-system/controls"
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select"

function StyleSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: Record<string, string>
  onChange: (value: string) => void
}) {
  return (
    <Select
      value={value}
      items={options}
      onValueChange={(next) => {
        if (next) onChange(next)
      }}
    >
      <SelectTrigger aria-label={label} className="h-10 w-full text-sm">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {Object.entries(options).map(([id, name]) => (
          <SelectItem key={id} value={id}>
            {name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
export default function StylePanel() {
  const values = useUiStyle()
  const setValues = setUiStyle
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState("")
  const button = useRef<HTMLButtonElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(loadStyleOverrides, [])
  useEffect(() => {
    if (open) heading.current?.focus()
  }, [open])
  const close = () => {
    setOpen(false)
    button.current?.focus()
  }
  async function importFile(file?: File) {
    if (!file) return
    try {
      if (file.size > 100000)
        throw new Error("Preset files must be under 100 KB.")
      setValues(parseStyle(JSON.parse(await file.text())))
      setStatus("Preset imported.")
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Invalid preset.")
    }
  }
  function download() {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify({ version: 1, values }, null, 2)], {
        type: "application/json",
      })
    )
    const a = document.createElement("a")
    a.href = url
    a.download = "notepad-style.json"
    a.click()
    URL.revokeObjectURL(url)
    setStatus(
      "Preset exported. Import it on another preview or commit it as the app default."
    )
  }
  return (
    <>
      <ActionButton
        variant="outline"
        ref={button}
        className={styles.trigger}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls="style-panel"
      >
        <SlidersHorizontalIcon size={18} />
        Style lab
      </ActionButton>
      {open && (
        <aside
          id="style-panel"
          className={styles.panel}
          aria-label="Development styling panel"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation()
              close()
            }
          }}
        >
          <header>
            <div>
              <span>Development only</span>
              <h2 ref={heading} tabIndex={-1}>
                Style lab
              </h2>
            </div>
            <ActionButton
              variant="outline"
              onClick={close}
              aria-label="Close style lab"
            >
              <XIcon size={20} />
            </ActionButton>
          </header>
          <p className={styles.intro}>
            Tune this view live. Changes stay in this browser; export a preset
            to keep or share them.
          </p>
          <div className={styles.presets}>
            <label>
              Preset
              <NativeSelect
                defaultValue=""
                onChange={(e) => {
                  const preset = stylePresets[e.target.value]
                  if (preset) setValues({ ...preset })
                }}
              >
                <option value="" disabled>
                  Choose a starting point
                </option>
                {Object.keys(stylePresets).map((name) => (
                  <option key={name}>{name}</option>
                ))}
              </NativeSelect>
            </label>
            <ActionButton
              variant="outline"
              onClick={() => {
                setValues({ ...defaultStyle })
                setStatus("All settings reset.")
              }}
            >
              Reset all
            </ActionButton>
          </div>
          {[...new Set(Object.values(styleFields).map((f) => f.group))].map(
            (group) => (
              <details key={group} open={group === "Typography"}>
                <summary>{group}</summary>
                <ActionButton
                  variant="outline"
                  className={styles.sectionReset}
                  aria-label={`Reset ${group}`}
                  onClick={() => {
                    setValues((v) => ({
                      ...v,
                      ...Object.fromEntries(
                        Object.entries(styleFields)
                          .filter(([, f]) => f.group === group)
                          .map(([k]) => [k, defaultStyle[k as StyleKey]])
                      ),
                    }))
                  }}
                >
                  Reset
                </ActionButton>
                <div className={styles.fields}>
                  {Object.entries(styleFields)
                    .filter(([, f]) => f.group === group)
                    .map(([key, field]) => (
                      <label key={key}>
                        <span>
                          {field.label}
                          {field.kind === "number" && (
                            <output aria-hidden="true">
                              {Number(values[key as StyleKey]).toFixed(
                                field.step! < 1 ? 2 : 0
                              )}
                              {field.unit}
                            </output>
                          )}
                        </span>
                        {field.kind === "font" || field.kind === "select" ? (
                          <StyleSelect
                            label={field.label}
                            value={String(values[key as StyleKey])}
                            options={
                              field.kind === "font"
                                ? Object.fromEntries(
                                    Object.entries(fonts).map(([id, font]) => [
                                      id,
                                      font.label,
                                    ])
                                  )
                                : field.options!
                            }
                            onChange={(value) =>
                              setValues((v) => ({ ...v, [key]: value }))
                            }
                          />
                        ) : field.kind === "boolean" ? (
                          <input
                            aria-label={field.label}
                            type="checkbox"
                            checked={Boolean(values[key as StyleKey])}
                            onChange={(e) =>
                              setValues((v) => ({
                                ...v,
                                [key]: e.target.checked,
                              }))
                            }
                          />
                        ) : (
                          <input
                            aria-label={field.label}
                            type={field.kind === "color" ? "color" : "range"}
                            value={String(values[key as StyleKey])}
                            min={field.min}
                            max={field.max}
                            step={field.step}
                            onChange={(e) =>
                              setValues((v) => ({
                                ...v,
                                [key]:
                                  field.kind === "number"
                                    ? Number(e.target.value)
                                    : e.target.value,
                              }))
                            }
                          />
                        )}
                      </label>
                    ))}
                </div>
              </details>
            )
          )}
          <footer>
            <ActionButton variant="outline" onClick={download}>
              Export JSON
            </ActionButton>
            <label className={styles.import}>
              Import JSON
              <input
                type="file"
                accept="application/json,.json"
                onChange={(e) => {
                  void importFile(e.target.files?.[0])
                  e.target.value = ""
                }}
              />
            </label>
          </footer>
          <p className={styles.status} role="status">
            {status}
          </p>
        </aside>
      )}
    </>
  )
}
