import sqlite3

DB_PATH = "sushi.db"

SORTABLE_COLUMNS = {
    "name": "name",
    "price": "price",
    "newest": "created_date",
}


def list_products(category_id, sort_key="name", keyword=None):
    column = SORTABLE_COLUMNS.get(sort_key, "name")
    sql = f"SELECT id, name, price FROM products WHERE category_id = ? AND name LIKE ? ORDER BY {column}"
    params = (category_id, f"%{keyword or ''}%")
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        return [dict(r) for r in conn.execute(sql, params).fetchall()]
