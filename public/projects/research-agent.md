# Research agent

A research agent built with LangGraph, LangChain and MCP. You ask it a question about time-series data in plain English, and it plans, runs and checks the analysis before it reports.

The code is available on request. [Book a call](https://patrickjv.com/book).

## What it does

Before any analysis, the agent writes a plan with a hypothesis, dataset and window, method, statistic and test. No analysis code runs until a person approves it. The LangGraph agent pauses for the plan to be approved, and the Claude Code harness asks permission before every analysis call. In the LangGraph eval, plans are approved automatically.

It then analyses the data in a sandbox. A critic model checks the work against a list of known traps before the agent writes its report and figures. The example data is one-minute futures bars.

Every result on this page is on a seeded synthetic dataset with planted effects and traps, not on market data.

## Architecture

Two harnesses drive the same loop, and both talk to one MCP server. The LangGraph graph calls models through an API. The Claude Code harness runs inside Claude Code and needs no API keys. Only the server can reach the data or run code. It runs analysis code in a sandbox that reads dataset folders from disk, and keeps a record of every run.

Because the boundary is MCP, any MCP client could drive the same server, and any dataset folder can be plugged in. A folder holding a dataset.toml descriptor and Parquet or CSV bars, under a directory named in the config, shows up in list_datasets. Sandboxed code never reaches the network. Market data is fetched separately, by a command that writes a dataset folder to disk, and the sandbox only ever reads it.

Diagram: The components: two harnesses drive one MCP server, which runs code in a sandbox over read-only dataset folders; the fetcher and the publish step run separately.

At the top, two clients: the LangGraph graph, built from LangChain models and tools, and the Claude Code harness, with its /research skill and subagents. Both connect over MCP on stdio to one research MCP server, which offers list_datasets, describe_dataset and run_analysis. The server runs each analysis in a sandbox with no network, and keeps a record of every run. The sandbox reads dataset folders, each a dataset.toml and Parquet or CSV bars, mounted read-only. Two parts run separately, outside the agent loop: the fetcher, which writes market data to a dataset folder on disk, and the publish step, which reads a finished run from the run records, checks it and exports it for this site, where a person checks it again.

### Where LangGraph comes in

The agent is a LangGraph StateGraph with seven nodes, from plan to report. Its state is a typed dictionary holding the messages, the plan, the analysis calls, the critic's verdicts and running counts of tool calls and tokens. When a node meets an ending, such as a rejected plan, a cap or an error, it records that in the state. The conditional edges then send the run straight to report, so every run ends with a report that says how it stopped.

Approval is a LangGraph interrupt. The approve node calls interrupt() with the plan, and the run pauses until the caller resumes it with Command(resume=…). The answer is approve, edit with a changed plan, or reject with a reason. apply_decision checks it and sends an invalid answer back to approve, with the reason shown.

The checkpointer is LangGraph's AsyncSqliteSaver. The run id is the thread id, and durability is set to sync, so each completed step is saved before the next one starts. A run paused at approval, or stopped by a rate limit or a timeout, resumes from its last completed step and keeps the models it started with.

In the analyse loop the agent and tools nodes take turns until the analyst stops calling tools. Then the critic reviews the pass. If its verdict is revise, a new pass starts with the critic's issues, up to a set number of critic calls. Hard caps on tool calls per pass, tool calls per run and tokens per run end the run as capped, and the report names the cap and its value.

Diagram: The LangGraph graph: plan, an approval interrupt, an analyse loop of agent and tools, the critic, and the report.

The run starts at plan, which writes a structured plan. approve pauses the run with a LangGraph interrupt until a person resumes it with approve, edit or reject; apply_decision checks the answer and sends an invalid one back to approve. After approval, agent (the analyst model) calls tools, which runs the MCP tools through a ToolNode, and the two alternate until the analyst stops calling tools. critique then runs the critic; a verdict of revise starts a new pass at agent, and pass goes on to report. A rejected plan, a crossed cap on tool calls or tokens, or an error routes straight to report. A SQLite checkpointer saves the state after every step, so a run can stop and resume.

### Where LangChain comes in

The models are named in the config as provider:model strings and built with LangChain's init_chat_model. Neither the analyst nor the critic is tied to one vendor, and the tests pass in fake models through the same factory.

The MCP tools reach the graph through langchain-mcp-adapters. A run starts the MCP server over stdio and keeps one session open for the whole run, and load_mcp_tools turns the server's tools into LangChain tools. The analyst gets them through bind_tools, one call at a time, and LangGraph's ToolNode runs them. A wrapper around each call logs it, and refuses run_analysis on any dataset other than the approved plan's.

The plan and the critic's verdict are structured output, from with_structured_output against Pydantic models. Every issue the critic raises is tagged from a fixed checklist of traps, such as look-ahead, contract rolls, timezones and sessions, or multiple comparisons. Output that fails validation gets one more try. If that fails too, the run ends as failed rather than guessing.

### The research MCP server

It is one FastMCP server with three tools. list_datasets and describe_dataset need access level read, and run_analysis needs execute. Every call carries a caller context, checked before any work, and a dataset marked private is visible only to a caller that owns the local datasets. Results are structured. A refusal comes back inside the result with a reason code, such as access denied or sandbox unavailable, so a client can act on it.

The server chooses the run, never the caller. Each analysis call gets its own numbered directory, and only one sandbox runs at a time per user on the machine.

### The sandbox

Generated code is treated as hostile. Each run_analysis call starts a fresh sandbox in layers. A systemd user scope puts it in a cgroup that caps memory, tasks and CPU. prlimit caps file size and open files and turns off core dumps. bubblewrap gives it a cleared environment with a fixed allow-list of variables, no network and no capabilities, and mounts only what it needs, read-only: the system's /usr libraries, the Python runtime and its packages, the code, a small helper and the one dataset. Inside all that, a seccomp filter denies io_uring, BPF, the keyring calls and socket families other than Unix and IP.

The code can write only to sized in-memory file systems. When it ends, the sandbox's own PID 1 kills every other process, and the host copies out a JSON result and up to four PNG figures, each checked. A self-test runs before the first call. If the sandbox can't be set up, the call is refused, because there is no unsandboxed fallback. I red-teamed it with 22 probe scripts, about 40 escape and exhaustion attempts.

Diagram: The sandbox's layers, from the outside in: a systemd scope, prlimit, bubblewrap and a seccomp filter around the generated code.

The outermost layer is a systemd user scope, a cgroup that caps memory, tasks and CPU. Inside it, prlimit caps file size and open files and turns off core dumps. Inside that, bubblewrap gives a cleared environment with a fixed allow-list of variables, no network, no capabilities and only read-only mounts (the system libraries, the Python runtime, the code and the dataset), apart from /out, /tmp and /dev/shm, which are sized in-memory file systems. Inside that, a seccomp filter denies system calls such as io_uring, bpf and the keyring calls. At the centre, the generated code runs under a fixed launcher, which kills every other process when the code ends. The host then copies out only a JSON result and up to four checked PNG figures.

### The Claude Code harness

The same loop runs in Claude Code with no API keys. A /research skill drives it. Only the research-analyst subagent calls run_analysis, and a research-critic subagent reviews each pass with the same checklist and verdict model as the graph. run_analysis is on the project's ask list, so a person approves every analysis call, while listing and describing datasets go through without a prompt.

Hooks check every research call and keep the run's record. A hook can deny a call but never allows one, and a hook that fails, fails closed. The harness writes its report in the same format as the graph.

### The eval

The eval asks each question from a fixed set several times. The data is a seeded synthetic dataset whose generator plants effects and traps, and a reference implementation computes the expected answers. Besides answer accuracy, the scorer measures trap recall, the share of passes that fell into a trap where the critic raised that trap's tag. It also measures critic precision, the share of the critic's issues tagged with one of the question's traps that were raised on a pass that really fell into it. The scorecard records the seed and the config.

### Publishing

Nothing reaches this page straight from a run. A publish command checks a finished run or a scorecard and writes an export folder. It reads each file once without following links, validates report.json against its schema and refuses anything not on the synthetic dataset. It scans every string for secrets, host paths and a denylist, and strips metadata chunks from figures. This site then records a person's check of each export, with a hash of every file, before the build will use it.

## Phase 1: Build and baseline

This phase covers research-agent v1.0.0 to v1.2.0. The measurements were made on 12 and 13 November 2026.

### Question

Can an agent with plan approval, gated tools and a reviewing model answer quant research questions correctly?

### What was built

v1.0.0 is the system described above: two harnesses over one MCP server, the sandbox, the eval and the publish step. v1.1.0 changed the analyst prompt and capped local-model output, because a gpt-oss:120b planning step had run for about 85 minutes until its context filled. With the cap, the longest run took 22 minutes. v1.2.0 fixed retries after a cut-off and the run budget, and has no runs of its own.

Every part had a written spec with testable acceptance criteria before any code was written, and the sandbox's threat model was written before the sandbox.

A second model reviewed the specs and the code adversarially over several rounds. I fixed or recorded each finding, and wrote the tests before the code.

### How it was measured

Both harnesses answered the same eval questions on the seeded synthetic dataset, and the repo's own scorer marked each answer against the reference implementation. Claude ran through the Claude Code harness five times per question, with Sonnet 5.5 as planner and analyst and Opus 5.5 as critic.

The open models ran through the LangGraph pipeline, served by Ollama on a DGX Spark, one run per question. Each local-model call was capped at 8,192 output tokens and each run at 30 minutes.

monday_drift and thursday_drift have a wide absolute tolerance, so a near-zero answer can pass on its conclusion.

### Results

The scorecard is from research-agent v1.0.0, on 12 November 2026. The four recorded runs, also through the Claude Code harness, were made earlier that day. The open-model runs used v1.1.0.

#### Eval scorecard

- Date: 2026-11-12
- Runs: 50 runs: 10 questions × 5
- Harness: Claude Code harness (50)
- Models: analyst claude-code:claude-sonnet-5-5, critic claude-code:claude-opus-5-5
- Seed: 20261111
- Score: 0.90 (standard error 0.06)

| Question | Correct | Trap handled | Trap recall | Critic precision |
|---|---|---|---|---|
| `open_vol_uplift` | 5 / 5 | 5 / 5 | no trap reached the critic | the critic flagged none of this question's traps |
| `open_vol_uplift_pct_change` | 5 / 5 | 5 / 5 | no trap reached the critic | the critic flagged none of this question's traps |
| `open_vol_uplift_15m` | 5 / 5 | 5 / 5 | no trap reached the critic | the critic flagged none of this question's traps |
| `afternoon_vol_ratio` | 0 / 5 | no planted trap | no planted trap | no planted trap |
| `tuesday_drift` | 5 / 5 | no planted trap | no planted trap | no planted trap |
| `thursday_drift` | 5 / 5 | 5 / 5 | no trap reached the critic | the critic flagged none of this question's traps |
| `monday_drift` | 5 / 5 | no planted trap | no planted trap | no planted trap |
| `total_return` | 5 / 5 | 5 / 5 | no trap reached the critic | the critic flagged none of this question's traps |
| `return_2024` | 5 / 5 | 5 / 5 | no trap reached the critic | the critic flagged none of this question's traps |
| `largest_session_move` | 5 / 5 | 5 / 5 | no trap reached the critic | the critic flagged none of this question's traps |

In these 50 eval runs no pass fell into a planted trap, so no trap reached the critic, and it raised no trap issue. That is why trap recall and critic precision are not defined here. The recorded runs on this page are separate runs.

#### Recorded runs

##### On synth-1m, is the Monday RTH session return (09:30 to 16:00 New York) different from the other weekdays'? Report the difference in mean RTH log return, Monday minus Tuesday to Friday, as the statistic `monday_minus_other_rth_return`, and test whether it differs from zero at the 5% level.

- Harness: Claude Code harness
- Status: Completed
- Review: Passed review
- Shows: The critic caught a planted trap
- Markdown: https://patrickjv.com/projects/research-agent/runs/20261112T165943Z-8eb45f/report.md
- Read the run: https://patrickjv.com/projects/research-agent/runs/20261112T165943Z-8eb45f/
- Read and published by Patrick Vieira on 2026-11-12.

##### On synth-1m, do Monday sessions drift? Take each session's log return over regular hours (09:30 to 16:00 New York) and report the mean over Mondays as the statistic `monday_mean_rth_return`. Test the hypothesis that it differs from zero at the 5% level.

- Harness: Claude Code harness
- Status: Rejected
- Review: Not reviewed
- Shows: A rejected plan
- Markdown: https://patrickjv.com/projects/research-agent/runs/20261112T165719Z-a93bec/report.md
- Read the run: https://patrickjv.com/projects/research-agent/runs/20261112T165719Z-a93bec/
- Read and published by Patrick Vieira on 2026-11-12.

##### On synth-1m, what is the total log return of the instrument over the whole sample? Report it as the statistic `total_log_return`, and test the hypothesis that the mean session log return differs from zero (two-sided, 5% level).

- Harness: Claude Code harness
- Status: Completed
- Review: Passed review
- Shows: A clean pass
- Markdown: https://patrickjv.com/projects/research-agent/runs/20261112T165438Z-76a84d/report.md
- Read the run: https://patrickjv.com/projects/research-agent/runs/20261112T165438Z-76a84d/
- Read and published by Patrick Vieira on 2026-11-12.

##### On synth-1m, is realised 1-minute volatility higher in the first 30 minutes after the 09:30 New York cash open than in the rest of the same session? Report the mean over sessions of the ratio of realised volatility in that window to realised volatility in the rest of the session as the statistic `open_vol_ratio`, and test the hypothesis that the window is more volatile at the 5% level.

- Harness: Claude Code harness
- Status: Completed
- Review: Passed review
- Shows: A clean pass
- Markdown: https://patrickjv.com/projects/research-agent/runs/20261112T163326Z-468489/report.md
- Read the run: https://patrickjv.com/projects/research-agent/runs/20261112T163326Z-468489/
- Read and published by Patrick Vieira on 2026-11-12.

#### Open models on a DGX Spark

On 13 November 2026 I ran the LangGraph pipeline overnight with open models, one run per question. The Version column gives the research-agent version each run used, and results are not directly comparable across versions. These were one-off runs, and I transcribed the figures below by hand rather than from a checked export.

| Model | Version | Correct | Median minutes | Main failure |
|---|---|---|---|---|
| `gpt-oss:20b` | v1.1.0 | 3 / 10 | 6 | planted traps: contract roll (3), timezone (2) |
| `gpt-oss:120b` | v1.1.0 | 3 / 10 | 6.5 | planted traps and malformed plans |
| `qwen3:30b-a3b` | v1.1.0 | 2 / 10 | 12 | cut-offs at the token cap and planted traps |
| `gemma4:26b` | v1.1.0 | 0 / 10 | 10 | planner and critic stuck in repetition loops |
| `qwen2.5:7b` | v1.1.0 | 0 / 10 | 1 | no answer in 9 of 10 runs |
| `nemotron-3-nano:30b` | v1.1.0 | 0 / 1 (stopped) | 8 | spent the whole cap on hidden reasoning, so its replies were empty |
| `nemotron-3-super:120b` | v1.1.0 | not run | – | did not load on the Spark (timed out twice) |

Most of the local correct answers came from the Monday and Thursday drift questions. On the other eight questions, 2 of the 40 runs by the five local models that ran every question were correct. The Claude Code harness scored 0.90 on this set (research-agent v1.0.0), but with five runs per question and different models and prompts, so the two are not like-for-like.

Of the local models, gpt-oss:20b is the best option. It matched gpt-oss:120b's score with about a fifth of the memory and was the only one to finish every run.

### What it showed

Claude was strong. Through the Claude Code harness it scored 0.90 at v1.0.0. Its one miss was afternoon_vol_ratio, where all five runs computed the statistic correctly and drew the wrong conclusion.

No local model got past the traps. The best scored 0.3 at v1.1.0, mostly on the two wide-tolerance questions. Their weak link was the critic. No local critic caught the timezone trap on any open-volatility run, and the few times one raised the contract roll, it never stopped a wrong answer. gemma4:26b's analyst even reached the afternoon_vol_ratio statistic (0.9917 against a reference of 0.9915) before its own critic fell into a repetition loop and ended the run.

## Phase 2: Diagnose and improve the harness

This phase starts with the v1.3.0 work, which can give each role a different model.

### Question

Phase 1 left the local models far behind Claude, with the critic as the weak link. Is that the models, or the harness around them?

### Diagnosis

#### A hosted critic

First I kept gpt-oss:20b on the Spark as planner and analyst and made OpenAI's gpt-5.6-sol the critic, one run per question, on an early build of v1.3.0, before its review fixes. At that build the critic had no output cap and used OpenAI's default endpoint. I transcribed these figures by hand too.

| Model | Version | Correct | Median minutes | Main failure |
|---|---|---|---|---|
| `gpt-oss:20b` + `gpt-5.6-sol` critic | v1.3.0 | 4 / 10 | 4.5 | timezone trap not caught (2 runs); contract roll caught 3 of 3, fixed in 2 |

The contract roll came up in 3 runs and the critic caught it every time. The analyst fixed it in 2, return_2024 and largest_session_move, and total_return still ended wrong. The timezone trap came up in 2 runs and was never caught, even by the hosted critic. tuesday_drift had exactly the right value, but the run hit the per-pass tool-call cap before it finished.

A stronger critic helps with a trap it can see in the code or the result. It can't catch one it has no facts to check against. Part of its success on the roll comes from the shared critic checklist, which states the CME roll rule in detail. With one run per question, 4 / 10 against 3 / 10 for gpt-oss:20b alone is within noise, the two ran under different versions, and neither is like-for-like with the 0.90.

#### The two harnesses side by side

Then I read the two harnesses' code side by side at v1.2.0, before per-role routing merged, without running anything. They share the tools, the plan schema, the critic checklist and the per-pass caps. The differences are in what surrounds the model.

| Gap | Claude Code harness | LangGraph pipeline |
|---|---|---|
| 1. What the critic knows | the dataset description: timezone, session, contract switches | no dataset description, though its checklist tells it to use one |
| 2. The analyst's first step | told to read the dataset description | not told |
| 3. What the critic sees | the full result, and it can read the files | the result cut to 8,000 characters, the analyst's own summary, and no tools |
| 4. The plan | must state its session and timezone handling | not asked to |
| 5. Revisions | a fresh analyst for each revision, given only the plan and the issues | the feedback appended to the same long conversation |
| 6. Ending a run | no run token cap | a run token cap, and the run ends at the tool-call cap even when it already holds a valid answer |

So the timezone miss is a harness gap as well as a model gap. The LangGraph critic was never told the data's timezone.

### Scope of v1.4.0

v1.4.0 is planned and not built yet. It will:

- close the six gaps above, so the LangGraph pipeline gives the model what the Claude Code harness already does
- add held-out questions with fresh traps, on a different session and a different instrument, never used for tuning and reported separately

Prompt text that names a specific eval question or trap is out of scope.

If that isn't enough, v1.5.0 would have the analysis tool report facts about the data it used: the window's bounds and timezone, bar counts, and price gaps between sessions.

### Guarding against tuning to the test

The fixes have to work beyond the eval set. The model may be given facts that every dataset carries, such as its timezone, session and contract switches, but no prompt may name a trap or an eval question. A test already blocks eval answers in prompts. The held-out questions, on another instrument and session, are never used for tuning and are reported apart from the eval set's, so they test whether the fixes generalise.

### Results

To come. I'll rerun gpt-oss:20b alone and with the hosted critic at v1.4.0, then give gpt-oss:20b with the hosted critic the same five runs per question as the 0.90.

| Version | Run | Result |
|---|---|---|
| v1.4.0 | gpt-oss:20b alone, one run per question | to come |
| v1.4.0 | gpt-oss:20b with the gpt-5.6-sol critic, one run per question | to come |
| v1.4.0 | gpt-oss:20b with the gpt-5.6-sol critic, five runs per question | to come |
| v1.5.0 | only if v1.4.0 needs it | to come |

## With more time

In several places I stopped where doing more would have cost more than it was worth at this stage, and wrote down why in the specs. All but one of the steps below come from there; the overfitting checks are a new idea. Most add checks, so the system catches more of its own mistakes.

### Run the red-team probes on every push

The 22 probe scripts from the sandbox's red-team are kept in the repository, but CI doesn't run them yet. Running them on every push would make a one-off review a standing check, so a dependency or kernel change that weakened the sandbox would fail the build. So far the probe catalogue has only been run on my WSL2 machine, not yet on the CI runner.

### Finish the simpler verification plan

I designed an unattended verification runner for my own machine and dropped it after eight review rounds. Each round still found serious problems, and the cost was out of proportion to the two small checks it was for. The simpler plan runs the market-data canary on GitHub's hosted runners, away from the keys and sign-ins on my own machine, with only the Databento key as a repository secret, and makes the Claude Code behaviour probes a command I run and watch.

### Run the full LangGraph eval with hosted models

The graph is tested with fake models, and Phase 2 will run gpt-oss:20b alone and with a hosted critic. The one hosted-critic run so far ran under a token cap set for that experiment. The step that remains is the full eval through the graph with hosted models in every role, five runs per question. Unlike the Claude Code harness, which runs on a subscription, it needs a spend ceiling first. A dry run that estimates tokens and cost from the caps and the number of repeats would come with it.

### Add a canary on real market data

Real futures data stays on my machine. The vendor's licence doesn't allow showing anything derived from it without a redistribution plan, which is why everything here is synthetic. A weekly canary is specified that fetches one fixed week, checks the bar count and the contract roll, and deletes the data. It stays off until the vendor confirms in writing that processing on a hosted CI runner is allowed.

### Give the Claude Code harness a token budget and resume

The graph caps tokens and resumes from its checkpoint. The Claude Code harness does neither yet. A subscription gives it no per-call token counts it can rely on, and an interrupted run is closed rather than resumed. Closing both gaps would bring the harness level with the graph.

### Let formatting back into reports

Model-written text goes into a report as plain text, with every punctuation character escaped. That came after several rounds of trying to contain Markdown inside it by tracking its block structure, and plain text was the safer choice. Formatting could come back through a renderer with an explicit allow-list, checked against more than one Markdown parser, the way this site renders the reports it shows.

### Add overfitting checks from López de Prado

The agent already fixes its test in a plan before any analysis runs, and the critic already checks that multiple comparisons are corrected for (Bonferroni, Holm or a joint test) or at least disclosed. Unlike the other steps, this one isn't in the specs yet. It would take the same discipline to strategy-style questions, following López de Prado's Advances in Financial Machine Learning (2018). The critic's checklist would gain the deflated Sharpe ratio and the probability of backtest overfitting, and both the checklist and the analyst's guidance would call for purged and embargoed cross-validation, so overlapping labels can't leak across folds.

### Widen CI

The verification plan is sized to fit the free CI minutes. It uses one job instead of one per stage, runs on pushes only, and has a scheduled run twice a week instead of nightly. With more budget I would split the stages into jobs and run them nightly. After each Claude Code upgrade, the harness's behaviour probes would re-run on their own, and branch protection would require a green check before a merge, in place of a written procedure.

---

Canonical: https://patrickjv.com/projects/research-agent
