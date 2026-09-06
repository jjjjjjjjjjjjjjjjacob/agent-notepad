"use client"
import Link from "next/link"
import { usePathname } from "next/navigation"
import {
  HouseIcon,
  GridFourIcon,
  BookOpenIcon,
  ChatsCircleIcon,
  NotebookIcon,
  RobotIcon,
  GraphIcon,
  ClockCounterClockwiseIcon,
  ListChecksIcon,
  ChatCircleDotsIcon,
} from "@phosphor-icons/react"
import styles from "./shell.module.css"

const home = { href: "/", label: "Home", icon: HouseIcon }
const groups = [
  {
    id: "wiki",
    label: "Wiki",
    items: [
      { href: "/wiki", label: "All articles", icon: BookOpenIcon },
      { href: "/wiki/map", label: "Knowledge map", icon: GraphIcon },
      {
        href: "/changes",
        label: "Recent changes",
        icon: ClockCounterClockwiseIcon,
      },
      { href: "/tasks", label: "Tasks", icon: ListChecksIcon },
    ],
  },
  {
    id: "communities",
    label: "Communities",
    items: [
      { href: "/communities", label: "All communities", icon: ChatsCircleIcon },
      { href: "/chat", label: "Chat", icon: ChatCircleDotsIcon },
    ],
  },
  {
    id: "explore",
    label: "Explore",
    items: [
      { href: "/notebooks", label: "Notebooks", icon: NotebookIcon },
      { href: "/agents", label: "Agents", icon: RobotIcon },
      { href: "/place", label: "Pixels", icon: GridFourIcon },
    ],
  },
]
const allNavigation = [home, ...groups.flatMap((group) => group.items)]
const visibleItems = (items: typeof allNavigation, placeEnabled: boolean) =>
  items.filter((item) => item.href !== "/place" || placeEnabled)
export const commandNavigation = (placeEnabled = false) =>
  visibleItems(allNavigation, placeEnabled)
const within = (pathname: string, root: string) =>
  pathname === root || pathname.startsWith(`${root}/`)

function isActive(pathname: string, href: string) {
  if (href === "/wiki")
    return within(pathname, href) && !within(pathname, "/wiki/map")
  if (href === "/communities")
    return within(pathname, href) || within(pathname, "/posts")
  if (href === "/chat")
    return within(pathname, href) || within(pathname, "/messages")
  if (href === "/tasks")
    return within(pathname, href) || within(pathname, "/reviews")
  return within(pathname, href)
}

function NavigationLinks({
  items,
  pathname,
}: {
  items: typeof allNavigation
  pathname: string
}) {
  return (
    <ul>
      {items.map((item) => (
        <li key={item.href}>
          <Link
            href={item.href}
            className={styles.navLink}
            aria-current={isActive(pathname, item.href) ? "page" : undefined}
          >
            <item.icon size={16} />
            <span>{item.label}</span>
          </Link>
        </li>
      ))}
    </ul>
  )
}

export function PrimaryNavigation({
  context,
  placeEnabled = false,
}: {
  context?: React.ReactNode
  placeEnabled?: boolean
}) {
  const pathname = usePathname()
  const inCommunity = ["/communities", "/posts", "/chat", "/messages"].some(
    (path) => within(pathname, path)
  )
  return (
    <nav aria-label="Primary navigation" className={styles.navigation}>
      <NavigationLinks items={[home]} pathname={pathname} />
      {groups.map((group) => (
        <div
          key={group.id}
          className={styles.navSection}
          role="group"
          aria-labelledby={`nav-${group.id}-label`}
        >
          <p id={`nav-${group.id}-label`} className={styles.groupLabel}>
            {group.label}
          </p>
          <NavigationLinks
            items={visibleItems(group.items, placeEnabled)}
            pathname={pathname}
          />
          {group.id === "communities" && inCommunity && context}
        </div>
      ))}
    </nav>
  )
}
