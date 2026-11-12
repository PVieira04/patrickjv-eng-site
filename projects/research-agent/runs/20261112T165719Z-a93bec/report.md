# Research report 20261112T165719Z-a93bec

Status: rejected. Harness: claude-code. Dataset: synth-1m.

## Question

On synth\-1m\, do Monday sessions drift\? Take each session\'s log return over regular hours \(09\:30 to 16\:00 New York\) and report the mean over Mondays as the statistic \`monday\_mean\_rth\_return\`\. Test the hypothesis that it differs from zero at the 5\% level\.

## Plan

```toml
hypothesis = "On synth-1m, the mean log return over regular trading hours (09:30 to 16:00 America/New_York) on Mondays differs from zero."
dataset = "synth-1m"
start = 2023-01-02
end = 2025-12-31
method = "Load synth-1m (symbol SYN). Convert ts from UTC to America/New_York so DST is handled by the timezone conversion, not by fixed UTC offsets. For each New York calendar date with trading, take the RTH window as bars whose New York timestamp is >= 09:30 and < 16:00. The session's RTH log return is ln(close of the last bar in the window, 15:59) minus ln(open of the first bar in the window, 09:30). Require both the 09:30 and 15:59 bars to be present; drop and count sessions where either is missing. Drop and count any session whose RTH window contains a contract change (check the contract column for a change within the window, and also that the 09:30 open bar and 15:59 close bar share the same contract), so roll gaps never enter a return. Keep sessions whose New York date is a Monday (weekday 0) within start..end. monday_mean_rth_return is the arithmetic mean of these Monday RTH log returns. Report n, mean, standard deviation, standard error, t-statistic and p-value, plus the counts of dropped sessions and why."
statistic = "monday_mean_rth_return"
significance = "Two-sided one-sample t-test of the Monday RTH log returns against zero at the 5% level. The returns are non-overlapping (one per Monday), so no overlap correction is needed; as a robustness check also report a Newey-West HAC t-statistic with lag 4, and state whether the conclusion agrees."
```

Rejected: Testing Mondays against zero confounds a Monday effect with the instrument\'s overall drift \(run B found a significant positive mean session return\)\. Compare Monday RTH returns with the other weekdays\' instead\.

## Method

None given.

## Code

No analysis code ran.

## Results

The owner rejected the plan before any analysis ran\.

No valid answer.

## Critic findings

Review: not_reviewed after 0 critic call(s).

## Caveats

None recorded.
