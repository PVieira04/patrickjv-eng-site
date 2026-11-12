// F-005: the /projects pages — the index, the research-agent showcase and one page per published
// run — with their Markdown copies and the byte copies of each run's exported files. Model-written
// text is never trusted markup (D7): report.md goes through its own Marked instance with nothing
// live, and every other interpolated string is escaped plain text.
import { Marked, Renderer } from "marked";

export const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ---------------------------------------------------------------------------------------------
// D7a: report.md. A new Marked instance per report (never the shared `marked` the writing pages
// use): raw HTML escaped; no live link (a link renders as its text, then its target as plain text
// when that differs from the text); images dropped; task-list boxes as "[x] " text; every table and
// code block in a focusable, labelled scroll region; headings shifted so the shallowest level
// present is <h3>, capped at <h6>.
// ---------------------------------------------------------------------------------------------
const bare = (u) => u.replace(/^mailto:/i, "").replace(/^https?:\/\//i, "");
export function renderReportMd(md) {
  const m = new Marked({ gfm: true });
  let shallowest = 7;
  m.walkTokens(m.lexer(md), (t) => { if (t.type === "heading") shallowest = Math.min(shallowest, t.depth); });
  const n = { Table: 0, Code: 0 };
  const scroll = (kind, inner) => `<div class="scroll" role="region" aria-label="${kind} ${++n[kind]}" tabindex="0">\n${inner}</div>\n`;
  m.use({
    renderer: {
      html: ({ text }) => esc(text),
      link({ href, tokens, text }) {
        const shown = this.parser.parseInline(tokens);
        return bare(href) === bare(text) ? shown : `${shown} (${esc(href)})`;
      },
      image: () => "",
      checkbox: ({ checked }) => (checked ? "[x] " : "[ ] "),
      heading({ tokens, depth }) {
        const h = Math.min(6, depth - shallowest + 3);
        return `<h${h}>${this.parser.parseInline(tokens)}</h${h}>\n`;
      },
      table(token) { return scroll("Table", Renderer.prototype.table.call(this, token)); },
      code(token) { return scroll("Code", Renderer.prototype.code.call(this, token)); },
    },
  });
  return m.parse(md);
}
