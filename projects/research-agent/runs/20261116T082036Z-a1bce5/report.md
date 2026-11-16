# Research report 20261116T082036Z-a1bce5

Status: completed. Harness: langgraph. Dataset: synth-1m.

## Question

On synth\-1m\, do Thursday sessions drift\? Take each session\'s log return over regular hours \(09\:30 to 16\:00 New York\) and report the mean over Thursdays as the statistic \`thursday\_mean\_rth\_return\`\. Test the hypothesis that it differs from zero at the 5\% level\.

## Plan

```toml
hypothesis = "H₀ : thursday_mean_rth_return = 0  (no Thursday‑session drift)  \nH₁ : thursday_mean_rth_return ≠ 0"
dataset = "synth-1m"
start = 2023-01-04
end = 2025-12-23
method = "\n1. **Time‑zone handling** – The raw timestamps (`ts`) are UTC (`datetime64[ns, UTC]`).  Convert each timestamp to the local New York calendar using `pytz`/`pandas.tz_convert('America/New_York')`.  All subsequent filtering is performed on these converted times.\n2. **Session definition** – We analyse *regular trading hours* (RTH) only:\n   - **Daily start‑time**: 09:30 AM New York\n   - **Daily end‑time**: 16:00 PM New York\n   – Bars whose local times fall outside 09:30 ≤ t < 16:00 are discarded for that session.\n3. **Session identification** – From the converted timestamps, extract the calendar date (YYYY‑MM‑DD) and day‑of‑week. Keep only those rows where the day is Thursday (`weekday()==3`).\n4. **Return calculation per Thursday** – For each retained Thursday:\n   - Find the *opening* price: the `open` field of the first bar whose local start time ≥ 09:30.\n   - Find the *closing* price: the `close` field of the last bar whose local start time < 16:00 (i.e., the bar that ends at 16:00).\n   - Compute the log return: `ln(close / open)`.\n5. **Contract‑roll handling** – The provided DataFrame is a continuous front‑month series with pre‑calculated roll adjustments (`contract_switches`). Thus each daily close belongs to the appropriate contract already; no further roll adjustment is required.\n6. **Aggregation** – Collect all per‑Thursday log returns into an array `R`.  Compute the statistic\n   \n   `thursday_mean_rth_return = mean(R)`.\n7. **Statistical test for drift** – Use a two‑sided one‑sample t‑test (justified by ≥ 150 samples, CLT applies):\n   - Estimate standard error `SE = std(R) / sqrt(N)` with `N=len(R)`.\n   - Compute t‑statistic `t = thursday_mean_rth_return / SE`.\n   - Obtain a two‑tailed p‑value from the Student’s t distribution with `df=N-1`.\n   - **Decision rule**: reject H₀ if `p ≤ 0.05`; otherwise fail to reject.\n\nStatistic reported: `thursday_mean_rth_return`. Significance judged by the two‑tailed p‑value at the 5 % level."
statistic = "thursday_mean_rth_return"
significance = "Reject H₀ (drift present) if p-value ≤ 0.05; otherwise fail to reject."
```

## Method


1\. \*\*Time‑zone handling\*\* – The raw timestamps \(\`ts\`\) are UTC \(\`datetime64\[ns\, UTC\]\`\)\.  Convert each timestamp to the local New York calendar using \`pytz\`\/\`pandas\.tz\_convert\(\'America\/New\_York\'\)\`\.  All subsequent filtering is performed on these converted times\.
2\. \*\*Session definition\*\* – We analyse \*regular trading hours\* \(RTH\) only\:
\- \*\*Daily start‑time\*\*\: 09\:30 AM New York
\- \*\*Daily end‑time\*\*\: 16\:00 PM New York
– Bars whose local times fall outside 09\:30 ≤ t \< 16\:00 are discarded for that session\.
3\. \*\*Session identification\*\* – From the converted timestamps\, extract the calendar date \(YYYY‑MM‑DD\) and day‑of‑week\. Keep only those rows where the day is Thursday \(\`weekday\(\)\=\=3\`\)\.
4\. \*\*Return calculation per Thursday\*\* – For each retained Thursday\:
\- Find the \*opening\* price\: the \`open\` field of the first bar whose local start time ≥ 09\:30\.
\- Find the \*closing\* price\: the \`close\` field of the last bar whose local start time \< 16\:00 \(i\.e\.\, the bar that ends at 16\:00\)\.
\- Compute the log return\: \`ln\(close \/ open\)\`\.
5\. \*\*Contract‑roll handling\*\* – The provided DataFrame is a continuous front‑month series with pre‑calculated roll adjustments \(\`contract\_switches\`\)\. Thus each daily close belongs to the appropriate contract already\; no further roll adjustment is required\.
6\. \*\*Aggregation\*\* – Collect all per‑Thursday log returns into an array \`R\`\.  Compute the statistic

\`thursday\_mean\_rth\_return \= mean\(R\)\`\.
7\. \*\*Statistical test for drift\*\* – Use a two‑sided one‑sample t‑test \(justified by ≥ 150 samples\, CLT applies\)\:
\- Estimate standard error \`SE \= std\(R\) \/ sqrt\(N\)\` with \`N\=len\(R\)\`\.
\- Compute t‑statistic \`t \= thursday\_mean\_rth\_return \/ SE\`\.
\- Obtain a two‑tailed p‑value from the Student’s t distribution with \`df\=N\-1\`\.
\- \*\*Decision rule\*\*\: reject H₀ if \`p ≤ 0\.05\`\; otherwise fail to reject\.

Statistic reported\: \`thursday\_mean\_rth\_return\`\. Significance judged by the two‑tailed p‑value at the 5 \% level\.

## Code

Final script: call 6, pass 2.

```python
import pandas as pd
import numpy as np
from datetime import time, timedelta
import research_io
import scipy.stats as st
# Load data
df = research_io.load('synth-1m')
# Convert ts to UTC aware if not already
if df['ts'].dtype.tz is None:
    df['ts'] = df['ts'].dt.tz_localize('UTC')
# Create NY local timestamp column for filtering and session extraction
df['ts_ny'] = df['ts'].dt.tz_convert('America/New_York')

# Define analysis window inclusive in NY time zone
start_date_ny = pd.Timestamp('2023-01-04', tz='America/New_York')
end_date_ny   = pd.Timestamp('2025-12-23', tz='America/New_York') + timedelta(days=1) - timedelta(seconds=1)
mask_window = (df['ts_ny'] >= start_date_ny) & (df['ts_ny'] <= end_date_ny)
df = df.loc[mask_window]

# Regular Trading Hours 09:30-16:00 NY inclusive of seconds < 16:00
def in_rth(ts):
    t = ts.time()
    return (t >= time(9,30)) and (t <= time(15,59,59))
mask_rth = df['ts_ny'].apply(in_rth)
df = df.loc[mask_rth]

# Keep only Thursdays  -> weekday == 3 (Monday=0)
df['date'] = df['ts_ny'].dt.date
# pandas deprecated dayofweek in newer version; use day_of_week
if hasattr(df['ts_ny'], 'day_of_week'):
    df['weekday'] = df['ts_ny'].dt.day_of_week
else:
    df['weekday'] = df['ts_ny'].dt.weekday
th_df = df[df['weekday']==3]

# List of contract switches (timestamp UTC)
cs_times_utc=[
    '2023-03-09T14:30:00Z',
    '2023-06-08T13:30:00Z',
    '2023-09-07T13:30:00Z',
    '2023-12-07T14:30:00Z',
    '2024-03-07T14:30:00Z',
    '2024-06-13T13:30:00Z',
    '2024-09-12T13:30:00Z',
    '2024-12-12T14:30:00Z',
    '2025-03-13T13:30:00Z',
    '2025-06-12T13:30:00Z',
    '2025-09-11T13:30:00Z',
    '2025-12-11T14:30:00Z'
]
cs = []
for t in cs_times_utc:
    ts_utc = pd.to_datetime(t, utc=True)
    cs.append({'ts_utc': ts_utc})
# Convert to NY local for comparison
for entry in cs:
    entry['ts_ny'] = entry['ts_utc'].tz_convert('America/New_York')

# Identify Thursdays that contain a roll switch during RTH (09:30-16:00) and exclude them.
excluded_dates=set()
unique_th_date=th_df['date'].unique()
for d in unique_th_date:
    # Define RTH period for that date
    rth_start = pd.Timestamp(d, tz='America/New_York').replace(hour=9, minute=30)
    rth_end   = pd.Timestamp(d, tz='America/New_York').replace(hour=15, minute=59, second=59)
    # Check any switch within this period
    for entry in cs:
        ts_ny=entry['ts_ny']
        if ts_ny.date()==d and rth_start <= ts_ny <= rth_end:
            excluded_dates.add(d)
            break
# Remove those dates from th_df
if excluded_dates:
    th_df = th_df[~th_df['date'].isin(excluded_dates)]

# Compute per-Thursday log return: first open in RTH, last close before 16:00
returns=[]
for date, g in th_df.groupby('date'):
    g_sorted=g.sort_values('ts_ny', ascending=True)
    open_price = g_sorted.iloc[0]['open']   # first bar of the day
    close_price= g_sorted.iloc[-1]['close'] # last bar within RTH
    ret=np.log(close_price / open_price)
    returns.append(ret)
returns_arr=np.array(returns, dtype=float)
N=len(returns_arr)
mean_ret=returns_arr.mean() if N>0 else np.nan
std_ret=returns_arr.std(ddof=1) if N>1 else np.nan

# HAC Newey-West estimator of standard error (L=max 5 or floor(N^(2/9)))
if N>0:
    L=min(5, int(np.floor(N**(2/9))))
    d=returns_arr-mean_ret
    gamma=[np.dot(d,d)/N]
    for lag in range(1,L+1):
        cov=np.dot(d[lag:],d[:-lag])/N
        gamma.append(cov)
    weight = np.array([1] + [1 - l/(L+1) for l in range(1, L+1)])
    se_hac=np.sqrt((gamma[0]+2*np.sum(weight[1:]*np.array(gamma[1:]))) / N)
else:
    se_hac=np.nan
# HAC t-statistic and p-value
if N>1 and not np.isnan(se_hac):
    t_stat=mean_ret/se_hac
    p_val=2*(1-st.norm.cdf(abs(t_stat)))
else:
    t_stat,p_val=np.nan,np.nan
# 95% CI using HAC SE
if N>0 and not np.isnan(se_hac):
    ci_low=mean_ret-1.96*se_hac
    ci_high=mean_ret+1.96*se_hac
else:
    ci_low,ci_high=np.nan,np.nan

# Conclusion
conclusion='supported' if (p_val is not None and p_val<=0.05) else 'not_supported'
# Prepare answer
answer_dict={
    "statistic":"thursday_mean_rth_return",
    "value":float(mean_ret),
    "n":int(N),
    "conclusion":conclusion,
    "ci":{"level":0.95,"low":float(ci_low) if not np.isnan(ci_low) else None,"high":float(ci_high) if not np.isnan(ci_high) else None}
}
# Result payload
result={
    "mean_return": mean_ret,
    "std_dev": std_ret,
    "N": N,
    "t_stat_hac": t_stat,
    "p_value_hac": p_val,
    "excl_dates_count": len(excluded_dates),
    "excluded_dates": [str(d) for d in sorted(list(excluded_dates))]  # all
}
research_io.save_result(result, answer=answer_dict)
```

## Results

The corrected analysis\:

\* All Thursdays were first filtered for the 09\:30‑16\:00 NY RTH window\.
\* Any Thursday whose contractual roll switch occurred during that window – 12 dates in all – was excluded to avoid artificial jumps\.
\* Log returns per remaining Thursday were computed as ln\(close \/ open\) from the first and last bars of the day\.
\* Because weekly RTH returns can be serially correlated\, a Newey‑West HAC standard error \(lag \= min\(5\, ⌊N\^\(2\/9\)⌋\)\=3 for N\=143\) was used\.  
The t‑statistic is –0\.40 and the two‑tailed p‑value ≈ 0\.69\.
\* The 95\% CI from the HAC SE is \(‑0\.00046095\, 0\.00030455\)\.

- thursday_mean_rth_return = -7.820169565942006e-05 (n = 143)
- 95% interval: [-0.00046095329729934427, 0.00030454990598050415]
- conclusion: not_supported

## Critic findings

Review: passed after 2 critic call(s).
- Pass 1: revise
  - overlap_autocorrelation: Daily returns on Thursdays are drawn from a time‑series that is likely serially correlated \(e\.g\.\, weekly momentum or autocorrelation\)\. The code performs a standard two‑sample t‑test assuming independent observations\, which underestimates the sampling variance if residuals are autocorrelated\. A HAC\/Newey–West adjustment or block bootstrap should replace the plain SE to obtain valid p‑values\.
  - contract_roll: The synthetic series contains scheduled contract switches \(e\.g\.\, 2023‑03‑09T14\:30Z\)\. The code treats each Thursday’s open and close as belonging to a single continuous contract without explicitly confirming that no roll occurs inside the RTH window\. If a roll happens during that window\, the log return would include an artificial jump\. Though the dataset claims pre‑calculated adjustments\, verifying against contract\_switches is required to protect against mis‑estimated drift\.
- Pass 2: pass

## Caveats

None recorded.
