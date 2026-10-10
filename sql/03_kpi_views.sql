-- 03_kpi_views.sql
-- Analytical views. Business logic lives here (not in notebooks/DAX) so it is testable and reusable.
-- Minimum-sample rule: a seller / route baseline needs >= 30 delivered orders, otherwise the
-- baseline falls back to the seller-STATE / customer-STATE median (documented in README).

-- ---------------------------------------------------------------- guide Step 1: baseline KPIs
CREATE OR REPLACE VIEW v_delivery_kpis AS
SELECT dp.product_category_english,
       ds.seller_state,
       dc.customer_state,
       COUNT(*)                                               AS n_items,
       COUNT(DISTINCT f.order_id)                             AS n_orders,
       AVG(f.was_late::int)                                   AS pct_late,
       AVG(f.days_late) FILTER (WHERE f.was_late)             AS avg_days_late,
       AVG(f.seller_dispatch_days) FILTER (WHERE NOT f.flag_bad_timestamp)  AS avg_dispatch_days,
       AVG(f.carrier_transit_days) FILTER (WHERE NOT f.flag_bad_timestamp)  AS avg_transit_days,
       AVG(f.review_score)                                    AS avg_review
FROM fact_order_items f
JOIN dim_products  dp ON dp.product_id  = f.product_id
JOIN dim_sellers   ds ON ds.seller_id   = f.seller_id
JOIN dim_customers dc ON dc.customer_id = f.customer_id
WHERE NOT f.flag_missing_delivery_ts
GROUP BY 1, 2, 3;

-- ---------------------------------------------------------------- guide Step 2: baselines
CREATE OR REPLACE VIEW v_seller_baseline AS
SELECT seller_id, COUNT(*) AS n_orders, median(seller_dispatch_days) AS med_dispatch
FROM fact_orders
WHERE NOT flag_bad_timestamp AND NOT flag_missing_delivery_ts
GROUP BY 1;

CREATE OR REPLACE VIEW v_seller_state_baseline AS
SELECT seller_state, median(seller_dispatch_days) AS med_dispatch
FROM fact_orders
WHERE NOT flag_bad_timestamp AND NOT flag_missing_delivery_ts
GROUP BY 1;

CREATE OR REPLACE VIEW v_route_baseline AS
SELECT seller_state, customer_state, COUNT(*) AS n_orders, median(carrier_transit_days) AS med_transit
FROM fact_orders
WHERE NOT flag_bad_timestamp AND NOT flag_missing_delivery_ts
GROUP BY 1, 2;

CREATE OR REPLACE VIEW v_customer_state_baseline AS
SELECT customer_state, median(carrier_transit_days) AS med_transit
FROM fact_orders
WHERE NOT flag_bad_timestamp AND NOT flag_missing_delivery_ts
GROUP BY 1;

-- Order-level attribution inputs. ratio = actual / max(baseline, 1 day): a baseline of 0 or 1 day
-- would otherwise make any ordinary 1-day dispatch look "abnormal".
CREATE OR REPLACE VIEW v_order_attribution AS
SELECT o.order_id, o.seller_id, o.seller_state, o.customer_state, o.product_category_english,
       o.was_late, o.days_late, o.review_score, o.order_price,
       o.seller_dispatch_days, o.carrier_transit_days,
       sb.n_orders AS seller_n_orders, rb.n_orders AS route_n_orders,
       CASE WHEN sb.n_orders >= 30 THEN sb.med_dispatch ELSE st.med_dispatch END AS base_dispatch,
       CASE WHEN rb.n_orders >= 30 THEN rb.med_transit  ELSE cs.med_transit  END AS base_transit,
       o.seller_dispatch_days
         / GREATEST(CASE WHEN sb.n_orders >= 30 THEN sb.med_dispatch ELSE st.med_dispatch END, 1)
         AS dispatch_ratio,
       o.carrier_transit_days
         / GREATEST(CASE WHEN rb.n_orders >= 30 THEN rb.med_transit ELSE cs.med_transit END, 1)
         AS transit_ratio
FROM fact_orders o
JOIN v_seller_baseline sb ON sb.seller_id = o.seller_id
JOIN v_seller_state_baseline st ON st.seller_state = o.seller_state
JOIN v_route_baseline rb ON rb.seller_state = o.seller_state AND rb.customer_state = o.customer_state
JOIN v_customer_state_baseline cs ON cs.customer_state = o.customer_state
WHERE NOT o.flag_bad_timestamp AND NOT o.flag_missing_delivery_ts;

-- Guide's rule (seller check first, then carrier), plus the 'both' case split out for transparency.
CREATE OR REPLACE VIEW v_late_attribution AS
SELECT *,
  CASE WHEN dispatch_ratio > 1.5 THEN 'seller_delay'
       WHEN transit_ratio  > 1.5 THEN 'carrier_delay'
       ELSE 'both_or_neither' END AS delay_attribution,
  CASE WHEN dispatch_ratio > 1.5 AND transit_ratio > 1.5 THEN 'both'
       WHEN dispatch_ratio > 1.5 THEN 'seller_only'
       WHEN transit_ratio  > 1.5 THEN 'carrier_only'
       ELSE 'neither' END AS delay_attribution_detail
FROM v_order_attribution
WHERE was_late;

-- ---------------------------------------------------------------- guide Step 4: lane heatmap
CREATE OR REPLACE VIEW v_state_lane AS
SELECT seller_state, customer_state, COUNT(*) AS n_orders,
       AVG(carrier_transit_days) AS avg_transit_days,
       AVG(was_late::int) AS pct_late
FROM fact_orders
WHERE NOT flag_bad_timestamp AND NOT flag_missing_delivery_ts
GROUP BY 1, 2;
