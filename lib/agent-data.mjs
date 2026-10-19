// The public profile data offered to agents, derived from content.json.
// Shared by build.mjs (WebMCP data baked into index.html) and the MCP Worker (mcp/),
// so both surfaces always expose the same facts.
export const SITE = "https://patrickjv.com/";

export function agentData(c) {
  return {
    profile: {
      name: c.person.name, headline: c.person.headline, tagline: c.person.tagline, location: c.person.location,
      links: { website: SITE, linkedin: c.person.links.linkedin, github: c.person.links.github, email: c.person.links.email, cv: SITE + "cv" },
    },
    work: c.work.map(({ title, summary, tags }) => ({ title, summary, tags })),
    skills: c.skills,
    faq: c.faq,
  };
}
