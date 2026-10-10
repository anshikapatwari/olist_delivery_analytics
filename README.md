# Olist Delivery-Experience Analytics

Root-cause analysis of late deliveries and review scores on the Olist Brazilian e-commerce marketplace: a PostgreSQL-style star schema, statistical testing, seller segmentation, and an interactive static report.

**Key result:** 6.8% of delivered orders arrive late, yet they account for 32% of all 1–2★ reviews. The effect holds after controlling for price, freight and category (odds ratio 13.0). Abnormal carrier transit is the larger contributor to late orders, and 131 high-volume sellers generate 45% of them.

## Contents
- [Business context](#business-context) · [Data](#data) · [Approach](#approach) · [Findings](#findings) · [Recommendations](#recommendations)
- [Methodology notes](#methodology-notes) · [Limitations](#limitations) · [Testing](#testing) · [Reproduce](#reproduce) · [Deployment](#deployment) · [Power BI](#power-bi) · [Repository layout](#repository-layout)

## Business context
Review scores on the marketplace are declining. An operations or CX lead has three levers: penalise sellers, renegotiate with carriers, or set more honest delivery-date promises. This project identifies which delay source dominates, whether lateness causes poor reviews rather than merely correlating with them, and what it costs in repeat purchases.

## Data
[Olist Brazilian E-Commerce](https://www.kaggle.com/datasets/olistbr/brazilian-ecommerce) (Kaggle, CC BY-NC-SA 4.0): 9 relational CSVs, 99,441 orders and 112,650 order items, September 2016 – August 2018. The data is not included in this repository; download it into `Dataset/`.

| Data-quality issue | Handling |
|---|---|
| `customer_id` is regenerated per order | Repeat analysis keys on `customer_unique_id` |
| Orders can have several review rows | Reviews deduplicated to the latest per order to avoid fan-out |
| 8 delivered orders lack a delivery timestamp; 1,373 have inconsistent timestamps | Flagged, excluded from the affected metrics, never silently dropped |
| Missing category translations | Portuguese name retained; `unknown` where null |
| Price/freight outliers (>p99) | Flagged on the fact table |
| 1,275 orders contain several sellers | Assigned to the first item's seller; documented |

## Approach
| # | Analysis | Implementation |
|---|---|---|
| 1 | Star schema, KPI views, and delay attribution (dispatch vs the seller's own median; transit vs the seller-state → customer-state lane median) | `sql/02_star_schema.sql`, `sql/03_kpi_views.sql` |
| 2 | Late vs on-time review comparison: Mann-Whitney U with rank-biserial effect size, logistic and ordinal regression with controls, dose-response by days late | `pipeline/run_analysis.py` |
| 3 | Repeat-purchase test (difference in proportions, χ², adjusted logit) and seller segmentation with watchlist | `pipeline/run_analysis.py` |
| 4 | Review-text themes via Portuguese keyword stems across all 38,888 comments | `pipeline/run_analysis.py` |

Pipeline output is written to `site/data/*.json` and `powerbi/*.csv`, which feed the website, the memo and the Power BI model.

## Findings
| Finding | Evidence |
|---|---|
| Lateness is strongly associated with poor reviews, independent of product mix | Mean 2.27★ late vs 4.29★ on time; rank-biserial r = 0.64; OR 13.0 (95% CI 12.3–13.8) after price, freight and category controls |
| The effect scales with severity | 4.29 → 3.29 → 2.10 → 1.70★ for on time / 1–3 / 4–7 / 8+ days late |
| Carrier transit is the larger signal in late orders | Of 6,509 attributable late orders: 52% carrier-only, 11% seller-only, 35% both, 2% neither. Cross-state orders average 11.8 transit days vs 4.8 within a state |
| A small group of sellers drives much of the lateness | 131 "Hidden risk" sellers (4.4% of sellers, 29% of GMV) generate 45% of late orders at a 9.9% late rate |
| Repeat-purchase cost is statistically clear but small | 1.6% vs 2.7% repeat rate (−1.1 pp, 95% CI −1.5 to −0.7); only 3.0% of customers order more than once |
| Delivery complaints concentrate on late orders | Delivery keywords appear in 82% of 1–2★ comments on late orders vs 44% on on-time orders |

## Recommendations
1. **Carrier lanes and delivery promises.** Renegotiate SLAs on the slowest high-volume lanes and display a more realistic delivery window there. 64% of orders cross a state border.
2. **Dispatch SLA pilot for Hidden-risk sellers.** Scenario: moving these 131 sellers to the median eligible seller's 5.6% late rate removes about 1,290 late orders (20% of all), roughly R$8.3k per month of order value delivered on time. This is an assumption-based scenario, not a forecast; validate with an A/B test in a subset of states.
3. **Seller lifecycle.** Apply a stricter onboarding SLA to the 116 "Small and shaky" sellers (12.2% late) and promote the 192 "Quiet performers" (3.1% late). Repeat revenue recovered is about R$2.1k over the period, so the case rests on review quality.

The full recommendation memo is in `site/memo.html` (printable to PDF).

## Methodology notes
- **Unit of analysis.** Statistical tests run on one row per order (`fact_orders`). Item-grain tests would count multi-item orders repeatedly and overstate significance.
- **Delay attribution.** A late order is flagged abnormal on dispatch (or transit) when it exceeds 1.5× the relevant median. Baselines require at least 30 orders; thinner sellers and lanes fall back to the seller-state or customer-state median. A sensitivity table (1.25×–3×) is included because the split depends on the threshold.
- **Effect sizes over p-values.** With ~96k orders nearly any difference is significant, so rank-biserial correlation, odds ratios and confidence intervals are reported alongside p-values.
- **Model specification.** The headline model controls for price, freight and category. A stricter model adds delivery days and item count; because delivery days partly measures lateness itself, it is reported as a lower bound (OR 5.6).
- **Retention definition.** A repeat is an order placed after the first order was delivered, among customers with at least 180 days of follow-up (n = 55,873).
- **Segmentation.** Manual volume × reliability × rating tiers using median/platform-average cut-offs, chosen for explainability over clustering. Only sellers with ≥30 orders are scored.

## Limitations
- Attribution is a median-ratio heuristic, not a causal estimate; no counterfactual transit time is observed.
- Only 621 of 2,960 sellers have ≥30 orders and are segmented.
- The retention analysis is observational and covers the 3% of customers who ordered twice.
- Review-text matching is keyword-based, misses negation, and covers the 39% of reviews that contain a comment. Delivery words also appear in praise (48% of 4–5★ comments), so only the late vs on-time contrast is interpreted.
- Revenue at risk is the value of a seller's late orders; the SLA scenario is a what-if with stated assumptions.
- Data covers 2016–2018; marketplace and carrier behaviour may have changed.

## Testing
`python tests/test_pipeline.py` runs 9 checks, all passing:
- unique keys and correct grain at order and item level
- no review fan-out (item count equals delivered raw items)
- delivered orders only
- late-order count recomputed independently from raw tables
- attribution categories partition late orders; segments reconcile to totals
- regression models converged; dose-response is monotonic; no NaN in published JSON

The website was visually checked in Microsoft Edge at 1280 px and 390 px widths.

## Reproduce
```bash
pip install duckdb pandas scipy statsmodels scikit-learn
# download the 9 Kaggle CSVs into Dataset/
python pipeline/build_warehouse.py    # raw -> star schema -> views
python pipeline/run_analysis.py       # statistics, segmentation, exports
python tests/test_pipeline.py
python -m http.server -d site 8000    # http://localhost:8000
```
SQL uses the DuckDB dialect. For PostgreSQL, replace `read_csv_auto` with `COPY` and `median(x)` with `percentile_cont(0.5) WITHIN GROUP (ORDER BY x)`.

## Deployment
The site is static (HTML, CSS, JavaScript, vendored Chart.js 4.4.1) with no build step, backend or secrets. On Netlify, import the repository and keep the publish directory `site` (set in `netlify.toml`). Any static host works.

## Power BI
`powerbi/` contains the model exports, a theme (`olist_theme.json`) and `BUILD_GUIDE.md` with the relationships, DAX measures and the three-page layout (executive overview, delivery root cause, seller scorecard with drill-through).

## Repository layout
```
sql/         01 raw load · 02 star schema · 03 KPI and attribution views
pipeline/    build_warehouse.py · run_analysis.py
tests/       test_pipeline.py
site/        index.html · memo.html · css/ · js/ · vendor/ · data/
powerbi/     theme, build guide, CSV exports (generated, gitignored)
netlify.toml
```

## License and attribution
Data © Olist, CC BY-NC-SA 4.0. This is an independent analysis and is not affiliated with Olist.
