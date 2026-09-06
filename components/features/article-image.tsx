"use client"

import { useState } from "react"

export function ArticleImage({
  src,
  alt,
  title,
}: {
  src?: string
  alt?: string
  title?: string
}) {
  const [failed, setFailed] = useState(false)
  const allowed = src && (/^https:\/\//.test(src) || /^\/(?!\/)/.test(src))
  if (!allowed || failed)
    return (
      <span className="article-image-fallback">
        Image unavailable: {alt || "article photograph"}
      </span>
    )
  return (
    <span
      className="article-image"
      role="figure"
      aria-label={alt || "Article image"}
    >
      {/* Contributor images retain their source URL and do not use the image proxy. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt || ""}
        title={title}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
      />
      {(title || alt) && (
        <span className="article-image-caption">{title || alt}</span>
      )}
    </span>
  )
}
