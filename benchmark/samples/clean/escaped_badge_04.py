from django.utils.html import escape
from django.utils.safestring import mark_safe

STATUS_COLORS = {
    "pending": "warning",
    "preparing": "info",
    "delivering": "primary",
    "completed": "success",
    "cancelled": "danger",
}


def status_badge(status, label):
    color = STATUS_COLORS.get(status, "secondary")
    return mark_safe(f'<span class="badge bg-{color}">{escape(label)}</span>')
