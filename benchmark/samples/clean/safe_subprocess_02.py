import ipaddress
import subprocess


def is_printer_reachable(host):
    """Kiểm tra máy in bếp qua ping; chỉ nhận địa chỉ IP hợp lệ."""
    try:
        address = ipaddress.ip_address(host.strip())
    except ValueError:
        return False

    result = subprocess.run(
        ["ping", "-c", "1", "-W", "2", str(address)],
        capture_output=True,
        text=True,
        timeout=5,
    )
    return result.returncode == 0
