from django.contrib.auth.decorators import login_required
from django.http import JsonResponse

from .models import Order


@login_required
def my_orders(request):
    orders = (
        Order.objects.filter(user=request.user)
        .prefetch_related("details__product")
        .order_by("-created_date")
    )
    data = []
    for order in orders:
        items = []
        for detail in order.details.all():
            items.append({
                "name": detail.product.name,
                "quantity": detail.quantity,
                "price": float(detail.product.price),
                "sub_total": float(detail.product.price) * detail.quantity,
            })
        data.append({
            "id": order.id,
            "created": order.created_date.strftime("%H:%M %d/%m/%Y"),
            "status": order.status,
            "items": items,
            "total": float(order.total_amount),
        })
    return JsonResponse(data, safe=False)


@login_required
def all_orders(request):
    if not request.user.is_staff:
        return JsonResponse({"error": "forbidden"}, status=403)

    orders = Order.objects.prefetch_related("details__product").order_by("-created_date")
    data = []
    for order in orders:
        items = []
        for detail in order.details.all():
            items.append({
                "name": detail.product.name,
                "quantity": detail.quantity,
                "price": float(detail.product.price),
                "sub_total": float(detail.product.price) * detail.quantity,
            })
        data.append({
            "id": order.id,
            "created": order.created_date.strftime("%H:%M %d/%m/%Y"),
            "status": order.status,
            "items": items,
            "total": float(order.total_amount),
        })
    return JsonResponse(data, safe=False)
