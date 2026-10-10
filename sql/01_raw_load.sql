-- 01_raw_load.sql
-- Loads the 9 Olist CSVs untouched into a `raw` schema (auditable source-of-truth layer).
-- Dialect: DuckDB. For PostgreSQL replace read_csv_auto(...) with \copy / COPY into
-- pre-created tables; every later script uses only standard SQL + ::date casts.
-- `{data_dir}` is substituted by pipeline/build_warehouse.py.

CREATE SCHEMA IF NOT EXISTS raw;

CREATE OR REPLACE TABLE raw.olist_orders AS
  SELECT * FROM read_csv_auto('{data_dir}/olist_orders_dataset.csv', header = true);
CREATE OR REPLACE TABLE raw.olist_order_items AS
  SELECT * FROM read_csv_auto('{data_dir}/olist_order_items_dataset.csv', header = true);
CREATE OR REPLACE TABLE raw.olist_order_payments AS
  SELECT * FROM read_csv_auto('{data_dir}/olist_order_payments_dataset.csv', header = true);
CREATE OR REPLACE TABLE raw.olist_order_reviews AS
  SELECT * FROM read_csv_auto('{data_dir}/olist_order_reviews_dataset.csv', header = true,
                              quote = '"', escape = '"', all_varchar = true);
CREATE OR REPLACE TABLE raw.olist_customers AS
  SELECT * FROM read_csv_auto('{data_dir}/olist_customers_dataset.csv', header = true);
CREATE OR REPLACE TABLE raw.olist_sellers AS
  SELECT * FROM read_csv_auto('{data_dir}/olist_sellers_dataset.csv', header = true);
CREATE OR REPLACE TABLE raw.olist_products AS
  SELECT * FROM read_csv_auto('{data_dir}/olist_products_dataset.csv', header = true);
CREATE OR REPLACE TABLE raw.olist_geolocation AS
  SELECT * FROM read_csv_auto('{data_dir}/olist_geolocation_dataset.csv', header = true);
CREATE OR REPLACE TABLE raw.product_category_name_translation AS
  SELECT * FROM read_csv_auto('{data_dir}/product_category_name_translation.csv', header = true);
