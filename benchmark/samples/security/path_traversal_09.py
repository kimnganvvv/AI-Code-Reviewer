import os

from django.conf import settings
from django.http import FileResponse, Http404


def download_invoice(request):
    filename = request.GET.get("file", "")
    path = os.path.join(settings.INVOICE_DIR, filename)
    if not os.path.exists(path):
        raise Http404("Không tìm thấy hóa đơn")
    return FileResponse(open(path, "rb"), as_attachment=True)
