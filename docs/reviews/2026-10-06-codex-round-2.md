# Codex (gpt-6.1-sol) round-2 review — 6 Oct 2026

Raw report, verbatim. Reviewed code/config at commit 8c90261 plus a post-fix live snapshot (no network in its sandbox). Line references are to that tree.

The fixes substantially improve the repo, but **material issues remain**, particularly CI credential isolation and smoke-test false positives. I found no new Critical or High production-code defect.

Reviewed code/config at `8c90261`, using the supplied production snapshot dated **2026-10-06 22:29 UTC**. Owner/dashboard items and the concurrent documentation rewrite are excluded. I made no filesystem changes, deployments or network requests; introduction tests used the existing fake email transport.

Validation:

- `node build.mjs --check`: **PASS**.
- Native `npm test`: **64 passed; four blocked by `EROFS`** when creating scratch directories.
- All **68 tests passed** with scratch-file operations redirected to an in-memory filesystem. This verifies their logic, while filesystem integration remains unverified here.

**R-item status**

File references below are relative to the repository. “VERIFIED-FIXED” assesses the original code finding; it does not imply every related implementation detail is flawless.

| ID | Status | Evidence / remaining issue |
|---|---|---|
| R10 | VERIFIED-FIXED | `public/index.html:892` supports document/navigator; `:937` catches registration rejections; `:903`, `:914`, `:921` handle intro cancellation. Both API placements registered five tools in a memory harness. |
| R11 | VERIFIED-FIXED | `public/index.html:896` includes every field; `:905` snapshots input; `:931` copies annotations. `build.mjs:310` reuses MCP descriptions, including disambiguation. |
| R12 | PARTIALLY FIXED | Status/envelope/uniqueness checks, frozen DID hash, timeouts and independent checks are present. `smoke.mjs:80`, `:121`, `:126`, `:194`, `:217` still permit false PASS results; POST regression is nonfatal at `:161`. See N1. |
| R13 | PARTIALLY FIXED | Credential-free push/PR/reusable tests: `.github/workflows/test.yml:4`; deploy dependency: `deploy.yml:21`; SHA pins and disabled checkout credentials are present. **`deploy.yml:36` invokes `package.json:11`, which reruns tests with the deployment token.** Dispatch also lacks a main-branch guard at `deploy.yml:22`. |
| R14 | VERIFIED-FIXED | Redacted application failure events: `mcp/handler.js:52`, `:394`, `:409`, `:465`; observability enabled at `mcp/wrangler.jsonc:11`. Invocation metadata needs separate attention—N6. |
| R15 | VERIFIED-FIXED | Handshake exemptions: `mcp/handler.js:30`, `:422`; increased limits: `mcp/wrangler.jsonc:27`; daily IP allowance: `handler.js:23`. Dashboard edge limits remain outside this verdict. |
| R16 | VERIFIED-FIXED | Static Worker disables both origins at `wrangler.jsonc:7`; MCP does likewise at `mcp/wrangler.jsonc:7`. Redirect already disables workers.dev at `redirect/wrangler.jsonc:5`. |
| R17 | VERIFIED-FIXED | `public/_headers:16`, `:24` set `Vary: Accept`. Snapshot confirms both negotiated representations. |
| R18 | VERIFIED-FIXED | Explicit UTF-8 types for the affected text assets: `public/_headers:22`, `:27`, `:31`, `:35`, `:39`, `:43`. |
| R19 | PARTIALLY FIXED | Worker responses and known static assets have policies; arbitrary 404s use meta CSP. **Missing `/fonts/*` paths also receive the baseline header CSP**, blocking their 404 styling—N3. `/index`’s redirect has no CSP; harmless for its empty body. |
| R20 | VERIFIED-FIXED | Real page: `public/404.html:38`; fallback configuration: `wrangler.jsonc:10`. Snapshot records a real 404 response. |
| R21 | PARTIALLY FIXED | Section, hidden-attribute, exact-stat, skill and link-target checks work: `build.mjs:151`. **CSS-hidden content still passes** because visibility at `:105` checks attributes/tags only. Adding `#skills { display:none }` yielded zero errors. |
| R22 | VERIFIED-FIXED | Head metadata generated at `build.mjs:322`; drift regression covered at `test/build.test.mjs:155`. |
| R23 | PARTIALLY FIXED | One-run convergence and Git independence work: `build.mjs:481`, `:486`; tests at `test/build.test.mjs:119`. **Hash coverage excludes served asset bytes and independently maintained assets**—N5. |
| R24 | VERIFIED-FIXED | `<` and Unicode separators escaped by `build.mjs:252`; applied at `:334`, `:335`. |
| R25 | VERIFIED-FIXED | All validation precedes writes: `build.mjs:493`, `:507`; regression at `test/build.test.mjs:140`. The separate claim of atomic publication at `:508` is too strong; see qualification below. |
| R26 | VERIFIED-FIXED | Parser-based inline-code checks: `build.mjs:124`; quoting/case/attribute regressions: `test/build.test.mjs:74`. |
| R27 | VERIFIED-FIXED | Finite-date and expiry-window checks: `build.mjs:239`; invalid/near/far tests: `test/build.test.mjs:93`. |
| R28 | VERIFIED-FIXED — code comment only | `build.mjs:22` accurately describes a finite denylist. Documentation portion excluded. |
| R30 | VERIFIED-FIXED | Source-aware numeric-ID parsing and safe-integer checks: `mcp/handler.js:300`, `:306`, `:420`; tests at `handler.test.mjs:450`. |
| R31 | VERIFIED-FIXED | Present-but-empty Origin rejected at `mcp/handler.js:378`; tests at `handler.test.mjs:356`. |
| R32 | VERIFIED-FIXED | Dot-atom validation and preserved local-part case: `mcp/handler.js:105`, `:123`, `:125`. |
| R33 | VERIFIED-FIXED | Code-point lengths: `mcp/handler.js:100`, `:121`, `:128`. |
| R34 | VERIFIED-FIXED | MIME body canonicalized to CRLF: `mcp/handler.js:182`; test at `handler.test.mjs:186`. |
| R35 | VERIFIED-FIXED | Initialize/client-response validation: `mcp/handler.js:316`, `:319`, `:416`, `:436`. |
| R36 | VERIFIED-FIXED | Bidi/zero-width stripping: `mcp/handler.js:97`; regression at `handler.test.mjs:180`. |
| R37 | VERIFIED-FIXED | Quota identity normalization: `mcp/handler.js:136`, `:347`; variants tested at `handler.test.mjs:228`. |
| R38 | VERIFIED-FIXED | Method-preserving redirects: `redirect/index.js:20`; tests at `index.test.mjs:23`; snapshot confirms POST 308. |
| R39 | VERIFIED-FIXED | Version imported from Registry entry: `mcp/handler.js:12`, `:16`, `:440`. |
| R40 | PARTIALLY FIXED | HMAC keys and pruning exist; privacy notice is present at `public/index.html:881`. **Public salt fallback, lost-alarm sequence and legacy-state cleanup remain concerns**—N2/N4. |
| R41 | VERIFIED-FIXED | Harness uses real reservation logic at `mcp/handler.test.mjs:53`; OPTIONS, protocol, declared size and exact malformed-RPC checks at `:348`, `:370`, `:378`, `:434`. |
| R42 | PARTIALLY FIXED | Smoke performs lifecycle/header negotiation: `smoke.mjs:177`, `:189`, `:199`. **WebMCP still sends `tools/call` directly**, without initialization or protocol header: `public/index.html:919`. |
| R51 | VERIFIED-FIXED — CSS portion | Correct selectors and narrower break avoidance: `public/index.html:542`, `:546`. Printed pagination was not visually verified; documentation claim excluded. |
| R53 | NOT FIXED | Undeclared generator tooling/local fonts remain: `designs/favicon/make-icons.cjs:5`, `designs/og/make-card.cjs:2`. Card remains outside build drift checks: `build.mjs:458`. |
| R54 | VERIFIED-FIXED — config portion | Node engine declared at `package.json:5`; CI uses `npm ci --ignore-scripts` at `.github/workflows/test.yml:22`. Documentation excluded. |
| R55 | NOT FIXED | Dependency versions remain unchanged: `package.json:15`, `package-lock.json:1304`, `:1349`. No fresh online advisory audit was possible; the reported dependency issue has not been remediated. |
| R56 | VERIFIED-FIXED | Fonts lose `immutable`; images receive a one-day lifetime: `public/_headers:51`, `:55`. |
| R57 | VERIFIED-FIXED — reported CSS cause | Grid minimum now bounded by container width: `public/index.html:488`; wrapping improvements at `:364`, `:478`. Full browser reflow verification remains unavailable. |
| R58 | VERIFIED-FIXED | Decorative square hidden from accessibility tree: `public/index.html:572`. |
| R59 | VERIFIED-FIXED | Country generated as `GB`: `build.mjs:293`, `public/index.html:89`. |
| R60 | VERIFIED-FIXED — repository tooling | Preview builder/config deleted in the reviewed diff: former `designs/build-preview.mjs:1`, `designs/wrangler.preview.jsonc:1`. Production deployment command at `package.json:11` contains only the three intended Workers. |
| R61 | VERIFIED-FIXED | Biased shuffle removed with former `designs/build-preview.mjs:6`; both raw Codex logs deleted in the reviewed diff. |

R29 is not defined in the merged report.

**New findings, ranked**

1. **Medium — Smoke can certify incorrect responses and a reverted POST redirect. VERIFIED, memory reproduction.**  
   **Locations:** [smoke.mjs:161](/home/patrickjv/projects/pvieira04/patrickjv-eng-site/smoke.mjs:161), `:80`, `:121`, `:126`, `:194`, `:217`.

   The new “308 not deployed yet” exception remains active even though the snapshot proves 308 is deployed. A regression to POST 301 therefore produces WARN and exit zero.

   A mocked run returned **21 PASS, two WARN, zero FAIL, exit 0** while supplying:

   - POST 301;
   - five incorrect FAQ entries;
   - empty image/XML/text bodies;
   - `text/markdown-bogus` containing an unrelated profile;
   - an incorrect MCP server name;
   - HTTP 500 on the security-header check, with otherwise matching headers.

   **Fix:** Make POST 301 fail now; require successful status in every check, compare FAQ and Markdown content with the repository, parse MIME types exactly, validate server identity, and validate representative asset bodies.

2. **Low — Delayed quota alarm can consume the only cleanup alarm. VERIFIED, memory reproduction.**  
   **Locations:** [mcp/handler.js:265](/home/patrickjv/projects/pvieira04/patrickjv-eng-site/mcp/handler.js:265), `:269`, `:275`.

   Reproduced sequence: reserve before midnight; reserve just after midnight before the old alarm runs; fire the delayed alarm. The new-day reservation retains the old scheduled alarm because `getAlarm()` is non-null. The alarm preserves today’s counters but schedules nothing further. **Counters remain with `alarm: null` indefinitely unless another reservation occurs.**

   Existing tests cover alarm-before-reservation only. Old pre-fix counters also receive no cleanup alarm merely through deployment.

   **Fix:** Ensure retained counters have an alarm at their expiry; reschedule from the alarm handler when today’s state survives, and bootstrap cleanup for legacy state.

3. **Low — Font-path 404 receives two incompatible CSPs and a 30-day cache policy. VERIFIED against installed asset-worker code; production path untested.**  
   **Locations:** [public/_headers:51](/home/patrickjv/projects/pvieira04/patrickjv-eng-site/public/_headers:51), [public/404.html:5](/home/patrickjv/projects/pvieira04/patrickjv-eng-site/public/404.html:5), `build.mjs:439`.

   The installed asset worker resolves `/fonts/no-such-font.woff2` to `404.html`, then applies headers using the requested path. Result: baseline `default-src 'none'` plus the meta policy. Policies intersect, so the meta policy cannot authorize the page’s style/fonts. The wildcard also assigns `max-age=2592000` to the missing resource.

   **Fix:** Generate exact font-file rules instead of `/fonts/*`, including their cache policies. Add missing-font-path smoke coverage.

4. **Low — Missing `QUOTA_SALT` silently weakens HMAC privacy. VERIFIED conditional behavior; production secret presence unknown.**  
   **Location:** [mcp/handler.js:231](/home/patrickjv/projects/pvieira04/patrickjv-eng-site/mcp/handler.js:231).

   The fallback key is public source code. I independently reproduced the fallback IP hash. It provides no secret protection against guessing IPs or sender addresses, despite using HMAC.

   **Fix:** Require a configured secret before reserving introductions, or provision and persist a genuinely random secret. Keep read tools available.

5. **Low — Content-hash dates miss changes to served profile assets. VERIFIED, memory reproduction.**  
   **Locations:** [build.mjs:479](/home/patrickjv/projects/pvieira04/patrickjv-eng-site/build.mjs:479), `:481`, `:482`.

   The hash covers generated text outputs with a placeholder date. Image **filenames** affect `_headers`; image/font **bytes** do not. `security.txt`, DID bytes and Registry authentication bytes are also outside the hash, although DID integrity is checked separately.

   Changing portrait bytes under the existing filename and changing a valid security expiry yielded `errors: []`, `stale: []`, unchanged date.

   **Fix:** Include relevant served asset digests—especially the portrait/share image—or explicitly limit the state’s meaning to generated text.

6. **Low — Application-event redaction does not configure invocation-URL redaction. SUSPECTED production privacy exposure.**  
   **Location:** [mcp/wrangler.jsonc:11](/home/patrickjv/projects/pvieira04/patrickjv-eng-site/mcp/wrangler.jsonc:11).

   Console events are redacted correctly. However, observability enables invocation logging without setting query-string redaction. The installed Wrangler schema specifies `redact_query_string` defaults to false. Personal information placed in `/mcp?...` can consequently enter request metadata independently of the safe console events. Actual retained production logs were unavailable.

   **Fix:** Set `redact_query_string: true`; disable invocation logs if only explicit operational events are required.

7. **Nit — New-field coverage tracks values, rather than field paths. VERIFIED.**  
   **Locations:** [build.mjs:153](/home/patrickjv/projects/pvieira04/patrickjv-eng-site/build.mjs:153), `:161`, `:233`.

   Adding `new_field: content.person.name` produces no error: another field already put that value into `used`. This bypasses the stated guarantee that new fields receive their own checks.

   **Fix:** Track checked content paths or validate an explicit content schema.

**Other targeted conclusions**

The primary page’s CSP is correct in both code and snapshot. `/index.html`’s **307 does not carry its CSP into the destination document**; `/` supplies the destination policy. Arbitrary 404s intentionally use meta CSP, so “every path gets exactly one CSP header” is not true. The 404 meta policy appears before its stylesheet, has the correct hash, and framing remains blocked by the global X-Frame-Options header.

Moving burst limiting after parsing preserves the pre-body minute limiter and byte cap. I found no new quota-cap bypass or raw-data application log. The Registry JSON import works in Node 24 and introduces no import cycle.

Smoke sends only **four MCP requests**, so its current sequence fits six requests per ten seconds. The comment claiming 1.2-second spacing generally respects that limit is inaccurate; a longer sequence would need slower pacing.

Build convergence is sound for the hashed outputs. Separately, temporary-file staging is **not transactional**: an injected second-rename failure changed `_headers`, left the old build state and four temporary files. Validation failures write nothing, but I/O failures can leave mixed outputs; `build.mjs:508` and the CLI’s “nothing written” message at `:519` overstate that guarantee.

The reusable CI test job correctly gates deployment and validates PRs without secrets. Remaining CI work is to avoid rerunning tests inside the token-bearing deployment command and restrict production dispatch to the intended branch. SHA literals are present; their upstream provenance could not be independently checked offline.
