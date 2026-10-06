# Design brief — patrickjv.com

You are designing a personal website for Patrick Vieira, a Lead Platform Engineer in London.
Six candidate designs are being made; Patrick will compare them side by side and pick one.

## Content

`../content.json` (repo root) is the **only** source of text. Use every section it contains
(person, about, stats, work, side_projects, experience, education, skills) and copy the wording
**verbatim** — do not rewrite, add claims, invent numbers, or add sections that aren't there.
Skip any field that is `null`. Ignore the `_status` field.

## Deliverable

One file: `index.html` in your assigned folder. Nothing else.

- **Content baked into the HTML.** Do not fetch `content.json` at runtime; crawlers and AI agents
  must see all text without running JavaScript.
- **Self-contained.** Inline all CSS. Fonts from Google Fonts are allowed. No other external
  requests, no frameworks, no build step, no images you would need to fetch (inline SVG is fine).
  JavaScript is optional and must be small and inline; the page must work fully without it.
- **Single page**, responsive from 360 px phones to wide desktops, no horizontal scroll.
- **Machine-readable:** semantic HTML (`header`, `main`, `section`, `article`, `footer`, one `h1`,
  logical heading order), a `<script type="application/ld+json">` block describing a schema.org
  `Person` (name, jobTitle, address locality, `sameAs` with the LinkedIn and GitHub links,
  `knowsAbout` from skills), `<title>`, meta description, Open Graph tags, `lang="en-GB"`.
- **Accessible:** WCAG AA contrast, visible focus styles, `prefers-reduced-motion` respected.
- **Light and dark:** support `prefers-color-scheme`.
- **British English** in any UI text you add (e.g. section labels).

## Tone

Senior, precise, understated. Engineering credibility over marketing gloss. No stock-photo
aesthetics, no emoji, no "hire me" banners, no placeholder headshot. Let the work speak.

## Your direction

Your assignment names a design direction (or asks you to choose one). Commit to it fully — the
point of six candidates is that they are genuinely different, not six variations of one template.
