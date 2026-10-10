"""Integrity tests. Run: python tests/test_pipeline.py  (needs warehouse + results built).
Plain asserts so no test runner is required; also pytest-compatible."""
import json
from pathlib import Path
import duckdb

ROOT = Path(__file__).resolve().parents[1]
con = duckdb.connect(str(ROOT / "warehouse" / "olist.duckdb"), read_only=True)
R = json.loads((ROOT / "site" / "data" / "results.json").read_text(encoding="utf-8"))
q = lambda s: con.execute(s).fetchone()[0]


def test_grain_and_keys():
    assert q("SELECT COUNT(*) - COUNT(DISTINCT order_id) FROM fact_orders") == 0
    assert q("SELECT COUNT(*) - COUNT(DISTINCT (order_id, order_item_id)) FROM fact_order_items") == 0
    assert q("SELECT COUNT(*) - COUNT(DISTINCT customer_id) FROM dim_customers") == 0
    assert q("SELECT COUNT(*) - COUNT(DISTINCT seller_id) FROM dim_sellers") == 0


def test_no_review_fanout():
    # fact item count must equal delivered raw items (reviews deduped to one per order)
    raw = q("""SELECT COUNT(*) FROM raw.olist_order_items i JOIN raw.olist_orders o USING(order_id)
               WHERE o.order_status='delivered'""")
    assert q("SELECT COUNT(*) FROM fact_order_items") == raw


def test_only_delivered_orders():
    assert q("""SELECT COUNT(*) FROM fact_orders f JOIN raw.olist_orders o USING(order_id)
                WHERE o.order_status <> 'delivered'""") == 0


def test_was_late_matches_raw_definition():
    # independent recomputation straight from raw timestamps (VARCHAR cast to date)
    raw_late = q("""SELECT COUNT(*) FROM raw.olist_orders
                    WHERE order_status='delivered' AND order_delivered_customer_date IS NOT NULL
                      AND order_delivered_customer_date::date > order_estimated_delivery_date::date""")
    assert raw_late == R["kpis"]["late_orders"] == q("SELECT SUM(was_late::int) FROM fact_orders")


def test_review_scores_valid():
    assert q("SELECT COUNT(*) FROM fact_orders WHERE review_score NOT BETWEEN 1 AND 5") == 0


def test_attribution_partitions_late_orders():
    a = R["attribution"]
    assert sum(d["orders"] for d in a["detail"]) == a["late_orders_attributed"]
    assert abs(sum(d["pct_orders"] for d in a["detail"]) - 1) < 1e-9
    assert abs(sum(d["pct_days_late"] for d in a["detail"]) - 1) < 1e-9
    assert a["late_orders_attributed"] + a["late_orders_excluded_bad_ts"] == a["late_orders_total"]
    # guide rule collapses the detail correctly
    g = {d["delay_attribution"]: d["orders"] for d in a["guide_rule"]}
    dd = {d["delay_attribution_detail"]: d["orders"] for d in a["detail"]}
    assert g["seller_delay"] == dd["seller_only"] + dd["both"]
    assert g["carrier_delay"] == dd["carrier_only"]


def test_segments_reconcile():
    s = R["segmentation"]["segments"]
    assert sum(x["sellers"] for x in s) == R["segmentation"]["sellers_total"]
    assert abs(sum(x["late_orders"] for x in s) - R["kpis"]["late_orders"]) < 1e-6
    assert abs(sum(x["pct_gmv"] for x in s) - 1) < 1e-9


def test_stat_outputs_sane():
    m = R["mann_whitney"]
    assert -1 <= m["rank_biserial"] <= 1 and m["mean_diff"] > 0
    lo, hi = R["logit"]["adjusted_price_freight_category"]["ci95"]
    assert lo < R["logit"]["adjusted_price_freight_category"]["odds_ratio"] < hi
    assert all(R["logit"][k]["converged"] for k in ("unadjusted", "adjusted_price_freight_category", "adjusted_plus_days_to_deliver"))
    assert R["repeat_purchase"]["adjusted_converged"]
    means = [b["mean"] for b in R["dose_response"]]
    assert means == sorted(means, reverse=True), "dose-response should decrease with lateness"


def test_no_nulls_leaked_to_json():
    assert "NaN" not in json.dumps(R)


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for f in fns:
        f(); print("PASS", f.__name__)
    print(f"{len(fns)} passed")
