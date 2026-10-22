import json


def load_menu(path):
    f = open(path, encoding="utf-8")
    data = json.load(f)
    f.close()
    return data


def get_price(menu, item_name):
    for item in menu["items"]:
        if item["name"] == item_name:
            return item["price"]
    return None


if __name__ == "__main__":
    menu = load_menu("menu.json")
    print(get_price(menu, "Salmon nigiri"))
