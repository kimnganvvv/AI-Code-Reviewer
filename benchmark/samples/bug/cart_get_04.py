from django.contrib.auth.decorators import login_required
from django.shortcuts import render

from .models import Cart


@login_required
def current_cart(request):
    cart = Cart.objects.get(user=request.user, status="open")
    items = cart.items.select_related("product")
    total = sum(i.product.price * i.quantity for i in items)
    return render(request, "cart.html", {"cart": cart, "items": items, "total": total})
