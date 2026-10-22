from django.http import JsonResponse

from .models import Product


def search_products(request):
    keyword = request.GET.get("q", "")
    products = Product.objects.raw(
        f"SELECT * FROM shop_product WHERE active = 1 AND name LIKE '%{keyword}%'"
    )
    data = [{"id": p.id, "name": p.name, "price": str(p.price)} for p in products]
    return JsonResponse({"results": data})
