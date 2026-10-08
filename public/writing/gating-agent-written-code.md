# Holding agent-written code to the same standard as anyone's

Most of the code I ship is now drafted by an agent. My rule is that agent-written code has to meet the same bar as mine, and the system has to enforce that bar, because my attention will not hold out at a few hundred pull requests a month.

What follows is the golden path I use: the one supported route from an idea to a merged change. Every step exists because skipping it went wrong at least once.

## 1. A written spec before any code

An agent fills gaps confidently. If "done" is not written down, it will decide what done means. So every feature starts as a short spec with user stories and numbered acceptance criteria, and the spec is reviewed before anything is built.

The spec is also what the reviewer checks the code against. Without one, a reviewer can find bugs but not the feature that was quietly left out.

## 2. Tests first

For each acceptance criterion, a failing test comes first, then the smallest change that makes it pass. This is ordinary test-driven development. With agents it matters more, because an agent asked to "add tests" afterwards writes tests that describe what the code does, bugs included.

## 3. A gate the agent cannot talk its way past

An agent's summary will say it is finished whether or not it is, so the agent does not decide. A hook runs typecheck, lint and the test suite whenever an agent tries to end a turn that changed code, and the turn does not end until they pass.

## 4. Review by a model from a second vendor

Every change gets an adversarial review from a model trained by a different company from the one that wrote it. Models trained differently tend to miss different things. The reviewer reads the change against the spec and is asked to find what is wrong, not to approve.

When the two models disagree, I stop and decide myself rather than splitting the difference. A review round is also repeated until the findings narrow, because each round's fixes tend to introduce the next round's bugs.

## 5. Prove each test can fail

A test that also passes against the bug is not testing anything. So for anything that matters I revert the fix, watch the test fail, and put the fix back: revert-and-fail. It takes a minute and regularly catches tests that only looked like they were checking something.

## What it caught on this site

This site was built on that path, and its [source is public](https://github.com/PVieira04/patrickjv-eng-site). It went through three rounds of review by two models, and every finding is recorded with its outcome in [the merged review](https://github.com/PVieira04/patrickjv-eng-site/blob/main/docs/reviews/2026-10-06-merged-review.md). A few that tests alone would not have found:

- The alias domains redirected a `POST` with a `301`, which lets a client turn it into a `GET` and drop the body. They now answer `308` for anything that is not a read.
- The per-sender limit on introductions counted `jane.smith@` and `janesmith+x@` as different people. It now normalises Gmail's ignored dots and `+tags` before counting.
- One release sent the page two security policies at once, and the stricter one blocked its own stylesheet. The build now refuses any header rule that could do that again, and a test proves the refusal works.

None of these is exotic, and each would have shipped without the review.

## What it does not do

It does not replace judgement. The spec still has to be right, and choosing what to build is still my job. It also costs time: a review round takes minutes, and a disagreement can take an hour to settle. I would still rather spend that hour than find the problem in production.

## The same path at work

At work the same golden path is the default for every repository. A versioned engineering-standards baseline is rolled out to about 26 repositories by automated pull request, and CI rejects any change to the baseline that does not bump its version, so every repository can say which rules it follows.

Agents can draft code faster than anyone can read it, so I don't rely on reading every line. The spec, the tests, the hook and the second review decide whether a change merges, and I answer for what does.

---

Patrick Vieira, 2026-10-08. Canonical: https://patrickjv.com/writing/gating-agent-written-code
