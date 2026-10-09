# Feature Spec: Calendar day picker on /book

> **Purpose:** Replace the list of day radio buttons on `/book` with a month calendar, without changing anything an agent sees.
> **Update when:** The picking step on `/book` changes.
> **Related:** [`F-001-booking.md`](F-001-booking.md) (the booking flow, HTTP API and page states this builds on).

---

## Metadata

| Field | Value |
|---|---|
| Spec ID | F-003 |
| Status | Calendar merged to `main` (35d788b). Time list refined on `feat/book-time-list` (not merged, not deployed) |
| Owner | @PVieira04 |
| Created | 2026-10-09 |
| Depends on | F-001 (shipped) |

---

## Summary

Today, once a visitor picks a meeting type, `/book` lists every free day as a radio button, then every free time as another radio button. With 28 days of horizon that is a long, flat list. This change shows the days as a month calendar (free days selectable, the rest visibly not), then the chosen day's free start times as a short scrollable list directly below it. Everything after a time is chosen (details form, `POST /api/booking`, the result and error states) is unchanged.

## User story

### US-1: Visitor picks a day on a calendar

As a **visitor**, I want to **see the free days on a month calendar and pick one, then a time**, so that **I can see at a glance which days work, the way other booking pages show them**.

## Goals and non-goals

**Goals:** a month grid for the day; a vertical, scrollable list of start times below it; keyboard and screen-reader use at least as good as the radios; same look as the rest of the site (IBM Plex, the site's colours, light and dark).

**Non-goals:**

- **Agent tools unchanged.** The WebMCP tools on the homepage and the MCP server keep their names, descriptions, schemas and results. No change to `mcp/`, `lib/agent-data.mjs` or `BOOKING_ENABLED`.
- No change to the HTTP API or to the requests the page makes.
- No change to the meeting-type choice (radios, as today) or to anything after a time is chosen (F-002 adds a sign-in choice there; this change stops at the hand-off of a chosen type and start).
- No new dependencies, no external scripts or styles; the page stays one inline script and one inline style under its hash-based CSP.
- No date range beyond what the API returns; no "today" marker; no week view.

## Acceptance criteria

1. **Calendar shown after a type is chosen.** Choosing a type fetches availability as today and shows the month (named, e.g. "October 2026") containing the first free day as a 7-column grid, weeks starting on Monday, with the weekday names as column headers.
2. **Free days selectable, others visibly not.** Each day with a free slot (grouped by the visitor's time zone, as today) is a button whose accessible name is the full date and the number of free times ("Monday 26 October, 2 free times"). Every other day of the month is shown, marked `aria-disabled="true"`, named "…, no free times", styled muted, and does nothing when activated.
3. **Months only when needed.** Previous/next month buttons appear only when the free days span more than one month, and are disabled at the first and last month.
4. **Picking a day shows its times.** Activating a free day marks it selected (`aria-pressed="true"`), names the day in the time step, and lists that day's free times in the section directly below the calendar. Picking a time shows the existing details form. Changing day or type clears later choices, as today.
   - **4a. Start times only.** Each time is labelled with its start alone ("10:00", "10:15") in the visitor's zone: the visitor has already chosen the meeting type, so they know its length.
   - **4b. A vertical, scrollable list.** The times are one column, one time per full-width row (no grid), in a box of bounded height (`max-height` about 5½ rows on desktop and phone) that scrolls vertically (`overflow-y: auto`) when the day has more times than fit, with `overscroll-behavior: contain` so reaching its ends does not scroll the page. While more rows lie below, the bottom edge fades out as a hint that it scrolls. Picking a day scrolls the list back to the top.
   - **4c. Inline, not a modal.** The list is a section of the page, not a dialog: the calendar and the times stay visible together, it scrolls naturally on phones, and there is no focus trap or back-button handling to get wrong.
5. **Keyboard.** The grid is one tab stop (roving tabindex: the selected day, else the first free day). Arrow keys move by a day / a week, Home/End to the start/end of the week, Page Up/Page Down by a month, crossing into the neighbouring month when there is one; Enter or Space selects. Focus is always visible.
6. **Screen readers.** The grid is a `role="grid"` table labelled by the month name, inside the existing "Day" fieldset; the month name is a polite live region so month changes are announced. Times stay a required radio group in a fieldset labelled "Time on <day>"; arrow keys move between times (and keep the focused time in view).
7. **Layout.** No horizontal scroll at 360 px wide (16 px side gutter); day cells and time rows are at least 44 px tall; light and dark both readable; no motion added (transitions only under `prefers-reduced-motion: no-preference`).
8. **Unchanged behaviour.** Zone line and fallback, no-slots, slot-gone reload, closed, rate-limited, invalid, unavailable and error states, and the POST body, exactly as F-001. The page makes the same three requests.
9. **Agent surfaces unchanged.** Build tool-parity check, `test/webmcp*.test.mjs` and `test/build.test.mjs` pass unmodified.

## Design notes

- Day keys stay `YYYY-MM-DD` in the visitor's zone (F-001 grouping). The grid does calendar arithmetic on those keys in UTC, so it never depends on the visitor's clock or a DST change.
- The months shown run from the first to the last free day; days outside them are not reachable.
- The hand-off to the rest of the flow is one function in the page script, `slotChosen(start)`; F-002's sign-in choice attaches there.
- New copy (content.json `pages.book.labels`): previous/next month, and the "free times" counts.
- The time list's scroll hint is a CSS `mask-image` fade on the list, switched on by a `data-more` attribute the script keeps in step with the scroll position. No extra copy.

## Tests

- `test/booking-pages.test.mjs`: the page script run in a VM against a fake DOM (criteria 1–6 incl. 4a–4c, 8).
- `test/book-calendar-browser.test.mjs`: the built page in headless Chromium against a fake API with the real CSP — keyboard path end to end, no CSP errors, the time list's single column, bounded height, scrolling, fade and reset to the top, no horizontal scroll at 360 px (criteria 4a–4c, 5–7). Skipped where Chromium is not installed (CI).
- Existing WebMCP, MCP and build tests unchanged (criterion 9).
