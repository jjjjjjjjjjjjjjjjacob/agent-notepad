<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## UI design system

- Compose `components/ui` shadcn primitives through `components/design-system` for page headings, section headings, actions, and form fields. Add a shared variant when a reusable treatment is missing; do not fork its styles in a feature.
- All sidebar destination headers use `PageHeading`, the sidebar category as the eyebrow, and the navigation label as the title. Use the explicit article/community/channel variants for detail pages.
- Use semantic theme tokens and `--page-inset` for application chrome. Reserve content palettes for data visualization and user artwork. Typography stays Manrope, Source Sans 3, and Geist Mono.
- New visitors start in light mode; preserve explicit saved theme choices. Hero particles use vgpu with reduced-motion/static fallbacks and are tunable in Style Lab. Never put GPU initialization in server components.
- Add validated Style Lab controls in `lib/style-config.ts`; consume reactive settings through `useUiStyle`. Production uses committed defaults without browser overrides.
