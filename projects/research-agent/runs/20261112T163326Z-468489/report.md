# Research report 20261112T163326Z-468489

Status: completed. Harness: claude-code. Dataset: synth-1m.

## Question

On synth\-1m\, is realised 1\-minute volatility higher in the first 30 minutes after the 09\:30 New York cash open than in the rest of the same session\? Report the mean over sessions of the ratio of realised volatility in that window to realised volatility in the rest of the session as the statistic \`open\_vol\_ratio\`\, and test the hypothesis that the window is more volatile at the 5\% level\.

## Plan

```toml
hypothesis = "On synth-1m, realised 1-minute volatility in the 09:30-10:00 New York window is higher than realised 1-minute volatility in the rest of the same session, i.e. the mean over sessions of the per-minute volatility ratio exceeds 1."
dataset = "synth-1m"
start = 2023-01-02
end = 2025-12-31
method = "1. Load synth-1m (single symbol SYN), convert ts from UTC to America/New_York so the 09:30 open tracks DST. 2. Assign each bar to a session using the dataset's 18:00-17:00 NY session: session date = NY calendar date of (ts_ny + 6 hours), so bars from 18:00 belong to the next day's session. 3. Compute 1-minute log returns r_t = ln(close_t / close_{t-1}) within a session only: drop the first bar of every session (its return spans the 17:00-18:00 break) and drop any return whose bar is at or straddles a contract switch timestamp (all 12 switches fall exactly at 09:30 NY, so the switch-day 09:30 return would otherwise mix two contracts). 4. Window = bars with NY time in [09:30, 10:00) (30 returns, the first being 09:29 close to 09:30 close); rest = every other return in the same session (18:00 previous evening to 16:59, excluding the window). 5. Per session, realised volatility is normalised per minute so the two windows of very different length are comparable: RV_window = sqrt(mean of r^2 over window), RV_rest = sqrt(mean of r^2 over rest). 6. Keep sessions with a full 30-return window (29 on switch days after the drop) and at least 90% of the expected rest returns; report how many sessions are kept and dropped. 7. ratio_s = RV_window / RV_rest per session; open_vol_ratio = mean of ratio_s over kept sessions. Also report the median ratio, the share of sessions with ratio > 1, and mean of ln(ratio_s) as robustness."
statistic = "open_vol_ratio"
significance = "One-sided test of H0: E[ratio_s] <= 1 against H1: E[ratio_s] > 1, using a t-test on the per-session ratios with Newey-West HAC standard errors (lag 5 sessions, to allow for volatility clustering across days), at the 5% level. Robustness: the same one-sided HAC test on ln(ratio_s) > 0."
```

## Method

\- Converted bar timestamps from UTC to America\/New\_York so the 09\:30 open follows DST\.
\- Assigned bars to the dataset\'s 18\:00\-17\:00 NY session\. The session date is the NY date of ts \+ 6h\.
\- Computed 1\-minute close\-to\-close log returns within each session only\. Dropped the first return of each session\, which spans the 17\:00\-18\:00 break\.
\- Dropped the return at each of the 12 contract switches\. All 12 fall exactly at 09\:30 NY\, so keeping them would have counted roll jumps as opening volatility\.
\- Window \= returns at NY 09\:30\-09\:59 \(30 returns\)\. Rest \= all other returns in the same session\, including the overnight hours\.
\- Per\-minute realised volatility for each part\: sqrt\(mean r\^2\)\. Per\-session ratio \= RV\_window \/ RV\_rest\.
\- open\_vol\_ratio \= mean of the ratio over sessions\.
\- Significance\: a one\-sided t\-test of mean ratio \> 1\, with Newey\-West HAC standard errors at lag 5 sessions\, at the 5\% level\. Robustness check\: the same test on ln\(ratio\) \> 0\.
\- One analysis call\. An independent critic reviewed it and passed it with no issues\.

## Code

Final script: call 1, pass 1.

```python

import numpy as np, pandas as pd, research_io
from scipy import stats
df = research_io.load("synth-1m")
df = df[df.symbol=="SYN"].sort_values("ts").reset_index(drop=True)
ny = df.ts.dt.tz_convert("America/New_York")
df["ny"]=ny
df["sess"]=(ny+pd.Timedelta(hours=6)).dt.date
df["r"]=np.log(df.close/df.close.shift(1))
df["prev_ts"]=df.ts.shift(1)
df["first"]=df.sess!=df.sess.shift(1)
sw = pd.to_datetime(["2023-03-09T14:30:00Z","2023-06-08T13:30:00Z","2023-09-07T13:30:00Z","2023-12-07T14:30:00Z","2024-03-07T14:30:00Z","2024-06-13T13:30:00Z","2024-09-12T13:30:00Z","2024-12-12T14:30:00Z","2025-03-13T13:30:00Z","2025-06-12T13:30:00Z","2025-09-11T13:30:00Z","2025-12-11T14:30:00Z"],utc=True)
straddle = df.ts.isin(sw) | (df.contract!=df.contract.shift(1))
gap = (df.ts-df.prev_ts)!=pd.Timedelta(minutes=1)
bad = df.first | straddle | gap | df.r.isna()
d = df[~bad].copy()
tm = d.ny.dt.hour*60+d.ny.dt.minute
d["win"]=(tm>=570)&(tm<600)
d["r2"]=d.r**2
g=d.groupby("sess")
agg=pd.DataFrame({
 "nw":g.apply(lambda x:x.win.sum()),
 "nr":g.apply(lambda x:(~x.win).sum()),
 "mw":g.apply(lambda x:x.r2[x.win].mean()),
 "mr":g.apply(lambda x:x.r2[~x.win].mean())})
swdays = set(sw.tz_convert("America/New_York").date)
agg["need_w"]=[29 if s in swdays else 30 for s in agg.index]
all_sess = df.sess.nunique()
agg=agg[(agg.index>=pd.Timestamp("2023-01-02").date())&(agg.index<=pd.Timestamp("2025-12-31").date())]
exp_rest=1349
keep=(agg.nw>=agg.need_w)&(agg.nr>=0.9*(exp_rest-agg.index.isin(swdays)*0))
k=agg[keep].copy()
k["ratio"]=np.sqrt(k.mw/k.mr)
k=k.replace([np.inf,-np.inf],np.nan).dropna(subset=["ratio"])
def hac(x,mu0,L=5):
    x=np.asarray(x);n=len(x);e=x-x.mean()
    s=e@e/n
    for l in range(1,L+1):
        s+=2*(1-l/(L+1))*(e[l:]@e[:-l])/n
    se=np.sqrt(s/n);t=(x.mean()-mu0)/se
    return x.mean(),se,t,stats.t.sf(t,n-1)
m,se,t,p=hac(k.ratio,1)
lm,lse,lt,lp=hac(np.log(k.ratio),0)
n=len(k)
res=dict(open_vol_ratio=m,se=se,t=t,p_one_sided=p,median=k.ratio.median(),share_gt1=(k.ratio>1).mean(),
 mean_log=lm,log_se=lse,log_t=lt,log_p=lp,n_kept=n,n_sessions_total=len(agg),n_dropped=len(agg)-n,
 ci_low_95_twosided=m-stats.t.ppf(.975,n-1)*se,ci_high_95_twosided=m+stats.t.ppf(.975,n-1)*se,
 nr_min=int(agg.nr.min()),nr_median=float(agg.nr.median()))
print(res)
concl="supported" if (p<0.05 and m>1) else "not_supported"
research_io.save_result(res,answer=dict(statistic="open_vol_ratio",value=float(m),n=int(n),conclusion=concl,
 ci=dict(level=0.95,low=float(m-stats.t.ppf(.975,n-1)*se),high=float(m+stats.t.ppf(.975,n-1)*se))))
```

## Results

Yes\. On synth\-1m\, realised 1\-minute volatility in the first 30 minutes after the 09\:30 New York open was about twice that of the rest of the same session\. The mean per\-session ratio open\_vol\_ratio is 1\.997 \(95\% CI 1\.981 to 2\.013\, n \= 783 sessions\)\. The one\-sided Newey\-West test rejects H0\: ratio \<\= 1 at the 5\% level \(t about 122\, p \< 0\.001\)\. Every session had a ratio above 1\.

- open_vol_ratio = 1.997180684289427 (n = 783)
- 95% interval: [1.9811416053818653, 2.0132197631969886]
- conclusion: supported

\| Measure \| Value \|
\|\-\-\-\|\-\-\-\|
\| open\_vol\_ratio \(mean ratio\) \| \*\*1\.997\*\* \|
\| 95\% CI \(HAC\, t on n\-1 df\) \| 1\.981 to 2\.013 \|
\| Sessions kept \/ dropped \| 783 \/ 0 \|
\| Median ratio \| 1\.985 \|
\| Share of sessions with ratio \> 1 \| 100\% \|
\| HAC t\-stat \(H0\: mean ratio \<\= 1\) \| about 122\, one\-sided p \< 0\.001 \|
\| Mean ln\(ratio\) \| 0\.683 \(t about 164\, p \< 0\.001\) \|

Per minute\, the opening half\-hour is about twice as volatile as the rest of the session\. The effect is large\, very stable\, and present in every session\. The hypothesis is supported at the 5\% level\.

## Critic findings

Review: passed after 1 critic call(s).
- Pass 1: pass

## Caveats

- The data is synthetic\, generated with seed 20261111\. The result describes how the generator models the open\, not a real market\.
- \'Rest of the session\' means the full 18\:00\-17\:00 session\, including the quiet overnight hours\. Comparing with the rest of the cash session only \(10\:00\-16\:00\) would probably give a smaller ratio\.
- The 12 contract\-roll returns at 09\:30 were excluded\, so on roll days the window has 29 returns instead of 30\.
- A 100\% share of sessions above 1 and a t\-stat over 100 are far more uniform than real markets usually are\. This probably reflects a deterministic intraday volatility pattern in the generator\.
