import Link from "next/link"
import type { ComponentProps, ReactNode } from "react"
import {
  ArrowRightIcon,
  ArrowUpRightIcon,
  CaretDownIcon,
} from "@phosphor-icons/react/dist/ssr"
import { Button, buttonVariants } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import styles from "./controls.module.css"

export function LinkArrow({
  direction = "up-right",
}: {
  direction?: "up-right" | "right"
}) {
  const Icon = direction === "right" ? ArrowRightIcon : ArrowUpRightIcon
  return (
    <Icon
      weight="bold"
      aria-hidden="true"
      className={`size-4 ${styles.arrow}`}
    />
  )
}

export function ActionButton({
  className,
  ...props
}: ComponentProps<typeof Button>) {
  return <Button data-analytics-control className={cn(styles.button, className)} {...props} />
}

export function ActionLink({
  href,
  children,
  arrow,
  variant = "outline",
  className,
  ...props
}: Omit<ComponentProps<typeof Link>, "className"> & {
  arrow?: "up-right" | "right"
  variant?: "default" | "outline" | "secondary" | "ghost"
  className?: string
}) {
  return (
    <Link
      data-analytics-control
      data-slot="button"
      data-variant={variant}
      href={href}
      className={cn(buttonVariants({ variant }), styles.button, className)}
      {...props}
    >
      {children}
      {arrow && <LinkArrow direction={arrow} />}
    </Link>
  )
}

export function FieldInput({
  className,
  ...props
}: ComponentProps<typeof Input>) {
  return <Input className={cn(styles.input, className)} {...props} />
}

export function FieldTextarea(props: ComponentProps<typeof Textarea>) {
  return <Textarea {...props} />
}

/** Native form semantics with the same tokens and dimensions as shadcn inputs. */
export function NativeSelect({
  className,
  ...props
}: ComponentProps<"select">) {
  return (
    <span className={styles.select}>
      <select
        data-slot="native-select"
        className={cn(styles.input, className)}
        {...props}
      />
      <CaretDownIcon size={14} aria-hidden="true" />
    </span>
  )
}

export function FilterToolbar({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="filter-toolbar"
      className={cn(styles.filterToolbar, className)}
      {...props}
    />
  )
}

export function FilterField({
  label,
  grow = false,
  className,
  children,
  ...props
}: ComponentProps<"label"> & { label: ReactNode; grow?: boolean }) {
  return (
    <label
      data-slot="filter-field"
      className={cn(styles.filterField, grow && styles.growingField, className)}
      {...props}
    >
      <span>{label}</span>
      {children}
    </label>
  )
}

export function FilterToggle({ className, ...props }: ComponentProps<"label">) {
  return <label className={cn(styles.filterToggle, className)} {...props} />
}

export function SortControl({
  label,
  options,
}: {
  label: string
  options: { label: string; href: string; active: boolean }[]
}) {
  return (
    <nav className={styles.sortControl} aria-label={label}>
      {options.map((option) => (
        <ActionLink
          key={option.href}
          href={option.href}
          variant="ghost"
          aria-current={option.active ? "page" : undefined}
        >
          {option.label}
        </ActionLink>
      ))}
    </nav>
  )
}
