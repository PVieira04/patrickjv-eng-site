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

The scorecard is from research-agent v1.0.0, on 12 November 2026. The four Claude Code harness runs below were made earlier that day. The open-model runs used v1.1.0, and Phase 2 has its own results and runs.

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

No local model handled the traps reliably. The best scored 0.3 at v1.1.0, mostly on the two wide-tolerance questions. Their weak link was the critic. No local critic caught the timezone trap on any open-volatility run, and the few times one raised the contract roll, it never stopped a wrong answer. gemma4:26b's analyst even reached the afternoon_vol_ratio statistic (0.9917 against a reference of 0.9915) before its own critic fell into a repetition loop and ended the run.

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

v1.4.0 set out to:

- close the six gaps above, so the LangGraph pipeline gives the model what the Claude Code harness already does
- add held-out questions with fresh traps, on a different session and a different instrument, never used for tuning and reported separately

Prompt text that names a specific eval question or trap is out of scope.

v1.4.0 delivered both: it closed the six gaps, and the held-out set was written and is kept outside the repo. v1.5.0 added data-access gates and v1.5.1 fixed how hosted models' connections are reused between runs; neither was intended to change a score. A further step, having the analysis tool report facts about the data it used (the window's bounds and timezone, bar counts, and price gaps between sessions), has not been built.

### Guarding against tuning to the test

The fixes have to work beyond the eval set. The model may be given facts that every dataset carries, such as its timezone, session and contract switches. The critic checklist describes trap categories, including the CME roll rule, as shared domain knowledge given to both harnesses. No prompt may name a specific eval question or trap, and a test already blocks eval answers in prompts. The held-out questions, on another instrument and session, will never be used for tuning and will be reported apart from the eval set's, so they will test whether the fixes generalise.

### Results

Each row is research-agent answering the eval questions on the seeded synthetic dataset, synth-1m, with gpt-oss:20b on the DGX Spark as planner and analyst. In the local rows gpt-oss:20b is also the critic, so no hosted model was used. In the hybrid row the critic is gpt-5.6-sol through its provider's API. The five-run row gives the mean score across the repeats with its standard error. I transcribed these figures by hand from local scorecards that aren't published here.

| Version | Run | Score |
|---|---|---|
| v1.1.0 | gpt-oss:20b analyst and critic, one run per question | 3 / 10 |
| v1.4.0 | gpt-oss:20b analyst and critic, one run per question | 3 / 10 |
| v1.4.0 | gpt-oss:20b analyst with the gpt-5.6-sol critic through its provider's API: the first round of a planned five-run hybrid measurement, one run per question, not a five-run result | 3 / 10 |
| v1.5.1 | gpt-oss:20b analyst and critic, five runs per question | 0.40 (standard error 0.07) |

At v1.5.1, with five runs per question and no hosted model, gpt-oss:20b scored 0.40 (standard error 0.07): 20 of 50 answers were correct. 49 of the 50 runs completed, and one failed when a model returned output that could not be used. That is within run-to-run noise of the 3 / 10 measured at v1.1.0 and again at v1.4.0, each with one run per question, since a single run per question carries about ±0.15 of noise on its own. The drift questions held up: tuesday_drift and monday_drift were 5 / 5, and thursday_drift 4 / 5. Neither role handled the contract roll reliably. Across the five questions with a roll trap, the gpt-oss:20b critic raised the roll on 16 of the 29 passes that had fallen into it: 7 of 8 on return_2024, but 2 of 8 on total_return. Its advice was sometimes wrong-headed: in each of the 3 return_2024 runs whose final answer fell into the roll, one of its reviews told the analyst the series was already adjusted for the roll and steered it away from its own roll handling. When the flag was right, the 20b analyst often didn't act on it. total_return and return_2024 got 2 / 5 each, and largest_session_move 1 / 5. The critic mostly missed the timezone trap, raising it on 1 of the 18 passes that had fallen into it, across open_vol_uplift and open_vol_uplift_15m. The volatility questions were the weakest: open_vol_uplift got 1 / 5, and open_vol_uplift_15m, open_vol_uplift_pct_change and afternoon_vol_ratio 0 / 5 each, with one open_vol_uplift_pct_change run computing a different statistic from the one asked.

At v1.4.0 gpt-oss:20b alone, as analyst and critic, got 3 / 10 with one run per question, the same as at v1.1.0. The hybrid row is the first round of a planned five-run hybrid measurement; its later rounds failed, first on a connection bug since fixed in v1.5.1, then when the hosted API's prepaid credit ran out, so only this round is counted. In that round 1 of the 10 runs failed with model output that could not be used and 1 stopped at the tool-call cap, and it also got 3 / 10. The gpt-5.6-sol critic raised the contract roll on all 5 passes that had fallen into it, but the 20b analyst fixed it only on largest_session_move. Of its two timezone-trap runs, open_vol_uplift failed without an answer and open_vol_uplift_15m avoided the trap. With one run per question, none of these differences can be told apart from run-to-run noise.

On a small held-out set of questions written after the main set (author-known, not enforced: I wrote those questions and know their traps, and nothing in the code stops them being used for tuning), v1.5.1 scored {{HELDOUT_DIRECTION}}.

The three LangGraph agent runs below come from the five-run measurement at v1.5.1 on 16 November 2026, with gpt-oss:20b as planner, analyst and critic, all served locally.

The largest_session_move run shows the critic raising the contract roll and the analyst dropping the sessions that span a roll. The return_2024 run is an honest failure: the critic raised the roll on every pass, but one of its reviews told the analyst the series was already adjusted, and the final answer fell into the roll.

#### Recorded runs

##### On synth-1m, what was the largest single-day move? Days are CME sessions, 18:00 to 17:00 New York, dated by the day they end. Report the largest absolute session log return as the statistic `largest_session_abs_log_return`, and say whether it exceeds 2% (the hypothesis: some session moved more than 0.02 in log terms).

- Harness: LangGraph agent
- Status: Completed
- Review: Passed review
- Shows: The critic caught a planted trap
- Markdown: https://patrickjv.com/projects/research-agent/runs/20261116T123459Z-9dbf08/report.md
- Read the run: https://patrickjv.com/projects/research-agent/runs/20261116T123459Z-9dbf08/
- Read and published by Patrick Vieira on 2026-11-16.

##### On synth-1m, do Tuesday sessions drift? Take each session's log return over regular hours (09:30 to 16:00 New York) and report the mean over Tuesdays as the statistic `tuesday_mean_rth_return`. Test the hypothesis that it differs from zero at the 5% level.

- Harness: LangGraph agent
- Status: Completed
- Review: Passed review
- Shows: A clean pass
- Markdown: https://patrickjv.com/projects/research-agent/runs/20261116T103820Z-506968/report.md
- Read the run: https://patrickjv.com/projects/research-agent/runs/20261116T103820Z-506968/
- Read and published by Patrick Vieira on 2026-11-16.

##### On synth-1m, what was the cumulative log return of the instrument over the sessions of 2024? Days are CME sessions, 18:00 to 17:00 New York, dated by the day they end. Report it as the statistic `log_return_2024`, and test the hypothesis that the mean session log return in 2024 differs from zero (two-sided, 5% level).

- Harness: LangGraph agent
- Status: Completed
- Review: Did not pass review
- Markdown: https://patrickjv.com/projects/research-agent/runs/20261116T122841Z-47d5a4/report.md
- Read the run: https://patrickjv.com/projects/research-agent/runs/20261116T122841Z-47d5a4/
- Read and published by Patrick Vieira on 2026-11-16.

## Phase 3: next

Phase 3 starts with the planner and analyst model. None of it has been run yet.

### A stronger local planner and analyst

In the Phase 2 runs neither role handled the contract roll reliably: the gpt-oss:20b critic's roll flags were mixed and sometimes wrong-headed, and the 20b analyst often didn't act on a correct one. Phase 3 changes the planner and analyst model first because it is the cheapest single change to test, and holds the critic fixed so that change can be measured. That is not a finding that the critic is fine. The first step is an Ollama upgrade and a fresh baseline. The candidates, in order, are qwen3.6:35b-a3b-q4_K_M, qwen3.8:27b-q4_K_M and flint:40b, screened with one run per question and then five. nemotron-3.5-super:120b-a12b-q4_K_M is the larger option.

### Targeted revisions

When the critic flags a specific defect, such as a futures contract roll handled wrongly, the analyst would get a short pass focused on fixing that defect.

### Budget tuning

The caps on tool calls and tokens will be tuned for the new analyst, so a run has room for a fix-up pass and a stuck run still stops.

### Tracking the held-out questions

The held-out questions stay out of tuning, and I'll report them separately at each step, to see whether a change helps beyond the eval set.

---

Canonical: https://patrickjv.com/projects/research-agent
