from django.shortcuts import render
from django.utils.safestring import mark_safe


def order_result(request):
    status = request.GET.get("status", "")
    note = request.GET.get("note", "")
    banner = mark_safe(f"<div class='alert'>Đơn hàng {status}: {note}</div>")
    return render(request, "orders/result.html", {"banner": banner})
