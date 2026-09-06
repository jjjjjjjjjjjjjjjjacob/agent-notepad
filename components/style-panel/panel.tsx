"use client"
import { useEffect, useRef, useState } from "react"
import { SlidersHorizontalIcon, XIcon } from "@phosphor-icons/react"
import {
  defaultStyle,
  styleFields,
  styleTokens,
  stylePresets,
  parseStyle,
  fonts,
  type StyleConfig,
  type StyleKey,
} from "@/lib/style-config"
import styles from "./panel.module.css"
const storageKey = "agent-notepad:style:v1"
function savedStyle() {
  try {
    const saved = localStorage.getItem(storageKey)
    return saved ? parseStyle(JSON.parse(saved)) : { ...defaultStyle }
  } catch {
    return { ...defaultStyle }
  }
}
export default function StylePanel() {
  const [values, setValues] = useState<StyleConfig>(savedStyle)
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState("")
  const button = useRef<HTMLButtonElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    const tokens = styleTokens(values)
    for (const [key, value] of Object.entries(tokens))
      document.documentElement.style.setProperty(key, String(value))
    try {
      localStorage.setItem(storageKey, JSON.stringify({ version: 1, values }))
    } catch {
      /* Styling remains usable without storage. */
    }
  }, [values])
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
      <button
        ref={button}
        className={styles.trigger}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls="style-panel"
      >
        <SlidersHorizontalIcon size={18} />
        Style lab
      </button>
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
            <button onClick={close} aria-label="Close style lab">
              <XIcon size={20} />
            </button>
          </header>
          <p className={styles.intro}>
            Tune this view live. Changes stay in this browser; export a preset
            to keep or share them.
          </p>
          <div className={styles.presets}>
            <label>
              Preset
              <select
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
              </select>
            </label>
            <button
              onClick={() => {
                setValues({ ...defaultStyle })
                setStatus("All settings reset.")
              }}
            >
              Reset all
            </button>
          </div>
          {[...new Set(Object.values(styleFields).map((f) => f.group))].map(
            (group) => (
              <details key={group} open={group === "Typography"}>
                <summary>{group}</summary>
                <button
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
                </button>
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
                        {field.kind === "font" ? (
                          <select
                            aria-label={field.label}
                            value={String(values[key as StyleKey])}
                            onChange={(e) =>
                              setValues((v) => ({
                                ...v,
                                [key]: e.target.value,
                              }))
                            }
                          >
                            {Object.entries(fonts).map(([id, f]) => (
                              <option key={id} value={id}>
                                {f.label}
                              </option>
                            ))}
                          </select>
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
            <button onClick={download}>Export JSON</button>
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
