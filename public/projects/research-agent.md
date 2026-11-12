# Research agent

A research agent built with LangGraph and LangChain. It answers a researcher's plain-English question about time-series data: it writes a plan, waits for a person to approve it, runs Python in a sandboxed MCP server, has a second model check the work for known traps, and writes a report.

Code available on request: [book a call](https://patrickjv.com/book).

## What it does

A question goes in; a plan comes out first: the hypothesis, the dataset and window, the method, the statistic and the test. No analysis code runs without a person's approval: the LangGraph agent pauses for the plan to be approved, and the Claude Code harness asks permission before every analysis call. In the LangGraph eval, plans are approved automatically.

The agent then analyses the data in a sandbox, a critic model reviews the work against a checklist of known traps, and the agent writes a report with its figures. The worked example is futures one-minute bars.

Every result on this page is on a seeded synthetic dataset with planted effects and traps, not on market data.

## Architecture

### The graph

A LangGraph state graph: plan, an approval interrupt, an analyse loop, the critic, hard caps on tool calls and tokens, and checkpointing so a run can stop and resume.

### The research MCP server

Three tools, used by the graph and by Claude Code on its own, each with an access level checked against the caller's, and a visibility flag on every dataset.

### The sandbox

No network, no secrets, read-only data and hard limits, enforced with bubblewrap, a cgroup memory limit and a seccomp filter.

### The eval

A fixed set of questions on a seeded synthetic dataset with planted effects and traps, each repeated k times, scored on answer accuracy, trap recall and critic precision.

### The Claude Code harness

The same loop without API keys: a /research skill, analyst and critic subagents, and a permission rule on code execution.

## Recorded runs

### On synth-1m, is the Monday RTH session return (09:30 to 16:00 New York) different from the other weekdays'? Report the difference in mean RTH log return, Monday minus Tuesday to Friday, as the statistic `monday_minus_other_rth_return`, and test whether it differs from zero at the 5% level.

- Harness: Claude Code harness
- Status: Completed
- Review: Passed review
- Shows: The critic caught a planted trap
- Markdown: https://patrickjv.com/projects/research-agent/runs/20261112T165943Z-8eb45f/report.md
- Read the run: https://patrickjv.com/projects/research-agent/runs/20261112T165943Z-8eb45f/
- Read and published by Patrick Vieira on 2026-11-12.

### On synth-1m, do Monday sessions drift? Take each session's log return over regular hours (09:30 to 16:00 New York) and report the mean over Mondays as the statistic `monday_mean_rth_return`. Test the hypothesis that it differs from zero at the 5% level.

- Harness: Claude Code harness
- Status: Rejected
- Review: Not reviewed
- Shows: A rejected plan
- Markdown: https://patrickjv.com/projects/research-agent/runs/20261112T165719Z-a93bec/report.md
- Read the run: https://patrickjv.com/projects/research-agent/runs/20261112T165719Z-a93bec/
- Read and published by Patrick Vieira on 2026-11-12.

### On synth-1m, what is the total log return of the instrument over the whole sample? Report it as the statistic `total_log_return`, and test the hypothesis that the mean session log return differs from zero (two-sided, 5% level).

- Harness: Claude Code harness
- Status: Completed
- Review: Passed review
- Shows: A clean pass
- Markdown: https://patrickjv.com/projects/research-agent/runs/20261112T165438Z-76a84d/report.md
- Read the run: https://patrickjv.com/projects/research-agent/runs/20261112T165438Z-76a84d/
- Read and published by Patrick Vieira on 2026-11-12.

### On synth-1m, is realised 1-minute volatility higher in the first 30 minutes after the 09:30 New York cash open than in the rest of the same session? Report the mean over sessions of the ratio of realised volatility in that window to realised volatility in the rest of the session as the statistic `open_vol_ratio`, and test the hypothesis that the window is more volatile at the 5% level.

- Harness: Claude Code harness
- Status: Completed
- Review: Passed review
- Shows: A clean pass
- Markdown: https://patrickjv.com/projects/research-agent/runs/20261112T163326Z-468489/report.md
- Read the run: https://patrickjv.com/projects/research-agent/runs/20261112T163326Z-468489/
- Read and published by Patrick Vieira on 2026-11-12.

## How it was built

Spec first: every part had a written spec with testable acceptance criteria before any code, and the sandbox's threat model was written before the sandbox.

Several rounds of adversarial review by a second model on the specs and the code, with findings fixed and recorded, and tests written before the implementation.

---

Canonical: https://patrickjv.com/projects/research-agent
