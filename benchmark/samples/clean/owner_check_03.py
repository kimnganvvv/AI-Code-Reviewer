from django.contrib.auth.decorators import login_required
from django.http import JsonResponse
from django.shortcuts import get_object_or_404

from .models import Order


@login_required
def order_detail(request, order_id):
    order = get_object_or_404(Order, pk=order_id, user=request.user)
    items = [
        {"product": d.product.name, "quantity": d.quantity}
        for d in order.details.select_related("product")
    ]
    return JsonResponse({
        "id": order.id,
        "status": order.status,
        "address": order.delivery_address,
        "items": items,
    })
