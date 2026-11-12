# Research report 20261112T165438Z-76a84d

Status: completed. Harness: claude-code. Dataset: synth-1m.

## Question

On synth\-1m\, what is the total log return of the instrument over the whole sample\? Report it as the statistic \`total\_log\_return\`\, and test the hypothesis that the mean session log return differs from zero \(two\-sided\, 5\% level\)\.

## Plan

```toml
hypothesis = "The mean session log return of the roll-adjusted SYN front-month future on synth-1m differs from zero."
dataset = "synth-1m"
start = 2023-01-02
end = 2025-12-31
method = "Load synth-1m (symbol SYN). Convert ts from UTC to America/New_York and assign each bar to a trading session: the session runs 18:00 to 17:00 New York time, and a bar at or after 18:00 belongs to the next calendar day's session date. Keep sessions dated 2023-01-02 to 2025-12-31. Sort by ts and compute 1-minute log returns ln(close_t / close_{t-1}) only between consecutive bars of the same contract; the return across each of the 12 contract switches (a roll, not a price move) is dropped, so the series is roll-adjusted. Also drop the return across each session break (17:00 to 18:00) only if the two bars belong to different contracts; otherwise keep it in the session it lands in, so returns sum to the whole-sample move. Session log return = sum of the bar log returns assigned to that session. total_log_return = sum of all session log returns over the sample (equivalently the sum of within-contract bar log returns). Report total_log_return, the number of sessions, the mean and standard deviation of session log returns, and the unadjusted ln(last close / first close) for comparison, which includes the roll gaps."
statistic = "total_log_return"
significance = "Two-sided test of mean session log return = 0 at the 5% level: Newey-West HAC t-test on the session log returns with lag 5 (sessions do not overlap; the lag guards against mild serial correlation), with the plain one-sample t-test reported alongside."
```

## Method

\- Loaded synth\-1m \(symbol SYN\, 1\-minute bars of a continuous front\-month future\)\.
\- Converted timestamps from UTC to America\/New\_York\. Assigned each bar to an 18\:00–17\:00 session\: a bar at or after 18\:00 belongs to the next calendar day\'s session\.
\- Computed 1\-minute log returns ln\(close\_t \/ close\_\{t\-1\}\) only between consecutive bars of the same contract\. Dropped the 12 returns that cross a contract switch \(rolls\, not price moves\)\, which gives a roll\-adjusted series\.
\- Session log return \= the sum of the bar returns in that session\. \`total\_log\_return\` \= the sum over all sessions\.
\- Tested mean session log return \= 0\, two\-sided at 5\%\, with a Newey\-West HAC t\-test \(lag 5\)\, and reported the plain one\-sample t\-test alongside\.
\- One analysis pass\. The independent critic passed it with no open issues\.

## Code

Final script: call 1, pass 1.

```python

import numpy as np, pandas as pd, research_io
from scipy import stats
df = research_io.load("synth-1m")
df = df[df.symbol=="SYN"].sort_values("ts").reset_index(drop=True)
ny = df.ts.dt.tz_convert("America/New_York")
sd = ny.dt.normalize().dt.tz_localize(None)
sd = sd.where(ny.dt.hour<18, sd+pd.Timedelta(days=1))
df["sess"]=sd
keep = (df.sess>=pd.Timestamp("2023-01-02"))&(df.sess<=pd.Timestamp("2025-12-31"))
df = df[keep].reset_index(drop=True)
r = np.log(df.close/df.close.shift(1))
same = df.contract==df.contract.shift(1)
valid = same & r.notna()
dropped = int((~same & r.notna()).sum())
s = r[valid].groupby(df.sess[valid]).sum()
n=len(s); x=s.values; m=x.mean(); sdv=x.std(ddof=1)
total=x.sum()
# Newey-West lag 5 on mean
L=5; e=x-m
g0=(e*e).sum()/n
lrv=g0
for l in range(1,L+1):
    w=1-l/(L+1)
    lrv+=2*w*(e[l:]*e[:-l]).sum()/n
se_nw=np.sqrt(lrv/n); t_nw=m/se_nw; p_nw=2*(1-stats.t.cdf(abs(t_nw),n-1))
t,p=stats.ttest_1samp(x,0)
unadj=float(np.log(df.close.iloc[-1]/df.close.iloc[0]))
res=dict(total_log_return=float(total),n_sessions=n,mean=float(m),sd=float(sdv),unadjusted=unadj,
 dropped_returns=dropped,se_nw=float(se_nw),t_nw=float(t_nw),p_nw=float(p_nw),t_plain=float(t),p_plain=float(p))
print(res)
concl="supported" if p_nw<0.05 else "not_supported"
ci=dict(level=0.95,low=float(total-1.96*se_nw*n),high=float(total+1.96*se_nw*n))
research_io.save_result(res,answer=dict(statistic="total_log_return",value=float(total),n=n,conclusion=concl,ci=ci))
```

## Results

Over the whole sample \(783 sessions\, 2023\-01\-02 to 2025\-12\-31\)\, the roll\-adjusted total log return of SYN on synth\-1m is 0\.5658\. The mean session log return is 0\.000723\, and it differs from zero at the 5\% level\: Newey\-West HAC t \= 5\.20 \(p ≈ 2\.6e\-7\)\, plain t \= 4\.93 \(p ≈ 1\.0e\-6\)\. The hypothesis is supported\. Without the roll adjustment\, ln\(last\/first close\) is 0\.8073\; the 12 contract\-roll gaps account for the difference of about 0\.24\.

- total_log_return = 0.5658025231146101 (n = 783)
- 95% interval: [0.3524232071175124, 0.7791818391117078]
- conclusion: supported

\| Quantity \| Value \|
\|\-\-\-\|\-\-\-\|
\| \`total\_log\_return\` \(roll\-adjusted\) \| \*\*0\.5658\*\* \|
\| 95\% interval for the total \(HAC SE\, normal\) \| 0\.352 to 0\.779 \|
\| Sessions \| 783 \|
\| Mean session log return \| 0\.000723 \|
\| SD of session log return \| 0\.00410 \|
\| HAC t \(lag 5\) \/ p \| 5\.20 \/ ≈2\.6e\-7 \|
\| Plain t \/ p \| 4\.93 \/ ≈1\.0e\-6 \|
\| Unadjusted ln\(last close \/ first close\) \| 0\.8073 \|
\| Returns dropped at contract switches \| 12 \|

The instrument\'s own price move over the sample is about \+0\.566 in log terms\, roughly \+76\% compounded\. The mean session return is clearly positive\: both tests reject zero at far below the 5\% level\. The naive first\-to\-last close figure \(0\.807\) overstates the return\, because it counts the price jumps at the 12 contract rolls as gains\.

## Critic findings

Review: passed after 1 critic call(s).
- Pass 1: pass

## Caveats

- The data is synthetic \(generator seed 20261111\)\, so the result describes the generator\, not a real market\.
- The headline figure depends on the roll treatment\. Dropping the roll\-crossing returns is one standard convention\; a ratio back\-adjustment would give the same total log return\, but a difference back\-adjustment would not\.
- The 95\% interval for the total scales the Newey\-West standard error of the mean by the number of sessions and uses a normal 1\.96 multiplier\; it is an approximation\.
- The HAC lag of 5 was chosen in advance and not tuned\. The plain t\-test agrees\, so the conclusion does not hinge on it\.
