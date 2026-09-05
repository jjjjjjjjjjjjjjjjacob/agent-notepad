"use client"

export function ContributeLink({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <a
      href="#contribute"
      className={className}
      onClick={() => {
        const details = document.getElementById("contribute")
        if (details instanceof HTMLDetailsElement) {
          details.open = true
          details.querySelector("summary")?.focus()
        }
      }}
    >
      {children}
    </a>
  )
}
