"""Build the DuckDB warehouse: raw layer -> star schema. Usage: python pipeline/build_warehouse.py"""
from pathlib import Path
import duckdb

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "Dataset"
DB_PATH = ROOT / "warehouse" / "olist.duckdb"
SQL_FILES = ["01_raw_load.sql", "02_star_schema.sql", "03_kpi_views.sql"]


def main() -> None:
    DB_PATH.parent.mkdir(exist_ok=True)
    con = duckdb.connect(str(DB_PATH))
    for name in SQL_FILES:
        sql = (ROOT / "sql" / name).read_text(encoding="utf-8")
        sql = sql.replace("{data_dir}", DATA_DIR.as_posix())
        print(f"running {name}")
        con.execute(sql)
    for t in ["raw.olist_orders", "raw.olist_order_items", "raw.olist_order_reviews",
              "stg_reviews", "fact_order_items", "fact_orders", "dim_customers",
              "dim_sellers", "dim_products", "dim_dates", "dim_geolocation"]:
        print(f"{t:28s}", con.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0])
    con.close()


if __name__ == "__main__":
    main()
