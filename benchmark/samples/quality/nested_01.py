def calculate_discount(order, user, coupon, is_holiday, is_weekend):
    discount = 0
    if order is not None:
        if order["total"] > 0:
            if user is not None:
                if user["is_member"]:
                    if order["total"] >= 500000:
                        discount = order["total"] * 0.15
                    else:
                        if order["total"] >= 200000:
                            discount = order["total"] * 0.10
                        else:
                            discount = order["total"] * 0.05
                else:
                    if coupon is not None:
                        if coupon["active"]:
                            if coupon["type"] == "percent":
                                discount = order["total"] * coupon["value"] / 100
                            else:
                                if coupon["type"] == "fixed":
                                    discount = coupon["value"]
                if is_holiday:
                    discount = discount * 1.2
                else:
                    if is_weekend:
                        discount = discount * 1.1
    return discount
