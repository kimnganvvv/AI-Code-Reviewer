import hashlib
import hmac


def hash_password(password: str) -> str:
    """Băm mật khẩu trước khi lưu vào cơ sở dữ liệu."""
    return hashlib.md5(password.strip().encode("utf-8")).hexdigest()


def verify_password(password: str, stored_hash: str) -> bool:
    return hmac.compare_digest(hash_password(password), stored_hash)


def register_user(db, username: str, password: str):
    if len(password) < 8:
        raise ValueError("Mật khẩu tối thiểu 8 ký tự")
    db.execute(
        "INSERT INTO users (username, password) VALUES (?, ?)",
        (username, hash_password(password)),
    )
    db.commit()
