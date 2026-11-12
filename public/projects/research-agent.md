# Research agent

A research agent built with LangGraph and LangChain. It answers a researcher's plain-English question about time-series data: it writes a plan, waits for a person to approve it, runs Python in a sandboxed MCP server, has a second model check the work for known traps, and writes a report.

Code available on request: [book a call](https://patrickjv.com/book).

## What it does

A question goes in; a plan comes out first: the hypothesis, the dataset and window, the method, the statistic and the test. Nothing runs until the plan is approved.

The agent then analyses the data in a sandbox, a critic model reviews the work against a checklist of known traps, and the agent writes a report with its figures. The worked example is futures one-minute bars.

Every result on this page is on a seeded synthetic dataset with planted effects and traps, not on market data.

## Architecture

### The graph

A LangGraph state graph: plan, an approval interrupt, an analyse loop, the critic, hard caps on tool calls and tokens, and checkpointing so a run can stop and resume.

### The research MCP server

Three tools, used by the graph and by Claude Code on its own, with access levels per caller and a visibility flag on every dataset.

### The sandbox

No network, no secrets, read-only data and hard limits, enforced with bubblewrap, a cgroup memory limit and a seccomp filter.

### The eval

Ten questions on a seeded synthetic dataset with planted effects and traps, each repeated k times, scored on answer accuracy, trap recall and critic precision.

### The Claude Code harness

The same loop without API keys: a /research skill, analyst and critic subagents, and a permission rule on code execution.

## Recorded runs

No published runs yet.

## How it was built

Spec first: every part had a written spec with testable acceptance criteria before any code, and the sandbox's threat model was written before the sandbox.

Several rounds of adversarial review by a second model on the specs and the code, with every finding fixed and recorded, and tests written before the implementation.

---

Canonical: https://patrickjv.com/projects/research-agent
