"use client"

import { useEffect, useId, useRef, useState } from "react"
import { CaretDownIcon, ListBulletsIcon } from "@phosphor-icons/react"
import { DisclosureMenu } from "@/components/design-system/disclosure-menu"
import { ActionButton } from "@/components/design-system/controls"
import type { ContentsEntry } from "@/lib/article-markdown"
import styles from "./article-contents.module.css"

function flatten(entries: ContentsEntry[]): ContentsEntry[] {
  return entries.flatMap((entry) => [entry, ...flatten(entry.children)])
}

function ContentsBranch({
  entry,
  activeId,
}: {
  entry: ContentsEntry
  activeId: string
}) {
  const [collapsed, setCollapsed] = useState(false)
  const childrenId = useId()
  const expanded = !collapsed
  return (
    <li>
      <div className={styles.row}>
        {entry.children.length > 0 && (
          <ActionButton
            variant="ghost"
            size="icon-sm"
            className={styles.branchToggle}
            aria-label={`${expanded ? "Collapse" : "Expand"} ${entry.title} subsections`}
            aria-expanded={expanded}
            aria-controls={childrenId}
            onClick={() => setCollapsed(!collapsed)}
          >
            <CaretDownIcon
              aria-hidden="true"
              className={expanded ? undefined : styles.closedCaret}
            />
          </ActionButton>
        )}
        <a
          href={`#${entry.id}`}
          aria-current={activeId === entry.id ? "location" : undefined}
        >
          {entry.title}
        </a>
      </div>
      {entry.children.length > 0 && (
        <ul id={childrenId} hidden={!expanded}>
          {entry.children.map((child) => (
            <ContentsBranch key={child.id} entry={child} activeId={activeId} />
          ))}
        </ul>
      )}
    </li>
  )
}

export function ArticleContents({
  entries,
  mobile = false,
}: {
  entries: ContentsEntry[]
  mobile?: boolean
}) {
  const [activeId, setActiveId] = useState("article-title")
  const [hidden, setHidden] = useState(false)
  const navId = useId()
  const rootRef = useRef<HTMLElement>(null)

  useEffect(() => {
    const targets = flatten(entries).flatMap(({ id }) => {
      const element = document.getElementById(id)
      return element ? [{ id, element }] : []
    })
    const panel = rootRef.current?.closest('[data-slot="sidebar-inset"]')
    let frame = 0
    const update = () => {
      frame = 0
      const panelScrolls =
        panel && /auto|scroll/.test(getComputedStyle(panel).overflowY)
      const readingTop = panelScrolls
        ? panel.getBoundingClientRect().top + 56
        : parseFloat(
            getComputedStyle(document.documentElement).getPropertyValue(
              "--shell-header-height"
            )
          ) + 56 || 56
      const toolbar = document.querySelector("[data-article-toolbar]")
      // Include the anchor's breathing room when sticky controls receive focus.
      const top = Math.max(
        readingTop,
        (toolbar?.getBoundingClientRect().bottom ?? 0) + 68
      )
      let current = "article-title"
      for (const target of targets) {
        if (target.element.getBoundingClientRect().top > top) break
        current = target.id
      }
      setActiveId(current)
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update)
    }
    update()
    document.addEventListener("scroll", schedule, {
      capture: true,
      passive: true,
    })
    window.addEventListener("resize", schedule)
    window.addEventListener("hashchange", schedule)
    const observer = new ResizeObserver(schedule)
    const content = document.getElementById("page-content")
    if (content) observer.observe(content)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener("scroll", schedule, true)
      window.removeEventListener("resize", schedule)
      window.removeEventListener("hashchange", schedule)
      observer.disconnect()
    }
  }, [entries])

  const navigation = (
    <nav id={navId} aria-label="Contents" className={styles.nav}>
      <ul>
        {entries.map((entry) => (
          <ContentsBranch key={entry.id} entry={entry} activeId={activeId} />
        ))}
      </ul>
    </nav>
  )
  if (mobile)
    return (
      <div
        ref={(node) => {
          rootRef.current = node
        }}
        className={styles.mobile}
      >
        <DisclosureMenu
          label="Contents"
          icon={<ListBulletsIcon aria-hidden="true" />}
          align="start"
        >
          <p className={styles.label}>Contents</p>
          {navigation}
        </DisclosureMenu>
      </div>
    )
  return (
    <aside
      ref={rootRef}
      className={styles.contents}
      aria-label="Table of contents"
      data-hidden={hidden}
    >
      <div className={styles.header}>
        <span className={styles.label}>Contents</span>
        <ActionButton
          variant="ghost"
          size="sm"
          className={styles.desktopToggle}
          aria-expanded={!hidden}
          aria-controls={navId}
          onClick={() => setHidden(!hidden)}
        >
          {hidden ? "Show" : "Hide"}
        </ActionButton>
      </div>
      {navigation}
    </aside>
  )
}
