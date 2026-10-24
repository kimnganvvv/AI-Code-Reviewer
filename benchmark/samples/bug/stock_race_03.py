from .models import Order, OrderDetail, Product


def place_order(user, product_id, quantity):
    product = Product.objects.filter(pk=product_id, active=True).first()
    if product is None:
        raise ValueError("Sản phẩm không tồn tại")
    if product.stock < quantity:
        raise ValueError("Không đủ tồn kho")

    product.stock -= quantity
    product.save()

    order = Order.objects.create(user=user, total_amount=product.price * quantity)
    OrderDetail.objects.create(order=order, product=product, quantity=quantity)
    return order
