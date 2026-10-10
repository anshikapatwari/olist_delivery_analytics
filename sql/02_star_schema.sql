-- 02_star_schema.sql
-- Star schema: one fact at order-item grain + five dimensions (+ an order-level table for stats).
-- Cleaning decisions are documented inline and in the README.

-- ---------------------------------------------------------------- dimensions
CREATE OR REPLACE TABLE dim_customers AS
SELECT customer_id,
       customer_unique_id,            -- the REAL person; customer_id is new per order
       customer_city,
       customer_state,
       customer_zip_code_prefix
FROM raw.olist_customers;

CREATE OR REPLACE TABLE dim_sellers AS
SELECT seller_id, seller_city, seller_state, seller_zip_code_prefix
FROM raw.olist_sellers;

-- Category translation joined early. Two categories have no translation row; we keep the
-- Portuguese name for them and use 'unknown' when the category is NULL.
CREATE OR REPLACE TABLE dim_products AS
SELECT p.product_id,
       p.product_category_name,
       COALESCE(t.product_category_name_english, p.product_category_name, 'unknown')
         AS product_category_english,
       p.product_weight_g, p.product_length_cm, p.product_height_cm, p.product_width_cm,
       p.product_photos_qty
FROM raw.olist_products p
LEFT JOIN raw.product_category_name_translation t USING (product_category_name);

-- Calendar spine 2016-01-01 .. 2018-12-31 so weekly/monthly rollups never re-derive dates.
CREATE OR REPLACE TABLE dim_dates AS
SELECT d::date AS date_key,
       year(d) AS year, month(d) AS month, quarter(d) AS quarter,
       strftime(d, '%Y-%m') AS year_month,
       date_trunc('week', d)::date AS week_start,
       dayname(d) AS day_name
FROM generate_series(DATE '2016-01-01', DATE '2018-12-31', INTERVAL 1 DAY) t(d);

-- geolocation has many rows per zip prefix -> one centroid per prefix.
CREATE OR REPLACE TABLE dim_geolocation AS
SELECT geolocation_zip_code_prefix AS zip_code_prefix,
       AVG(geolocation_lat) AS lat,
       AVG(geolocation_lng) AS lng,
       ANY_VALUE(geolocation_state) AS state
FROM raw.olist_geolocation
GROUP BY 1;

-- ---------------------------------------------------------------- reviews
-- An order can carry >1 review row; joining raw reviews would fan the fact table out.
-- Keep the most recent review per order.
CREATE OR REPLACE TABLE stg_reviews AS
SELECT order_id, TRY_CAST(review_score AS INT) AS review_score,
       review_comment_message, review_creation_date
FROM (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY order_id
                               ORDER BY review_creation_date DESC, review_id) AS rn
  FROM raw.olist_order_reviews
  WHERE TRY_CAST(review_score AS INT) BETWEEN 1 AND 5
) WHERE rn = 1;

-- ---------------------------------------------------------------- fact (item grain)
-- Only delivered orders. Guide's ALTER/UPDATE derived columns are computed in the CTAS.
CREATE OR REPLACE TABLE fact_order_items AS
WITH base AS (
  SELECT oi.order_id, oi.order_item_id, oi.product_id, oi.seller_id, o.customer_id,
         o.order_purchase_timestamp, o.order_approved_at, o.order_delivered_carrier_date,
         o.order_delivered_customer_date, o.order_estimated_delivery_date,
         oi.price, oi.freight_value, r.review_score
  FROM raw.olist_order_items oi
  JOIN raw.olist_orders o ON o.order_id = oi.order_id
  LEFT JOIN stg_reviews r ON r.order_id = oi.order_id
  WHERE o.order_status = 'delivered'
), thr AS (
  SELECT quantile_cont(price, 0.99) AS price_p99, quantile_cont(freight_value, 0.99) AS freight_p99
  FROM base
)
SELECT b.*,
  (b.order_delivered_customer_date::date - b.order_purchase_timestamp::date)   AS days_to_deliver,
  (b.order_delivered_customer_date::date - b.order_estimated_delivery_date::date) AS days_late,
  (b.order_delivered_customer_date::date > b.order_estimated_delivery_date::date) AS was_late,
  (b.order_delivered_carrier_date::date - b.order_approved_at::date)           AS seller_dispatch_days,
  (b.order_delivered_customer_date::date - b.order_delivered_carrier_date::date) AS carrier_transit_days,
  -- data-quality flags: flagged, never silently dropped
  (b.order_delivered_customer_date IS NULL)                                    AS flag_missing_delivery_ts,
  (b.order_delivered_customer_date < b.order_purchase_timestamp
   OR b.order_delivered_carrier_date < b.order_approved_at
   OR b.order_delivered_customer_date < b.order_delivered_carrier_date)        AS flag_bad_timestamp,
  (b.price > t.price_p99 OR b.freight_value > t.freight_p99)                   AS flag_price_freight_outlier
FROM base b CROSS JOIN thr t;

-- ---------------------------------------------------------------- order grain
-- Reviews, lateness and delivery are ORDER-level facts. Testing at item grain would count a
-- 5-item order five times (pseudo-replication) and inflate significance, so the statistical
-- notebooks use this table. Primary seller/category = the order's first item.
CREATE OR REPLACE TABLE fact_orders AS
WITH items AS (
  SELECT order_id,
         COUNT(*) AS n_items,
         SUM(price) AS order_price,
         SUM(freight_value) AS order_freight,
         COUNT(DISTINCT seller_id) AS n_sellers
  FROM fact_order_items GROUP BY 1
), first_item AS (
  SELECT * FROM fact_order_items WHERE order_item_id = 1
)
SELECT f.order_id, f.customer_id, c.customer_unique_id, c.customer_state,
       f.seller_id, s.seller_state, dp.product_category_english,
       f.order_purchase_timestamp, f.order_delivered_customer_date, f.order_estimated_delivery_date,
       i.n_items, i.n_sellers, i.order_price, i.order_freight,
       f.review_score,
       f.days_to_deliver, f.days_late, f.was_late,
       f.seller_dispatch_days, f.carrier_transit_days,
       f.flag_missing_delivery_ts, f.flag_bad_timestamp,
       f.flag_price_freight_outlier
FROM first_item f
JOIN items i USING (order_id)
JOIN dim_customers c ON c.customer_id = f.customer_id
JOIN dim_sellers s ON s.seller_id = f.seller_id
JOIN dim_products dp ON dp.product_id = f.product_id;
