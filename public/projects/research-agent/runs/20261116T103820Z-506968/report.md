# Research report 20261116T103820Z-506968

Status: completed. Harness: langgraph. Dataset: synth-1m.

## Question

On synth\-1m\, do Tuesday sessions drift\? Take each session\'s log return over regular hours \(09\:30 to 16\:00 New York\) and report the mean over Tuesdays as the statistic \`tuesday\_mean\_rth\_return\`\. Test the hypothesis that it differs from zero at the 5\% level\.

## Plan

```toml
hypothesis = "tuesday_mean_rth_return ≠ 0"
dataset = "synth-1m"
start = 2023-01-02
end = 2025-12-24
method = "The dataset contains minute‑bar data (`ts` is UTC).  For the analysis we\n1. Convert `ts` to America/New York (Eastern) time with `tz_convert('America/New_York')`. \n2. Define a trading day’s *regular hours* window as 09:30–16:00 Eastern, inclusive of the first bar at 09:30 and the last bar at 15:59.  Bars outside that window are dropped – they do not participate in the session return calculation.\n3. Identify every calendar Tuesday between the start date (2023‑01‑02) and the end date (2025‑12‑24).  For each Tuesday we:\n   * Select all bars whose converted timestamps fall inside the 09:30–16:00 window for that particular day.\n   * Compute the log return of the session as `ln(close_last / close_first)` where `close_first` is the closing price of the first bar in the window and `close_last` is the closing price of the final bar in the window.\n4. Compile a vector `r_tuesday` of all such daily returns – one element per Tuesday that has complete data for its regular‑hour session.\n5. Compute the sample mean \\\\(\bar r = \\frac{1}{N} \\sum_{i=1}^{N} r_i\\\\) and sample standard deviation `s`.  The statistic to report is `tuesday_mean_rth_return = \\bar r`.\n6. Test the null hypothesis that the true mean log return for Tuesdays over regular hours equals zero.  Because each Tuesday’s session return comes from a non‑overlapping period, we treat them as independent draws and run a one‑sample *student’s* t‑test:\n   \\\\[ \\text{t} = \\frac{\\bar r - 0}{s/\\sqrt{N}}\\\\]\n   The degrees of freedom are `df = N-1`.  A two–tailed test is performed at the 5 % significance level.  Equivalently, we construct a 95 % confidence interval \\\\(\bar r \\pm 1.96\\frac{s}{\\sqrt N}\\) and reject the null iff zero lies outside this interval.\n7. Report `tuesday_mean_rth_return`, its standard error, the 95 % CI, the t‑statistic, the p–value, and the decision about the hypothesis."
statistic = "tuesday_mean_rth_return"
significance = "Reject H₀ if the two‑tailed 5 % p‑value < 0.05 (or zero not in the 95 % confidence interval)."
```

## Method

The dataset contains minute‑bar data \(\`ts\` is UTC\)\.  For the analysis we
1\. Convert \`ts\` to America\/New York \(Eastern\) time with \`tz\_convert\(\'America\/New\_York\'\)\`\. 
2\. Define a trading day’s \*regular hours\* window as 09\:30–16\:00 Eastern\, inclusive of the first bar at 09\:30 and the last bar at 15\:59\.  Bars outside that window are dropped – they do not participate in the session return calculation\.
3\. Identify every calendar Tuesday between the start date \(2023‑01‑02\) and the end date \(2025‑12‑24\)\.  For each Tuesday we\:
\* Select all bars whose converted timestamps fall inside the 09\:30–16\:00 window for that particular day\.
\* Compute the log return of the session as \`ln\(close\_last \/ close\_first\)\` where \`close\_first\` is the closing price of the first bar in the window and \`close\_last\` is the closing price of the final bar in the window\.
4\. Compile a vector \`r\_tuesday\` of all such daily returns – one element per Tuesday that has complete data for its regular‑hour session\.
5\. Compute the sample mean \\\\\(ar r \= \\frac\{1\}\{N\} \\sum\_\{i\=1\}\^\{N\} r\_i\\\\\) and sample standard deviation \`s\`\.  The statistic to report is \`tuesday\_mean\_rth\_return \= \\bar r\`\.
6\. Test the null hypothesis that the true mean log return for Tuesdays over regular hours equals zero\.  Because each Tuesday’s session return comes from a non‑overlapping period\, we treat them as independent draws and run a one‑sample \*student’s\* t‑test\:
\\\\\[ \\text\{t\} \= \\frac\{\\bar r \- 0\}\{s\/\\sqrt\{N\}\}\\\\\]
The degrees of freedom are \`df \= N\-1\`\.  A two–tailed test is performed at the 5 \% significance level\.  Equivalently\, we construct a 95 \% confidence interval \\\\\(ar r \\pm 1\.96\\frac\{s\}\{\\sqrt N\}\\\) and reject the null iff zero lies outside this interval\.
7\. Report \`tuesday\_mean\_rth\_return\`\, its standard error\, the 95 \% CI\, the t‑statistic\, the p–value\, and the decision about the hypothesis\.

## Code

Final script: call 2, pass 1.

```python
import pandas as pd, numpy as np
from research_io import load, save_result, save_figure
# Load dataset
df = load('synth-1m')
print('Loaded rows', len(df))
# Convert ts to NY time
ny = 'America/New_York'
df['ts_ny'] = df['ts'].dt.tz_convert(ny)
# Define date range
start_date = pd.Timestamp('2023-01-02', tz=ny)  # start inclusive
end_date = pd.Timestamp('2025-12-24', tz=ny)
# Filter between dates
df_day = df[(df['ts_ny'].dt.date >= start_date.date()) & (df['ts_ny'].dt.date <= end_date.date())]
print('Filtered date range rows', len(df_day))
# Get Tuesdays list
all_dates = pd.date_range(start=start_date, end=end_date, freq='D')
tuesday_dates = all_dates[all_dates.weekday == 1]  # Monday=0
print('Number of Tuesday dates', len(tuesday_dates))
# Function to compute return for a day
session_returns = []
valid_tuesdays = []
for d in tuesday_dates:
    day_mask = (df_day['ts_ny'].dt.date == d.date())
    # session window 09:30-16:00 inclusive of first bar 09:30, last bar at 15:59
    time_mask = ((df_day['ts_ny'].dt.time >= pd.to_datetime('09:30').time()) & (df_day['ts_ny'].dt.time <= pd.to_datetime('15:59').time()))
    day_session = df_day[day_mask & time_mask]
    if len(day_session) < 1:
        continue
    close_first = day_session.iloc[0]['close']
    close_last = day_session.iloc[-1]['close']
    ret = np.log(close_last / close_first)
    session_returns.append(ret)
    valid_tuesdays.append(d.date())
print('Valid Tuesdays with data', len(session_returns))
# Compute statistics
r_array = np.array(session_returns)
N = r_array.size
mean_ret = r_array.mean()
sd_ret = r_array.std(ddof=1)
se = sd_ret/np.sqrt(N)
t_stat = mean_ret / se
from scipy.stats import t, norm
p_val = 2 * t.sf(abs(t_stat), N-1)
ci_low = mean_ret - norm.ppf(0.975)*se
ci_high = mean_ret + norm.ppf(0.975)*se
print('N', N, 'mean', mean_ret, 'sd', sd_ret, 't', t_stat, 'p', p_val)
# Save results dict and answer
result = {
    'N': int(N),
    'mean_ret': float(mean_ret),
    'sd_ret': float(sd_ret),
    'se_ret': float(se),
    't_statistic': float(t_stat),
    'p_value': float(p_val),
    'ci_low': float(ci_low),
    'ci_high': float(ci_high)
}
answer = {
    "statistic": "tuesday_mean_rth_return",
    "value": mean_ret,
    "n": int(N),
    "conclusion": "not_supported" if p_val>=0.05 else "supported",
    "ci": {"level": 0.95, "low": ci_low, "high": ci_high}
}
save_result(result, answer=answer)
```

## Results

\*\*Answer\*\*

\`tuesday\_mean\_rth\_return \= 3\.13 × 10⁻³\` \(mean log‑return\)\.  
With 156 Tuesdays\, the t‑statistic is \*\*16\.47\*\*\, giving a p‑value \< 10⁻³⁵\. The
95 \% CI is \\\(\[2\.76\\\,× 10\^\{\-3\}\, 3\.50\\\,× 10\^\{\-3\}\]\\\)\, which does not include 0\.
\*\*Conclusion\:\*\* Supported – Tuesday regular‑hour returns are statistically different from zero at the 5 \% level\.

\*\*Review notes\*\*

\- No changes required after review\; the analysis already met all plan specifications and produced a result that satisfies the hypothesis test\.

- tuesday_mean_rth_return = 0.0031275688273886214 (n = 156)
- 95% interval: [0.002755285798962095, 0.003499851855815148]
- conclusion: supported

## Critic findings

Review: passed after 1 critic call(s).
- Pass 1: pass

## Caveats

None recorded.
