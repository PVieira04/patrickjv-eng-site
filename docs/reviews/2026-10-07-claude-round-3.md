# Claude Opus 5.5 round-3 review — 7 Oct 2026

Summary of the subagent's report (live network access; read-only). Reviewed commit 06a1af7. IDs C3-F1…F16 are referenced from the merged review.

## Overall
Code is in good shape (87/87 tests; build, `_headers` guard, MCP handler, quota DO and smoke hold up line by line). What earlier rounds missed sits between components and outside the repo: the 7 Oct zone hardening skipped the alias zone; the edge WAF rule cancels the R15 shared-egress fix; the CI deploy token is a repository-level secret readable by a workflow on any branch, and is account-wide; `docs/06` is stale about CI the day before token rotation. Nothing Critical.

## Findings
| ID | Sev | Finding | Evidence | Fix |
|---|---|---|---|---|
| C3-F1 | Medium | CI deploy token readable by any branch's workflow; leak → arbitrary Worker deploys incl. a forged `/.well-known/did.json` | Repo-level secret; no environments; branch protection/rulesets unavailable on GitHub Free private repos (API 403); `github.ref` guard only protects `deploy.yml` | Workers Builds (no token in GitHub), or manual deploys, or at minimum least-privilege token (Account Workers Scripts:Edit + Zone `patrickjv.com` Workers Routes:Edit, no KV/R2), with TTL |
| C3-F2 | Medium | Edge WAF 6 req/10 s per IP defeats R15 (handshake exemption, 10/10 s) for IPv4; 1015 HTML block to MCP clients; per-IP intro caps shared by hosted-client egress; docs overstate "stops floods" (6/10 s ≈ 51,840 req/IP/day) | Arithmetic on config | Decide the binding constraint; raise the WAF threshold or exempt known egress; correct docs |
| C3-F3 | Medium | Alias zone `pvieira.co.uk` not hardened: NEL still sent, TLS 1.0/1.1 accepted, no CAA, no Always Use HTTPS | Live headers (`report-to … a.nel.cloudflare.com`), `openssl -tls1` negotiates | NEL off, min TLS 1.2, Always Use HTTPS, CAA on the alias zone; correct docs/05, docs/07 |
| C3-F4 | Medium (suspected) | Workers Logs invocation logs likely retain IP/geo per request, contradicting privacy claims | `observability` on ⇒ invocation logs default on | Disable invocation logs (custom events still flow) or state retention |
| C3-F5 | Medium | `docs/06` says deploy-on-push and the CI token don't exist; no rotation procedure | `DEPLOY_ENABLED=true`, secret present, deploy run succeeded | Rewrite; document rotation order (new token → set secret → dispatch deploy → verify → revoke old) |
| C3-F6 | Low–Med | `tenlines.patrickjv.com` (GitHub Pages) custom domain not verified ⇒ takeover risk if the Pages site is removed but the CNAME stays | No `_github-pages-challenge-…` TXT | Verify the domain in GitHub Pages settings; remove the CNAME when retiring the site. (Apex CAA does not apply to tenlines — github.io's does.) |
| C3-F7 | Low | DNSSEC DS not yet published; docs already claim the protection; nothing monitors it | RDAP `delegationSigned: false` | Monitor DS/AD; chase with Registrar if still missing |
| C3-F8 | Low | No end-to-end signal for the `request_intro` email path | Smoke never calls it; `mcp/index.js` untested | Readiness check / alert on `mcp_failure`; periodic manual test |
| C3-F9 | Low | Soft 404: `GET /404` returns 200 with the 404 page | Live | Accept (noindex) and document, or redirect |
| C3-F10 | Low | `dateModified`/`lastmod` move on non-content changes (headers, 404, fonts, security.txt) | `build.mjs` hash inputs | Hash content-bearing outputs only |
| C3-F11 | Low | Intro emails carry country + user agent to Gmail (US) indefinitely; privacy note silent | `handler.js` body footer | Drop the metadata or disclose it |
| C3-F12 | Low | Global daily cap of 10 is easy to exhaust (denial for everyone) | Arithmetic | Accept as trade-off; document |
| C3-F13 | Low/Nit | `marineweather` DMARC `p=none` without `rua`; Resend DKIM 1024-bit; apex `fo=1` inert without `ruf` | DNS | Add `rua`, then tighten |
| C3-F14 | Nit | WebMCP confirm shows raw input; server strips bidi/zero-width/control chars ⇒ approved text can differ | `index.html` | Normalise before display |
| C3-F15 | Nit | Actions on Node 20 (deprecation warning), no Dependabot, `sha_pinning_required` off; monitor and deploy share no concurrency group | Run annotations | Bump pinned actions, add Dependabot, shared concurrency |
| C3-F16 | Nit | README presents Lighthouse 100 / axe 0 as current, but audits predate the fixes | README vs docs/05 | Re-run and update |

## Previously reported, incomplete
R5 (NEL alias), R4 (alias TLS/CAA; DS; CAA reasoning), R13 (secret readable from any branch; table stale), R15 (WAF stricter than Worker), R14/N6/R40 privacy statements (invocation logs), R62/docs (docs/06 stale; SPF `-all` listed as open).

## Checked and correct (abridged)
87/87 tests; CSP hashes match live; live `/` bytes equal repo (no Cloudflare injection); MCP handler safety properties; alarm invariants; redirect semantics; pinned action SHAs genuine (not imposter commits); `persist-credentials: false`; certificates permitted by CAA; no other subdomains in CT logs; DMARC rua to same-domain address (no loop); apex DKIM exists; `pvieira.co.uk` mail lockdown and DNSSEC correct; images metadata-free; `did.json` hash matches live (no `Access-Control-Allow-Origin` — relevant only if sign-in resolves the DID in a browser).
