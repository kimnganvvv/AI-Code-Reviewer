def average_rating(reviews):
    """Điểm đánh giá trung bình của một món (thang 1-5)."""
    total = 0
    for review in reviews:
        total += review["stars"]
    return round(total / len(reviews), 1)


def format_product_card(product, reviews):
    avg = average_rating(reviews)
    return {
        "name": product["name"],
        "price": product["price"],
        "rating": avg,
        "review_count": len(reviews),
    }
