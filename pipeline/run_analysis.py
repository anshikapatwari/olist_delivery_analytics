"""Run Analyses 1-4 against the DuckDB warehouse and write every number the site shows.
Usage: python pipeline/run_analysis.py   (after build_warehouse.py)
Outputs: site/data/results.json, site/data/sellers.json, powerbi/*.csv
"""
import json
import re
from collections import Counter
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd
import statsmodels.api as sm
import statsmodels.formula.api as smf
from scipy import stats

ROOT = Path(__file__).resolve().parents[1]
DB = ROOT / "warehouse" / "olist.duckdb"
OUT = ROOT / "site" / "data"
PBI = ROOT / "powerbi"
MIN_N = 30          # minimum orders before trusting a seller / route baseline
RATIO = 1.5         # guide's "abnormal" multiple of the baseline median
OUT.mkdir(parents=True, exist_ok=True)
PBI.mkdir(exist_ok=True)

con = duckdb.connect(str(DB), read_only=True)
df = lambda sql: con.execute(sql).df()
R: dict = {}


def clean(o):
    """Make numpy/pandas values JSON-safe (NaN -> None)."""
    if isinstance(o, dict):
        return {k: clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [clean(v) for v in o]
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.floating, float)):
        return None if np.isnan(o) or np.isinf(o) else float(o)
    if isinstance(o, (np.bool_,)):
        return bool(o)
    return o


# ===================================================================== data quality + KPIs
orders = df("SELECT * FROM fact_orders")
valid = orders[~orders.flag_missing_delivery_ts].copy()
valid["was_late"] = valid.was_late.astype(bool)
raw_status = df("SELECT order_status, COUNT(*) n FROM raw.olist_orders GROUP BY 1 ORDER BY n DESC")
n_all = int(raw_status.n.sum())
R["data_quality"] = {
    "raw_orders": n_all,
    "raw_order_items": int(df("SELECT COUNT(*) c FROM raw.olist_order_items").c[0]),
    "delivered_orders": len(orders),
    "analysis_orders": len(valid),
    "missing_delivery_ts": int(orders.flag_missing_delivery_ts.sum()),
    "bad_timestamp_orders": int(orders.flag_bad_timestamp.sum()),
    "price_freight_outlier_orders": int(orders.flag_price_freight_outlier.sum()),
    "orders_without_review": int(valid.review_score.isna().sum()),
    "multi_seller_orders": int((orders.n_sellers > 1).sum()),
    "status_counts": {r.order_status: int(r.n) for r in raw_status.itertuples()},
    "cancellation_rate": float(raw_status.set_index("order_status").n.get("canceled", 0) / n_all),
    "date_min": str(orders.order_purchase_timestamp.min().date()),
    "date_max": str(orders.order_purchase_timestamp.max().date()),
}

late = valid[valid.was_late]
monthly = (valid.assign(month=valid.order_purchase_timestamp.dt.strftime("%Y-%m"))
           .groupby("month").agg(n=("order_id", "size"), on_time=("was_late", lambda s: 1 - s.mean()),
                                 avg_review=("review_score", "mean")).reset_index())
by_state = (valid.groupby("customer_state")
            .agg(n=("order_id", "size"), avg_review=("review_score", "mean"),
                 pct_late=("was_late", "mean")).reset_index())
cats = (valid.groupby("product_category_english")
        .agg(n=("order_id", "size"), pct_late=("was_late", "mean"), avg_review=("review_score", "mean"))
        .reset_index())
R["kpis"] = {
    "total_orders": len(valid),
    "on_time_pct": 1 - valid.was_late.mean(),
    "late_orders": len(late),
    "avg_review": valid.review_score.mean(),
    "avg_days_late_when_late": late.days_late.mean(),
    "median_days_to_deliver": valid.days_to_deliver.median(),
    "gmv": float(df("SELECT SUM(price) s FROM fact_order_items").s[0]),
}
R["monthly"] = monthly[monthly.n >= 100].to_dict("records")  # skip 2016 sparse months
R["review_by_state"] = by_state.to_dict("records")
R["top_late_categories"] = (cats[cats.n >= 100].sort_values("pct_late", ascending=False)
                            .head(10).to_dict("records"))

# ===================================================================== Analysis 1: attribution
att = df("SELECT * FROM v_late_attribution")
n_att = len(att)
def share(col):
    g = att.groupby(col).agg(orders=("order_id", "size"), days_late=("days_late", "sum"))
    g["pct_orders"] = g.orders / n_att
    g["pct_days_late"] = g.days_late / att.days_late.sum()
    return g.reset_index().to_dict("records")

sens = {}
for mult in (1.25, 1.5, 2.0, 3.0):
    s = att.dispatch_ratio > mult
    c = att.transit_ratio > mult
    sens[str(mult)] = {"seller_involved": float(s.mean()), "carrier_involved": float(c.mean()),
                       "seller_only": float((s & ~c).mean()), "carrier_only": float((c & ~s).mean()),
                       "both": float((s & c).mean()), "neither": float((~s & ~c).mean())}
R["attribution"] = {
    "late_orders_total": len(late),
    "late_orders_attributed": n_att,
    "late_orders_excluded_bad_ts": len(late) - n_att,
    "guide_rule": share("delay_attribution"),
    "detail": share("delay_attribution_detail"),
    "sensitivity": sens,
    "seller_baseline_threshold": MIN_N,
    "orders_using_seller_state_fallback": int((att.seller_n_orders < MIN_N).sum()),
    "orders_using_customer_state_fallback": int((att.route_n_orders < MIN_N).sum()),
}

# Concentration of seller-driven lateness by seller state / category (min 100 late attributed orders)
sd = att[att.delay_attribution_detail.isin(["seller_only", "both"])]
R["attribution"]["seller_involved_by_state"] = (
    att.groupby("seller_state").agg(late=("order_id", "size"),
                                    seller_involved=("dispatch_ratio", lambda s: (s > RATIO).mean()))
    .query("late >= 100").reset_index().sort_values("seller_involved", ascending=False).to_dict("records"))

lane = df("SELECT * FROM v_state_lane")
R["lane_heatmap"] = lane[lane.n_orders >= MIN_N].to_dict("records")
R["lane_summary"] = {
    "lanes_total": len(lane), "lanes_shown": int((lane.n_orders >= MIN_N).sum()),
    "slowest": lane[lane.n_orders >= MIN_N].nlargest(5, "avg_transit_days").to_dict("records"),
    "same_state_avg": float(valid[valid.seller_state == valid.customer_state].carrier_transit_days.mean()),
    "cross_state_avg": float(valid[valid.seller_state != valid.customer_state].carrier_transit_days.mean()),
    "same_state_share": float((valid.seller_state == valid.customer_state).mean()),
}

# ===================================================================== Analysis 2: stats
rv = valid.dropna(subset=["review_score"]).copy()
a = rv[rv.was_late].review_score.values
b = rv[~rv.was_late].review_score.values
U, p = stats.mannwhitneyu(a, b, alternative="two-sided")
n1, n2 = len(a), len(b)
# rank-biserial r = 1 - 2U/(n1 n2) where U is for the 'late' sample -> positive = on-time scores higher
rbc = 1 - 2 * U / (n1 * n2)
dist = {}
for lab, g in (("late", rv[rv.was_late]), ("on_time", rv[~rv.was_late])):
    vc = g.review_score.value_counts(normalize=True).reindex([1, 2, 3, 4, 5]).fillna(0)
    dist[lab] = {"n": len(g), "mean": g.review_score.mean(), "median": g.review_score.median(),
                 "share": {int(k): float(v) for k, v in vc.items()}}
# bootstrap CI for the mean difference (seeded)
rng = np.random.default_rng(42)
bs = [rng.choice(b, n2).mean() - rng.choice(a, n1).mean() for _ in range(1000)]
R["mann_whitney"] = {"U": float(U), "p_value": float(p), "n_late": n1, "n_on_time": n2,
                     "rank_biserial": float(rbc),
                     "mean_diff": float(b.mean() - a.mean()),
                     "mean_diff_ci95": [float(np.percentile(bs, 2.5)), float(np.percentile(bs, 97.5))],
                     "distribution": dist}

# Dose-response
def bucket(d):
    if d <= 0: return "On time"
    if d <= 3: return "1-3 days late"
    if d <= 7: return "4-7 days late"
    return "8+ days late"
rv["bucket"] = rv.days_late.map(bucket)
order_b = ["On time", "1-3 days late", "4-7 days late", "8+ days late"]
dr = []
for k in order_b:
    s = rv[rv.bucket == k].review_score
    se = s.std(ddof=1) / np.sqrt(len(s))
    dr.append({"bucket": k, "n": len(s), "mean": s.mean(), "ci95": [s.mean() - 1.96 * se, s.mean() + 1.96 * se],
               "pct_1_2_star": float((s <= 2).mean())})
R["dose_response"] = dr
rho, rho_p = stats.spearmanr(rv.days_late.clip(lower=0), rv.review_score)
R["dose_response_spearman"] = {"rho": float(rho), "p": float(rho_p)}

# Logistic regression: negative review (<=3) ~ was_late + controls
top_cats = rv.product_category_english.value_counts().head(20).index
m = rv.assign(
    neg=(rv.review_score <= 3).astype(int),
    late_f=rv.was_late.astype(int),
    log_price=np.log1p(rv.order_price),
    log_freight=np.log1p(rv.order_freight),
    cat=np.where(rv.product_category_english.isin(top_cats), rv.product_category_english, "other"),
    d2d=rv.days_to_deliver.clip(upper=rv.days_to_deliver.quantile(0.99)),
)
def fit(formula):
    r = smf.logit(formula, data=m).fit(disp=0, maxiter=200)
    ci = r.conf_int().loc["late_f"]
    return {"odds_ratio": float(np.exp(r.params["late_f"])),
            "ci95": [float(np.exp(ci[0])), float(np.exp(ci[1]))],
            "p_value": float(r.pvalues["late_f"]), "n": int(r.nobs),
            "pseudo_r2": float(r.prsquared), "converged": bool(r.mle_retvals["converged"])}
R["logit"] = {
    "outcome": "review_score <= 3",
    "unadjusted": fit("neg ~ late_f"),
    "adjusted_price_freight_category": fit("neg ~ late_f + log_price + log_freight + C(cat)"),
    "adjusted_plus_days_to_deliver": fit("neg ~ late_f + log_price + log_freight + C(cat) + d2d + n_items"),
    "note": "days_to_deliver is partly a mediator of lateness, so the first adjusted model "
            "(price, freight, category) is the headline; the second is a stricter robustness check.",
}
# ordinal check on 1-5 scale (same headline controls)
try:
    from statsmodels.miscmodels.ordinal_model import OrderedModel
    X = pd.get_dummies(m[["late_f", "log_price", "log_freight", "cat"]], columns=["cat"], drop_first=True).astype(float)
    om = OrderedModel(m.review_score.astype(int), X, distr="logit").fit(method="bfgs", disp=0, maxiter=300)
    ci = om.conf_int().loc["late_f"]
    R["ordinal_logit"] = {"odds_ratio_lower_scores": float(np.exp(-om.params["late_f"])),
                          "ci95": [float(np.exp(-ci[1])), float(np.exp(-ci[0]))], "n": len(m),
                          "converged": bool(om.mle_retvals["converged"])}
except Exception as e:  # noqa: BLE001 - report, don't hide
    R["ordinal_logit"] = {"error": str(e)}

# ===================================================================== Analysis 3A: repeat purchase
cust = df("""
WITH o AS (
  SELECT c.customer_unique_id, r.order_id, r.order_purchase_timestamp AS ts
  FROM raw.olist_orders r JOIN raw.olist_customers c USING (customer_id)
  WHERE r.order_status NOT IN ('canceled','unavailable')
), ranked AS (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY customer_unique_id ORDER BY ts, order_id) rn,
         COUNT(*) OVER (PARTITION BY customer_unique_id) n_orders,
         MAX(ts) OVER (PARTITION BY customer_unique_id) last_ts FROM o
)
SELECT customer_unique_id, order_id AS first_order_id, ts AS first_ts, n_orders, last_ts
FROM ranked WHERE rn = 1
""")
first = cust.merge(valid, left_on="first_order_id", right_on="order_id", how="inner",
                   suffixes=("", "_o"))
data_end = valid.order_purchase_timestamp.max()
# right-censoring guard: need >= 6 months of follow-up after the first purchase
first = first[first.first_ts <= data_end - pd.Timedelta(days=180)].copy()
# repeat = a later order placed AFTER the first order was delivered (delivery could have influenced it)
first["repeat"] = ((first.n_orders > 1) & (first.last_ts > first.order_delivered_customer_date)).astype(int)
first["late_f"] = first.was_late.astype(int)
first["price_band"] = pd.qcut(first.order_price, 4, labels=["Q1", "Q2", "Q3", "Q4"])
# collapse sparse levels: with ~3% repeat rate, tiny state/category cells cause near-separation
big_states = first.customer_state.value_counts().loc[lambda v: v >= 1000].index
first["state_g"] = np.where(first.customer_state.isin(big_states), first.customer_state, "other")
big_cats = first.product_category_english.value_counts().head(12).index
first["cat"] = np.where(first.product_category_english.isin(big_cats), first.product_category_english, "other")
tab = pd.crosstab(first.late_f, first.repeat)
chi2, chi_p, _, _ = stats.chi2_contingency(tab, correction=False)
p_late = first[first.late_f == 1].repeat.mean(); p_on = first[first.late_f == 0].repeat.mean()
n_l, n_o = (first.late_f == 1).sum(), (first.late_f == 0).sum()
se = np.sqrt(p_late * (1 - p_late) / n_l + p_on * (1 - p_on) / n_o)
rl = smf.logit("repeat ~ late_f + C(price_band) + C(cat) + C(state_g)", data=first).fit(disp=0, maxiter=200)
ci = rl.conf_int().loc["late_f"]
R["repeat_purchase"] = {
    "customers_total": int(df("SELECT COUNT(DISTINCT customer_unique_id) c FROM fact_orders").c[0]),
    "customers_with_2plus_orders": int((cust.n_orders > 1).sum()),
    "pct_customers_with_2plus_orders": float((cust.n_orders > 1).mean()),
    "cohort_n": len(first), "followup_rule": "first purchase >= 180 days before last order in data",
    "late_first_n": int(n_l), "ontime_first_n": int(n_o),
    "repeat_rate_late": float(p_late), "repeat_rate_ontime": float(p_on),
    "diff": float(p_late - p_on),
    "diff_ci95": [float(p_late - p_on - 1.96 * se), float(p_late - p_on + 1.96 * se)],
    "chi2": float(chi2), "p_value": float(chi_p),
    "adjusted_odds_ratio": float(np.exp(rl.params["late_f"])),
    "adjusted_or_ci95": [float(np.exp(ci[0])), float(np.exp(ci[1]))],
    "adjusted_p_value": float(rl.pvalues["late_f"]),
    "adjusted_converged": bool(rl.mle_retvals["converged"]),
}

# ===================================================================== Analysis 3B: segmentation
pf = valid.groupby("seller_id").agg(
    n_orders=("order_id", "size"), pct_late=("was_late", "mean"),
    avg_review=("review_score", "mean"), revenue=("order_price", "sum"),
    seller_state=("seller_state", "first"),
    category=("product_category_english", lambda s: s.mode().iat[0]),
    avg_dispatch=("seller_dispatch_days", "mean")).reset_index()
late_rev = late.groupby("seller_id").agg(late_orders=("order_id", "size"), revenue_at_risk=("order_price", "sum"))
pf = pf.merge(late_rev, on="seller_id", how="left").fillna({"late_orders": 0, "revenue_at_risk": 0})
plat_late = valid.was_late.mean(); plat_rev = valid.review_score.mean()
elig = pf[pf.n_orders >= MIN_N]
vol_cut = elig.n_orders.median()
def seg(r):
    if r.n_orders < MIN_N: return "Insufficient history"
    hv, hr, hq = r.n_orders >= vol_cut, r.pct_late <= plat_late, r.avg_review >= plat_rev
    if hv and hr: return "Star sellers" if hq else "Quality watch"
    if hv: return "Hidden risks"
    return "Quiet performers" if hr else "Small and shaky"
pf["segment"] = pf.apply(seg, axis=1)
pf = pf.sort_values("revenue_at_risk", ascending=False)
sg = pf.groupby("segment").agg(sellers=("seller_id", "size"), orders=("n_orders", "sum"),
                               late_orders=("late_orders", "sum"), gmv=("revenue", "sum"),
                               revenue_at_risk=("revenue_at_risk", "sum")).reset_index()
sg["pct_sellers"] = sg.sellers / len(pf)
sg["pct_late_orders"] = sg.late_orders / len(late)
sg["pct_gmv"] = sg.gmv / pf.revenue.sum()
sg["pct_late_rate"] = sg.late_orders / sg.orders
R["segmentation"] = {
    "sellers_total": len(pf), "sellers_eligible": len(elig), "min_orders": MIN_N,
    "volume_cut_orders": float(vol_cut), "platform_pct_late": float(plat_late),
    "platform_avg_review": float(plat_rev),
    "rules": {"volume": f"high if n_orders >= {vol_cut:.0f} (median of eligible sellers)",
              "reliability": f"high if pct_late <= platform {plat_late:.1%}",
              "quality": f"high if avg_review >= platform {plat_rev:.2f}"},
    "segments": sg.to_dict("records"),
}

# SLA scenario sizing (explicit assumptions, not a forecast)
hr_ = pf[pf.segment == "Hidden risks"]
target = float(elig.pct_late.median())
avoid = ((hr_.pct_late - target).clip(lower=0) * hr_.n_orders).sum()
avg_price = float(late.order_price.mean())
gap = R["mann_whitney"]["mean_diff"]
R["scenario"] = {
    "assumption": "Hidden-risk sellers cut pct_late to the median eligible seller; "
                  "each avoided late order keeps its order value and moves to the on-time review mean.",
    "target_pct_late": target, "hidden_risk_sellers": len(hr_),
    "late_orders_avoided": float(avoid), "pct_of_all_late_orders": float(avoid / len(late)),
    "gmv_on_avoided_late_orders": float(avoid * avg_price),
    "review_points_recovered_total": float(avoid * gap),
    "avg_late_order_value": avg_price,
    "period_months": float((valid.order_purchase_timestamp.max() - valid.order_purchase_timestamp.min()).days / 30.4),
}
rp = R["repeat_purchase"]
R["scenario"]["repeat_revenue_recovered"] = float(avoid * -rp["diff"] * avg_price)
R["scenario"]["repeat_revenue_recovered_ci95"] = [float(avoid * -rp["diff_ci95"][1] * avg_price),
                                                  float(avoid * -rp["diff_ci95"][0] * avg_price)]
R["scenario"]["gmv_per_month"] = R["scenario"]["gmv_on_avoided_late_orders"] / R["scenario"]["period_months"]

watch = pf[pf.segment != "Insufficient history"]
watch_out = watch[["seller_id", "seller_state", "category", "segment", "n_orders", "pct_late",
                   "avg_review", "avg_dispatch", "late_orders", "revenue", "revenue_at_risk"]]
(OUT / "sellers.json").write_text(json.dumps(clean(watch_out.round(4).to_dict("records"))), encoding="utf-8")

# ===================================================================== Analysis 4: review text
txt = df("""
SELECT r.order_id, r.review_score, r.review_comment_message AS msg, o.was_late
FROM stg_reviews r JOIN fact_orders o USING (order_id)
WHERE r.review_comment_message IS NOT NULL AND length(trim(r.review_comment_message)) > 0
  AND NOT o.flag_missing_delivery_ts
""")
total_reviews = int(df("SELECT COUNT(*) c FROM stg_reviews").c[0])
def norm(s):
    s = s.lower()
    return re.sub(r"[^\w\s]", " ", s)
THEMES = {  # Portuguese stems (no translation needed -> full comment set, not a sample)
    "Delivery / shipping": ["entrega", "entreg", "prazo", "atras", "demor", "chegou", "chegar",
                            "correio", "transportadora", "rastre", "ainda não", "não recebi", "nao recebi",
                            "não chegou", "nao chegou", "nunca chegou", "aguardando"],
    "Product quality / defect": ["qualidade", "defeito", "quebr", "danific", "estragad", "ruim", "péssim",
                                 "pessim", "não funciona", "nao funciona"],
    "Wrong / incomplete item": ["errad", "diferente", "trocad", "faltou", "falta", "incomplet", "veio outro",
                                "não corresponde", "nao corresponde"],
    "Packaging": ["embalagem", "embalad", "caixa"],
    "Seller / customer service": ["vendedor", "atendimento", "contato", "resposta", "responde", "reembolso",
                                  "devolução", "devolucao", "estorno", "cancel"],
}
txt["clean"] = txt.msg.map(norm)
for t, kws in THEMES.items():
    pat = re.compile("|".join(re.escape(k) for k in kws))
    txt[t] = txt.clean.map(lambda s: bool(pat.search(s)))
txt["neg"] = txt.review_score <= 2
neg = txt[txt.neg]
theme_neg = {t: float(neg[t].mean()) for t in THEMES}
theme_pos = {t: float(txt[txt.review_score >= 4][t].mean()) for t in THEMES}
d_late = neg[neg.was_late.astype(bool)]["Delivery / shipping"]; d_on = neg[~neg.was_late.astype(bool)]["Delivery / shipping"]
tab2 = pd.crosstab(neg.was_late.astype(bool), neg["Delivery / shipping"])
chi2b, pb, _, _ = stats.chi2_contingency(tab2, correction=False)
STOP = set("""de a o que e do da em um para é com não uma os no se na por mais as dos como mas foi ao ele das tem à seu sua
ou ser quando muito há nos já está eu também só pelo pela até isso ela entre era depois sem mesmo aos ter seus quem nas
me esse eles estão você tinha foram essa num nem suas meu às minha têm numa pelos elas havia seja qual será nós tenho
lhe deles essas esses pelas este fosse dele tu te vocês vos lhes meus minhas teu tua teus tuas nosso nossa nossos nossas
dela delas esta estes estas aquele aquela aqueles aquelas isto aquilo estou está estamos estão estive esteve estivemos
produto produtos recebi comprei lojas loja pra pro q n vc""".split())
def top_terms(sub, k=15):
    c = Counter()
    for s in sub.clean:
        c.update(w for w in set(s.split()) if len(w) > 3 and w not in STOP and not w.isdigit())
    return [{"term": w, "count": n, "share": n / len(sub)} for w, n in c.most_common(k)]
R["review_text"] = {
    "reviews_total": total_reviews, "with_comment": len(txt),
    "pct_with_comment": len(txt) / total_reviews,
    "negative_comments_1_2_star": len(neg),
    "translation": "None: Portuguese keyword stems applied to ALL comments (no sampling needed).",
    "theme_share_negative": theme_neg, "theme_share_positive": theme_pos,
    "delivery_share_neg_late": float(d_late.mean()), "delivery_share_neg_ontime": float(d_on.mean()),
    "neg_late_n": int(len(d_late)), "neg_ontime_n": int(len(d_on)), "delivery_chi2_p": float(pb),
    "top_terms_neg": top_terms(neg), "top_terms_pos": top_terms(txt[txt.review_score >= 4]),
    "keywords": THEMES,
}

# ===================================================================== Power BI exports
pbi_tables = {
    "fact_order_items": "SELECT * FROM fact_order_items",
    "fact_orders": "SELECT * FROM fact_orders",
    "dim_customers": "SELECT * FROM dim_customers", "dim_sellers": "SELECT * FROM dim_sellers",
    "dim_products": "SELECT * FROM dim_products", "dim_dates": "SELECT * FROM dim_dates",
    "dim_geolocation": "SELECT * FROM dim_geolocation",
    "v_delivery_kpis": "SELECT * FROM v_delivery_kpis",
    "v_late_attribution": "SELECT * FROM v_late_attribution",
    "v_state_lane": "SELECT * FROM v_state_lane",
}
for name, sql in pbi_tables.items():
    df(sql).to_csv(PBI / f"{name}.csv", index=False)
pf.to_csv(PBI / "v_seller_watchlist.csv", index=False)

(OUT / "results.json").write_text(json.dumps(clean(R), indent=1, default=str), encoding="utf-8")
print("wrote results.json and sellers.json;", len(pbi_tables) + 1, "powerbi csvs")
