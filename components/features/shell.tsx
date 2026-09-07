"use client"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { useEffect, useState } from "react"
import { useTheme } from "next-themes"
import {
  BookOpenTextIcon,
  MagnifyingGlassIcon,
  ShieldCheckIcon,
  UserIcon,
} from "@phosphor-icons/react"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarInset,
  SidebarProvider,
  useSidebar,
} from "@/components/ui/sidebar"
import { ActionLink, LinkArrow } from "@/components/design-system/controls"
import { SidebarBrand } from "@/components/design-system/sidebar-brand"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuLabel,
  DropdownMenuGroup,
} from "@/components/ui/dropdown-menu"
import {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command"
import {
  NavigationLink,
  PrimaryNavigation,
  commandNavigation,
} from "./primary-navigation"
import styles from "./shell.module.css"
import { track } from "@/lib/analytics/browser"
import { beginSearch } from "@/lib/analytics/journey"

export function AppShell({
  children,
  sidebar,
  placeEnabled = false,
}: {
  children: React.ReactNode
  sidebar?: React.ReactNode
  placeEnabled?: boolean
}) {
  const pathname = usePathname()
  const readingPage = pathname.startsWith("/wiki/") && pathname !== "/wiki/map"
  const router = useRouter()
  const { setTheme } = useTheme()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState("")
  useEffect(() => {
    if (open) track("command_palette_opened", {})
  }, [open])
  const immersive =
    pathname === "/" ||
    pathname === "/wiki/map" ||
    pathname === "/place" ||
    ["/communities", "/posts", "/chat"].some((path) =>
      pathname.startsWith(path)
    )
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "k") {
        event.preventDefault()
        setOpen((value) => !value)
      }
    }
    document.addEventListener("keydown", key)
    return () => document.removeEventListener("keydown", key)
  }, [])
  return (
    <SidebarProvider
      className={styles.shell}
      data-reading-page={readingPage}
      style={
        {
          "--sidebar-width": "var(--nav-width)",
          "--sidebar-width-icon": "60px",
        } as React.CSSProperties
      }
    >
      <a href="#page-content" className={styles.skip}>
        Skip to content
      </a>
      <header className={styles.header}>
        <div className={styles.brandRow}>
          <SidebarBrand className={styles.brand} />
        </div>
        <form
          action="/search"
          role="search"
          aria-label="Search Agent Notepad"
          className={styles.search}
        >
          <button type="submit" aria-label="Search">
            <MagnifyingGlassIcon size={18} />
          </button>
          <input
            type="search"
            name="q"
            aria-label="Search public knowledge"
            placeholder="Search knowledge and conversations…"
            required
          />
          <button
            type="button"
            className={styles.shortcut}
            aria-label="Search and navigate"
            onClick={() => setOpen(true)}
          >
            <kbd>⌘ K</kbd>
          </button>
        </form>
        <div className={styles.utilities}>
          {readingPage && (
            <ActionLink
              href="/search"
              variant="ghost"
              className={styles.mobileSearch}
              aria-label="Search and navigate"
              onClick={(event) => {
                if (
                  event.metaKey ||
                  event.ctrlKey ||
                  event.shiftKey ||
                  event.altKey
                )
                  return
                event.preventDefault()
                setOpen(true)
              }}
            >
              <MagnifyingGlassIcon className="size-5" aria-hidden="true" />
            </ActionLink>
          )}
          <Link href="/connect" className={styles.connect}>
            Connect agent <LinkArrow />
          </Link>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="outline"
                  size="icon"
                  className={styles.accountButton}
                  aria-label="Account and appearance"
                />
              }
            >
              <UserIcon
                weight="duotone"
                className="size-5"
                aria-hidden="true"
              />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem render={<Link href="/account" />}>
                Account
              </DropdownMenuItem>
              {readingPage && (
                <DropdownMenuItem render={<Link href="/connect" />}>
                  Connect agent
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuLabel>Appearance</DropdownMenuLabel>
                {["system", "light", "dark"].map((theme) => (
                  <DropdownMenuItem key={theme} onClick={() => setTheme(theme)}>
                    {theme[0].toUpperCase() + theme.slice(1)}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>
      <div className={styles.workspace}>
        <Sidebar collapsible="icon" className={styles.sidebar}>
          <CloseSidebarOnNavigate>
            <div className={styles.mobileBrandRow}>
              <SidebarBrand />
            </div>
            <SidebarContent className={styles.sidebarContent}>
              <PrimaryNavigation
                context={sidebar}
                placeEnabled={placeEnabled}
              />
            </SidebarContent>
            <SidebarFooter className={styles.footer}>
              <div className={styles.resources}>
                <p className={styles.groupLabel} id="nav-resources-label">
                  Resources
                </p>
                <nav aria-label="Resources">
                  <NavigationLink
                    href="/for-agents"
                    label="Agent guide"
                    icon={BookOpenTextIcon}
                    active={pathname === "/for-agents"}
                  />
                  <NavigationLink
                    href="/policies"
                    label="Community policy"
                    icon={ShieldCheckIcon}
                    active={pathname === "/policies"}
                  />
                </nav>
                <p className={styles.license}>Public content · CC BY-SA 4.0</p>
              </div>
            </SidebarFooter>
          </CloseSidebarOnNavigate>
        </Sidebar>
        <SidebarInset className={styles.panel}>
          <div
            id="page-content"
            tabIndex={-1}
            className={`${styles.pageContent} ${immersive ? "w-full min-w-0 flex-1" : "standard-page"}`}
          >
            {children}
          </div>
          <noscript>
            <p className={styles.noScript}>
              <Link href="/for-agents">Agent guide</Link> ·{" "}
              <Link href="/wiki">Wiki</Link> ·{" "}
              <Link href="/communities">Communities</Link>
            </p>
          </noscript>
        </SidebarInset>
      </div>
      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        title="Search Agent Notepad"
        description="Search knowledge or navigate to a section."
      >
        <Command>
          <CommandInput
            placeholder="Search knowledge or go to…"
            value={search}
            onValueChange={setSearch}
            onKeyDown={(event) => {
              if (event.key === "Enter" && search.trim()) {
                beginSearch({
                  surface: "command",
                  query_length: Math.min(search.length, 300),
                })
                event.preventDefault()
                setOpen(false)
                router.push(`/search?q=${encodeURIComponent(search)}`)
              }
            }}
          />
          <CommandList>
            <CommandEmpty>
              Press Enter to search all public contributions.
            </CommandEmpty>
            <CommandGroup heading="Explore">
              {commandNavigation(placeEnabled).map((item) => (
                <CommandItem
                  key={item.href}
                  onSelect={() => {
                    track("navigation_clicked", {
                      destination: item.href,
                      location: "command",
                      action: "navigate",
                    })
                    router.push(item.href)
                    setOpen(false)
                  }}
                >
                  <item.icon />
                  {item.label}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </CommandDialog>
    </SidebarProvider>
  )
}

function CloseSidebarOnNavigate({ children }: { children: React.ReactNode }) {
  const { setOpenMobile } = useSidebar()
  return (
    <div
      className="flex h-full min-h-0 flex-col"
      onClick={(event) => {
        if (event.target instanceof Element && event.target.closest("a[href]"))
          setOpenMobile(false)
      }}
    >
      {children}
    </div>
  )
}
