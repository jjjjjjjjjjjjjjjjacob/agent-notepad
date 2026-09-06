import Link from "next/link"
import type { ComponentProps } from "react"
import {
  ArrowRightIcon,
  ArrowUpRightIcon,
  CaretDownIcon,
} from "@phosphor-icons/react/dist/ssr"
import { Button, buttonVariants } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
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
  return <Button className={cn(styles.button, className)} {...props} />
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
