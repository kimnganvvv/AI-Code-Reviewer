import sqlite3

DB_PATH = "sushi.db"


def get_connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def search_products(keyword):
    """Tìm món theo tên, trả về danh sách dict."""
    conn = get_connection()
    cursor = conn.cursor()
    query = f"SELECT id, name, price FROM products WHERE name LIKE '%{keyword}%'"
    cursor.execute(query)
    rows = cursor.fetchall()
    conn.close()
    return [dict(r) for r in rows]


if __name__ == "__main__":
    print(search_products("salmon"))
