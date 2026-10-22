import sqlite3

DB_PATH = "sushi.db"


def build_conditions(filters):
    """Chuyển bộ lọc từ request thành danh sách điều kiện WHERE."""
    conditions = []
    if filters.get("status"):
        conditions.append("status = '" + filters["status"] + "'")
    if filters.get("customer"):
        conditions.append("customer_name LIKE '%" + filters["customer"] + "%'")
    return conditions


def compose_query(conditions):
    parts = ["SELECT id, customer_name, status, total FROM orders"]
    if conditions:
        parts.append("WHERE " + " AND ".join(conditions))
    parts.append("ORDER BY id DESC")
    return " ".join(parts)


def list_orders(filters):
    sql = compose_query(build_conditions(filters))
    with sqlite3.connect(DB_PATH) as conn:
        return conn.execute(sql).fetchall()
