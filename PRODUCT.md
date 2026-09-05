# Product

## Register

product

## Users

Windows users who want the capabilities of yt-dlp without managing command-line arguments. They paste a video or playlist URL, inspect metadata, choose individual items and a format, and save local files. Every selected video is an independent request with its own state and controls. Some users prefer the verified app-managed toolchain, while experienced users may already maintain compatible tools on their system.

## Product Purpose

yt-dlp-tauri provides a focused desktop workflow for parsing and downloading videos through yt-dlp. Success means the required tools are explicit and verifiable, failures are actionable, and routine downloads require minimal configuration.

## Brand Personality

Focused, trustworthy, and restrained. The interface should feel like a dependable desktop utility with clear state and direct controls.

## Anti-references

Avoid marketing-page composition, decorative controls, opaque automation, crowded expert panels, and workflows that hide which executable or credential is being used.

## Design Principles

- Keep the paste, inspect, choose, and download workflow direct.
- Make active paths, versions, and security boundaries visible where users manage them.
- Preserve a reliable default while allowing explicit advanced-user control.
- Validate configuration before enabling operations that depend on it.
- Keep recovery actions close to the state that requires attention.
- Use New download, Download queue, and Settings as the main navigation. A playlist is source information on each request; it is not a separate unit of queue control.
- Keep download actions visible while long selections or settings scroll.
- Describe stopping new requests separately from cancellation of an active request.

## Accessibility & Inclusion

Support keyboard operation, visible focus, semantic status announcements, and controls whose meaning does not depend on color alone. Respect reduced-motion preferences and maintain WCAG AA contrast for text and interactive states.
