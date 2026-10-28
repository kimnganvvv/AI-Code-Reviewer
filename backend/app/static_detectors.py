"""Tầng 1c: bộ phát hiện tự viết dựa trên `ast` (không LLM, không gọi mạng).

Bộ phát hiện mà Bandit/Ruff không phủ:
- NEST001 : khối điều khiển lồng nhau quá STATIC_MAX_NESTING cấp.
- DUP001  : hàm có thân trùng cấu trúc với hàm khác (clone loại 2).
- DUP002  : KHỐI lệnh liên tiếp (>= STATIC_MIN_DUP_BLOCK câu lệnh) lặp lại giữa các hàm.
- ML001   : data leakage, fit_transform/fit+transform trên toàn bộ dữ liệu rồi mới train_test_split.
- DJ001   : Model.objects.get(...) không bắt DoesNotExist.
- DJ002   : request.GET[...] / request.POST[...] không bắt KeyError (MultiValueDictKeyError).
- OBO001  : chỉ số vượt biên (x[len(x)], range(len(x)+1) rồi x[i], x[i+1] trong range(len(x))).
- OBO002  : lô dữ liệu bị bỏ phần dư / lát cắt ngắn một phần tử (range(len(x)//n), x[i:i+n-1]...).
- SQL001  : giá trị không tin cậy được nối/format vào câu SQL rồi mới execute (kể cả gián tiếp qua biến).
- SQL002  : hàm đưa thẳng tham số vào execute() mà không tham số hóa (độ tin cậy thấp).
- SQL003  : truyền trạng thái query có taint qua các helper trả về SQL rồi tới execute().
- PATH001 : giá trị không tin cậy đi vào open()/send_file()... mà không có realpath/commonpath/secure_filename.
- DIV001  : chia trực tiếp cho 0 hoặc cho len(collection) không được bảo vệ khi collection rỗng.
- IDOR001 : view Django đã đăng nhập truy vấn object theo ID mà không ràng buộc chủ sở hữu.
- RACE001 : kiểm tra rồi cập nhật trường số dư/tồn kho trên ORM object mà không khóa hàng.

Taint ở đây là phân tích NHẸ trong phạm vi một hàm (tham số + request.* + input() + sys.argv),
nên mọi ứng viên SQL/PATH đều để Tầng 2 (LLM) phán quyết cuối cùng.

Giới hạn đã biết: DUP002 so khớp chính xác tên hàm/lớp được gọi (không chuẩn hóa tên import), nên hai
view dùng hai Model khác nhau sẽ không bị coi là trùng.
"""

import ast
import copy
import re
from collections.abc import Iterable, Iterator

from .config import (
    STATIC_MAX_NESTING,
    STATIC_MIN_DUP_BLOCK,
    STATIC_MIN_DUP_STMTS,
    USE_STATIC,
)

_BLOCKS = (ast.If, ast.For, ast.AsyncFor, ast.While, ast.Try, ast.With, ast.AsyncWith)
if hasattr(ast, "TryStar"):
    _BLOCKS += (ast.TryStar,)
if hasattr(ast, "Match"):
    _BLOCKS += (ast.Match,)

_FUNCS = (ast.FunctionDef, ast.AsyncFunctionDef)
_SCOPE_BREAK = _FUNCS + (ast.ClassDef, ast.Lambda)


def _candidate(
    rule_id: str, line: int, severity: str, confidence: str, message: str, explanation: str,
    *, type_: str = "quality", cwe_id: str | None = None, end_line: int | None = None,
    suggestion: str = "",
) -> dict:
    return {
        "tool": "static",
        "rule_id": rule_id,
        "line": line,
        "end_line": max(end_line or line, line),
        "type": type_,
        "severity": severity,
        "confidence": confidence,
        "cwe_id": cwe_id,
        "message": message,
        "explanation": explanation,
        "suggestion": suggestion,
    }


# ---------------------------------------------------------------------------
# Tiện ích AST dùng chung
# ---------------------------------------------------------------------------
def _last_name(node: ast.AST) -> str | None:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    return None


def _call_name(call: ast.Call) -> str | None:
    return _last_name(call.func)


def _root_name(node: ast.AST) -> str | None:
    while isinstance(node, (ast.Attribute, ast.Subscript, ast.Call)):
        node = node.func if isinstance(node, ast.Call) else node.value
    return node.id if isinstance(node, ast.Name) else None


def _load_names(node: ast.AST) -> set[str]:
    return {n.id for n in ast.walk(node) if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load)}


def _target_names(t: ast.AST) -> list[str]:
    if isinstance(t, ast.Name):
        return [t.id]
    if isinstance(t, (ast.Tuple, ast.List)):
        return [x for e in t.elts for x in _target_names(e)]
    if isinstance(t, ast.Starred):
        return _target_names(t.value)
    return []


def _iter_scope(body: list[ast.stmt]) -> Iterator[ast.AST]:
    """Duyệt mọi nút trong một phạm vi theo thứ tự tài liệu, KHÔNG đi vào hàm/lớp/lambda lồng nhau
    (bản thân nút def vẫn được trả ra)."""
    stack = list(reversed(body))
    while stack:
        n = stack.pop()
        yield n
        if isinstance(n, _SCOPE_BREAK):
            continue
        stack.extend(reversed(list(ast.iter_child_nodes(n))))


def _func_params(f: ast.AST) -> set[str]:
    a = f.args  # type: ignore[attr-defined]
    names = {x.arg for x in a.posonlyargs + a.args + a.kwonlyargs}
    if a.vararg:
        names.add(a.vararg.arg)
    if a.kwarg:
        names.add(a.kwarg.arg)
    return names - {"self", "cls"}


def _scopes(tree: ast.Module) -> Iterator[tuple[list[ast.stmt], set[str]]]:
    """(thân phạm vi, tập tham số). Module trước, rồi từng hàm (kể cả hàm lồng nhau, phương thức)."""
    yield tree.body, set()
    for f in ast.walk(tree):
        if isinstance(f, _FUNCS):
            yield f.body, _func_params(f)


def _is_len_call(node: ast.AST) -> str | None:
    """len(X) với X là Name -> trả 'X'; ngược lại None."""
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "len" \
            and len(node.args) == 1 and isinstance(node.args[0], ast.Name):
        return node.args[0].id
    return None


def _const_int(node: ast.AST) -> int | None:
    if isinstance(node, ast.Constant) and isinstance(node.value, int) and not isinstance(node.value, bool):
        return node.value
    return None


# ---------------------------------------------------------------------------
# NEST001 - độ sâu lồng
# ---------------------------------------------------------------------------
def _is_elif(node: ast.If) -> bool:
    """`elif` là If lồng trong orelse nhưng cùng cột với `if` cha; `else: if` thì thụt vào."""
    return len(node.orelse) == 1 and isinstance(node.orelse[0], ast.If) and node.orelse[0].col_offset == node.col_offset


def _walk(body: list[ast.stmt], level: int, state: dict, nested: list[ast.AST]) -> None:
    """Duyệt một phạm vi. `level` = số khối điều khiển bao quanh. Hàm/lớp lồng nhau là phạm vi riêng."""
    for st in body:
        if isinstance(st, _FUNCS + (ast.ClassDef,)):
            nested.append(st)
            continue
        if not isinstance(st, _BLOCKS):
            continue
        lvl = level + 1
        state["max"] = max(state["max"], lvl)
        if lvl > STATIC_MAX_NESTING and state["first"] is None:
            state["first"] = st.lineno
        if isinstance(st, ast.If):
            _walk(st.body, lvl, state, nested)
            _walk(st.orelse, level if _is_elif(st) else lvl, state, nested)  # elif cùng cấp với if
        elif isinstance(st, ast.Try) or (hasattr(ast, "TryStar") and isinstance(st, ast.TryStar)):
            _walk(st.body, lvl, state, nested)
            for h in st.handlers:
                _walk(h.body, lvl, state, nested)
            _walk(st.orelse, lvl, state, nested)
            _walk(st.finalbody, lvl, state, nested)
        elif hasattr(ast, "Match") and isinstance(st, ast.Match):
            for case in st.cases:
                _walk(case.body, lvl, state, nested)
        else:  # For / AsyncFor / While / With / AsyncWith
            _walk(st.body, lvl, state, nested)
            _walk(getattr(st, "orelse", []), lvl, state, nested)


def detect_deep_nesting(tree: ast.Module) -> list[dict]:
    out: list[dict] = []
    scopes: list[tuple[str, list[ast.stmt]]] = [("<module>", tree.body)]
    while scopes:
        name, body = scopes.pop()
        state = {"max": 0, "first": None}
        nested: list[ast.AST] = []
        _walk(body, 0, state, nested)
        if state["first"] is not None:
            where = "mức module" if name == "<module>" else f"'{name}'"
            out.append(_candidate(
                "NEST001", state["first"], "medium" if state["max"] > STATIC_MAX_NESTING + 1 else "low", "high",
                f"Khối lồng nhau {state['max']} cấp (> {STATIC_MAX_NESTING}) trong {where}",
                f"Static NEST001: độ sâu lồng tối đa {state['max']} cấp, vượt ngưỡng {STATIC_MAX_NESTING}; "
                f"khối đầu tiên vượt ngưỡng bắt đầu ở dòng {state['first']}.",
            ))
        for n in nested:
            scopes.append((n.name, n.body))  # type: ignore[attr-defined]
    return out


# ---------------------------------------------------------------------------
# DUP001 - hàm trùng lặp
# ---------------------------------------------------------------------------
def _local_names(func: ast.AST) -> list[str]:
    """Tên cục bộ theo thứ tự xuất hiện đầu tiên (tham số, biến gán, biến except)."""
    names: list[str] = []
    declared_outer = set()
    a = func.args  # type: ignore[attr-defined]
    for arg in a.posonlyargs + a.args + a.kwonlyargs + ([a.vararg] if a.vararg else []) + ([a.kwarg] if a.kwarg else []):
        names.append(arg.arg)
    for n in ast.walk(func):
        if isinstance(n, (ast.Global, ast.Nonlocal)):
            declared_outer.update(n.names)
        elif isinstance(n, ast.Name) and isinstance(n.ctx, (ast.Store, ast.Del)):
            names.append(n.id)
        elif isinstance(n, ast.ExceptHandler) and n.name:
            names.append(n.name)
    seen, ordered = set(), []
    for x in names:
        if x not in seen and x not in declared_outer:
            seen.add(x)
            ordered.append(x)
    return ordered


class _Normalizer(ast.NodeTransformer):
    """Đổi tên biến CỤC BỘ thành v0, v1... và hằng số thành tên kiểu. Tên toàn cục/builtin/import giữ nguyên
    (nếu đổi hết thì `len(x)` và `str(x)` sẽ bị coi là một)."""

    def __init__(self, mapping: dict[str, str]):
        self.mapping = mapping

    def visit_Name(self, node: ast.Name):
        node.id = self.mapping.get(node.id, node.id)
        return node

    def visit_arg(self, node: ast.arg):
        node.arg = self.mapping.get(node.arg, node.arg)
        node.annotation = None
        return node

    def visit_ExceptHandler(self, node: ast.ExceptHandler):
        if node.name:
            node.name = self.mapping.get(node.name, node.name)
        self.generic_visit(node)
        return node

    def visit_Constant(self, node: ast.Constant):
        return ast.copy_location(ast.Constant(value=f"<{type(node.value).__name__}>"), node)


def _fingerprint(func: ast.AST) -> str:
    mapping = {name: f"v{i}" for i, name in enumerate(_local_names(func))}
    body = copy.deepcopy(func.body)  # type: ignore[attr-defined]
    if body and isinstance(body[0], ast.Expr) and isinstance(getattr(body[0], "value", None), ast.Constant) \
            and isinstance(body[0].value.value, str):
        body = body[1:]  # bỏ docstring
    norm = _Normalizer(mapping)
    body = [norm.visit(n) for n in body]
    a = func.args  # type: ignore[attr-defined]
    n_args = len(a.posonlyargs) + len(a.args) + len(a.kwonlyargs) + bool(a.vararg) + bool(a.kwarg)
    return f"{n_args}|" + "|".join(ast.dump(n) for n in body)


def _stmt_count(func: ast.AST) -> int:
    return sum(isinstance(n, ast.stmt) for n in ast.walk(func)) - 1


def detect_duplicate_functions(tree: ast.Module) -> list[dict]:
    groups: dict[str, list[ast.AST]] = {}
    for node in ast.walk(tree):
        if isinstance(node, _FUNCS) and _stmt_count(node) >= STATIC_MIN_DUP_STMTS:
            groups.setdefault(_fingerprint(node), []).append(node)

    out: list[dict] = []
    for funcs in groups.values():
        if len(funcs) < 2:
            continue
        funcs.sort(key=lambda n: n.lineno)
        first = funcs[0]
        for dup in funcs[1:]:
            out.append(_candidate(
                "DUP001", dup.lineno, "low", "medium",
                f"Hàm '{dup.name}' trùng cấu trúc với hàm '{first.name}' (dòng {first.lineno})",  # type: ignore[attr-defined]
                f"Static DUP001: thân hàm '{dup.name}' giống '{first.name}' sau khi chuẩn hóa tên biến cục bộ "
                f"và hằng số ({_stmt_count(dup)} câu lệnh).",
            ))
    return out


# ---------------------------------------------------------------------------
# DUP002 - khối lệnh lặp lại giữa các hàm (một phần thân hàm)
# ---------------------------------------------------------------------------
def _body_without_doc(func: ast.AST) -> list[ast.stmt]:
    body = list(func.body)  # type: ignore[attr-defined]
    if body and isinstance(body[0], ast.Expr) and isinstance(getattr(body[0], "value", None), ast.Constant) \
            and isinstance(body[0].value.value, str):
        body = body[1:]
    return body


def _stmt_weight(stmt: ast.AST) -> int:
    return sum(isinstance(n, ast.stmt) for n in ast.walk(stmt))


class _WindowNormalizer(ast.NodeTransformer):
    def __init__(self, mapping: dict[str, str]):
        self.mapping = mapping

    def visit_Name(self, node: ast.Name):
        node.id = self.mapping.get(node.id, node.id)
        return node

    def visit_ExceptHandler(self, node: ast.ExceptHandler):
        if node.name:
            node.name = self.mapping.get(node.name, node.name)
        self.generic_visit(node)
        return node

    def visit_Constant(self, node: ast.Constant):
        return ast.copy_location(ast.Constant(value=f"<{type(node.value).__name__}>"), node)


def _window_fingerprint(stmts: list[ast.stmt], params: set[str]) -> str:
    """Đổi tên biến được GÁN trong cửa sổ (và tham số của hàm) theo thứ tự xuất hiện; hằng số -> tên kiểu."""
    cp = copy.deepcopy(stmts)
    order: list[str] = []
    for s in cp:
        for n in ast.walk(s):
            if isinstance(n, ast.Name) and (isinstance(n.ctx, ast.Store) or n.id in params) and n.id not in order:
                order.append(n.id)
    norm = _WindowNormalizer({nm: f"v{i}" for i, nm in enumerate(order)})
    return "|".join(ast.dump(norm.visit(s)) for s in cp)


def detect_duplicate_blocks(tree: ast.Module) -> list[dict]:
    funcs = sorted((f for f in ast.walk(tree) if isinstance(f, _FUNCS)), key=lambda f: f.lineno)
    if len(funcs) < 2:
        return []
    win = max(2, STATIC_MIN_DUP_BLOCK)
    whole = [_fingerprint(f) if _stmt_count(f) >= STATIC_MIN_DUP_STMTS else None for f in funcs]
    bodies: list[list[ast.stmt]] = []
    index: dict[str, list[tuple[int, int]]] = {}
    for fi, f in enumerate(funcs):
        params = _func_params(f)
        body = _body_without_doc(f)
        bodies.append(body)
        for s in range(len(body) - win + 1):
            chunk = body[s:s + win]
            if sum(_stmt_weight(x) for x in chunk) < win:
                continue
            if not any(isinstance(n, ast.Call) for x in chunk for n in ast.walk(x)):
                continue  # chỉ gồm phép gán thuần/hằng: quá chung chung
            index.setdefault(_window_fingerprint(chunk, params), []).append((fi, s))

    shared: dict[tuple[int, int], set[int]] = {}  # (hàm sau, hàm trước) -> chỉ số câu lệnh trùng ở hàm sau
    for entries in index.values():
        fis = sorted({fi for fi, _ in entries})
        if len(fis) < 2:
            continue
        for g, s in entries:
            partners = [fi for fi in fis if fi < g]
            if not partners:
                continue
            f = partners[0]
            if whole[g] is not None and whole[g] == whole[f]:
                continue  # đã có DUP001 cho cả hàm
            shared.setdefault((g, f), set()).update(range(s, s + win))

    best: dict[int, tuple[int, set[int]]] = {}
    for (g, f), cov in shared.items():
        if len(cov) >= win and (g not in best or len(cov) > len(best[g][1])):
            best[g] = (f, cov)

    out: list[dict] = []
    for g, (f, cov) in sorted(best.items()):
        body = bodies[g]
        first_stmt, last_stmt = body[min(cov)], body[max(cov)]
        end = getattr(last_stmt, "end_lineno", None) or last_stmt.lineno
        out.append(_candidate(
            "DUP002", first_stmt.lineno, "low", "medium",
            f"Khối lệnh trong '{funcs[g].name}' lặp lại logic của '{funcs[f].name}' ({len(cov)} câu lệnh)",
            f"Static DUP002: {len(cov)} câu lệnh (dòng {first_stmt.lineno}-{end}) trong '{funcs[g].name}' trùng cấu trúc "
            f"với một đoạn trong '{funcs[f].name}' (dòng {funcs[f].lineno}) sau khi chuẩn hóa tên biến cục bộ và hằng số.",
            end_line=end,
        ))
    return out


# ---------------------------------------------------------------------------
# ML001 - data leakage: fit trên toàn bộ dữ liệu rồi mới tách train/test
# ---------------------------------------------------------------------------
_SPLIT_FUNCS = {"train_test_split"}


def detect_split_leakage(tree: ast.Module) -> list[dict]:
    out: list[dict] = []
    seen: set[int] = set()
    for body, _ in _scopes(tree):
        nodes = list(_iter_scope(body))
        fit_line: dict[str, int] = {}
        for n in nodes:
            if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr == "fit":
                r = _root_name(n.func.value)
                if r:
                    fit_line.setdefault(r, n.lineno)

        leaked: dict[str, int] = {}
        assigns = [x for x in nodes if isinstance(x, (ast.Assign, ast.AnnAssign)) and x.value is not None]
        for n in sorted(assigns, key=lambda x: (x.lineno, x.col_offset)):
            v = n.value
            targets = [t for tg in n.targets for t in _target_names(tg)] if isinstance(n, ast.Assign) \
                else _target_names(n.target)
            has_split = any(isinstance(c, ast.Call) and _call_name(c) in _SPLIT_FUNCS for c in ast.walk(v))
            line: int | None = None
            for c in ast.walk(v):
                if isinstance(c, ast.Call) and isinstance(c.func, ast.Attribute):
                    if c.func.attr == "fit_transform":
                        line = c.lineno
                        break
                    if c.func.attr == "transform":
                        r = _root_name(c.func.value)
                        if r in fit_line and fit_line[r] <= c.lineno:
                            line = fit_line[r]
                            break
            if line is None and not has_split:
                src = [leaked[x] for x in _load_names(v) if x in leaked]
                if src:
                    line = min(src)
            if line is not None:
                for t in targets:
                    leaked[t] = line

        for n in nodes:
            if isinstance(n, ast.Call) and _call_name(n) in _SPLIT_FUNCS:
                exprs = list(n.args) + [k.value for k in n.keywords]
                for e in exprs:
                    for nm in _load_names(e):
                        if nm in leaked and leaked[nm] <= n.lineno and leaked[nm] not in seen:
                            seen.add(leaked[nm])
                            out.append(_candidate(
                                "ML001", leaked[nm], "medium", "high",
                                "Data leakage: fit trên toàn bộ dữ liệu trước khi train_test_split",
                                f"Static ML001: '{nm}' được tạo bằng fit/fit_transform trên toàn bộ dữ liệu (dòng {leaked[nm]}) "
                                f"rồi mới tách train/test (dòng {n.lineno}). Thống kê của tập test bị lọt vào bước huấn luyện, "
                                f"làm số đo trên tập test cao ảo. Cách đúng: tách trước, fit bộ tiền xử lý chỉ trên tập train, "
                                f"rồi transform tập test (hoặc dùng sklearn Pipeline).",
                                type_="bug", end_line=n.lineno,
                            ))
    return out


# ---------------------------------------------------------------------------
# DJ001 / DJ002 - lỗi hay gặp trong Django
# ---------------------------------------------------------------------------
_DNE_GUARDS = {"DoesNotExist", "ObjectDoesNotExist", "Exception", "BaseException"}
_KEY_GUARDS = {"KeyError", "MultiValueDictKeyError", "LookupError", "Exception", "BaseException"}


class _GuardWalker(ast.NodeVisitor):
    """Duyệt AST và nhớ các `except` đang bao quanh nút hiện tại (chỉ trong thân `try`, reset khi vào hàm)."""

    def __init__(self) -> None:
        self.guards: list[set[str]] = []
        self.gets: list[ast.Call] = []
        self.subs: list[ast.Subscript] = []

    def _try(self, node) -> None:
        caught: set[str] = set()
        for h in node.handlers:
            if h.type is None:
                caught.add("*")
                continue
            for t in (h.type.elts if isinstance(h.type, ast.Tuple) else [h.type]):
                nm = _last_name(t)
                if nm:
                    caught.add(nm)
        self.guards.append(caught)
        for s in node.body:
            self.visit(s)
        self.guards.pop()
        for h in node.handlers:
            self.visit(h)
        for s in node.orelse + node.finalbody:
            self.visit(s)

    visit_Try = _try
    visit_TryStar = _try

    def _func(self, node) -> None:
        saved, self.guards = self.guards, []
        self.generic_visit(node)
        self.guards = saved

    visit_FunctionDef = _func
    visit_AsyncFunctionDef = _func
    visit_Lambda = _func

    def _protected(self, names: set[str]) -> bool:
        return any("*" in g or g & names for g in self.guards)

    def visit_Call(self, node: ast.Call) -> None:
        f = node.func
        if isinstance(f, ast.Attribute) and f.attr == "get" and isinstance(f.value, ast.Attribute) \
                and f.value.attr == "objects" and not self._protected(_DNE_GUARDS):
            self.gets.append(node)
        self.generic_visit(node)

    def visit_Subscript(self, node: ast.Subscript) -> None:
        v = node.value
        if isinstance(node.ctx, ast.Load) and isinstance(v, ast.Attribute) and v.attr in ("GET", "POST") \
                and _root_name(v) == "request" and not self._protected(_KEY_GUARDS):
            self.subs.append(node)
        self.generic_visit(node)


def detect_django_pitfalls(tree: ast.Module) -> list[dict]:
    w = _GuardWalker()
    w.visit(tree)
    out: list[dict] = []
    for c in w.gets:
        model = _root_name(c.func.value) or "Model"  # type: ignore[attr-defined]
        out.append(_candidate(
            "DJ001", c.lineno, "medium", "medium",
            f"{model}.objects.get() không bắt DoesNotExist/MultipleObjectsReturned",
            "Static DJ001: .get() ném DoesNotExist khi không có bản ghi (và MultipleObjectsReturned khi có nhiều bản ghi), "
            "làm view trả HTTP 500. Dùng get_object_or_404(), hoặc .filter(...).first() kèm kiểm tra None, "
            "hoặc bọc try/except Model.DoesNotExist.",
            type_="bug", end_line=getattr(c, "end_lineno", None),
        ))
    for s in w.subs:
        attr = s.value.attr  # type: ignore[attr-defined]
        out.append(_candidate(
            "DJ002", s.lineno, "low", "medium",
            f"request.{attr}[...] ném MultiValueDictKeyError khi thiếu khóa",
            f"Static DJ002: truy cập request.{attr}['khóa'] làm view lỗi 500 nếu client không gửi khóa đó. "
            f"Dùng request.{attr}.get('khóa') kèm giá trị mặc định/kiểm tra.",
            type_="bug",
        ))
    return out


# ---------------------------------------------------------------------------
# OBO001 / OBO002 - lỗi lệch một đơn vị, bỏ phần dư của lô
# ---------------------------------------------------------------------------
def _plus_const(node: ast.AST) -> tuple[str, int] | None:
    """len(X) + k  (k >= 1) hoặc k + len(X) -> ('X', k)."""
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        for a, b in ((node.left, node.right), (node.right, node.left)):
            x, k = _is_len_call(a), _const_int(b)
            if x and k is not None and k >= 1:
                return x, k
    return None


def _subscripts_of(body: Iterable[ast.AST], name: str) -> list[ast.Subscript]:
    return [n for s in body for n in ast.walk(s)
            if isinstance(n, ast.Subscript) and isinstance(n.value, ast.Name) and n.value.id == name]


def detect_off_by_one(tree: ast.Module) -> list[dict]:
    out: list[dict] = []
    seen: set[tuple[str, int]] = set()

    def add(
        rule: str, line: int, sev: str, conf: str, msg: str, expl: str,
        end: int | None = None, suggestion: str = "",
    ) -> None:
        if (rule, line) not in seen:
            seen.add((rule, line))
            out.append(_candidate(
                rule, line, sev, conf, msg, expl, type_="bug", end_line=end, suggestion=suggestion,
            ))

    for n in ast.walk(tree):
        # x[len(x)] luôn vượt chỉ số cuối
        if isinstance(n, ast.Subscript) and isinstance(n.value, ast.Name) and not isinstance(n.slice, ast.Slice):
            if _is_len_call(n.slice) == n.value.id and isinstance(n.ctx, ast.Load):
                add("OBO001", n.lineno, "medium", "high",
                    f"{n.value.id}[len({n.value.id})] vượt chỉ số cuối",
                    f"Static OBO001: chỉ số hợp lệ cuối cùng của '{n.value.id}' là len({n.value.id}) - 1; "
                    f"truy cập len({n.value.id}) luôn gây IndexError.")
        # lát cắt ngắn một phần tử: x[i:i+n-1]
        if isinstance(n, ast.Subscript) and isinstance(n.slice, ast.Slice):
            lo, up = n.slice.lower, n.slice.upper
            if isinstance(lo, ast.Name) and isinstance(up, ast.BinOp) and isinstance(up.op, ast.Sub) \
                    and _const_int(up.right) == 1 and lo.id in _load_names(up.left):
                add("OBO002", n.lineno, "medium", "low",
                    "Lát cắt ngắn hơn kích thước lô một phần tử",
                    f"Static OBO002: lát cắt [{lo.id}:...-1] bỏ sót phần tử cuối mỗi lô; "
                    f"nếu cần lô kích thước n thì dùng [{lo.id}:{lo.id}+n].", end=getattr(n, "end_lineno", None))

        if not (isinstance(n, ast.For) and isinstance(n.target, ast.Name) and isinstance(n.iter, ast.Call)
                and _call_name(n.iter) == "range" and n.iter.args):
            continue
        args = n.iter.args
        stop = args[1] if len(args) >= 2 else args[0]
        step = args[2] if len(args) == 3 else None
        var = n.target.id
        body_nodes = [x for s in n.body for x in ast.walk(s)]

        pc = _plus_const(stop)
        if pc:  # range(len(X) + k): X[var] vượt biên ở vòng cuối
            x, k = pc
            if any(isinstance(s.slice, ast.Name) and s.slice.id == var for s in _subscripts_of(n.body, x)):
                add("OBO001", n.lineno, "medium", "medium",
                    f"range(len({x}) + {k}) rồi truy cập {x}[{var}] vượt chỉ số cuối",
                    f"Static OBO001: vòng lặp chạy tới chỉ số len({x}) + {k} - 1 nhưng '{x}' chỉ có chỉ số tới len({x}) - 1, "
                    f"nên vòng cuối gây IndexError.", end=getattr(n, "end_lineno", None))

        if _is_len_call(stop):  # range(len(X)) mà dùng X[var + k]
            x = _is_len_call(stop)
            has_guard = any(isinstance(c, ast.Compare) and any(_is_len_call(z) or
                            (isinstance(z, ast.BinOp) and _is_len_call(z.left)) for z in [c.left] + c.comparators)
                            for c in body_nodes)
            for s in _subscripts_of(n.body, x):
                sl = s.slice
                if isinstance(sl, ast.BinOp) and isinstance(sl.op, ast.Add) and isinstance(sl.left, ast.Name) \
                        and sl.left.id == var and (_const_int(sl.right) or 0) >= 1 and not has_guard:
                    add("OBO001", s.lineno, "medium", "medium",
                        f"{x}[{var}+{_const_int(sl.right)}] vượt chỉ số cuối ở vòng lặp cuối",
                        f"Static OBO001: '{var}' chạy tới len({x}) - 1 nên '{x}[{var}+{_const_int(sl.right)}]' "
                        f"vượt biên ở vòng cuối và không thấy kiểm tra độ dài.")
                    break

        has_slice = any(isinstance(x, ast.Subscript) and isinstance(x.slice, ast.Slice) for x in body_nodes)
        if has_slice and isinstance(stop, ast.BinOp) and isinstance(stop.op, ast.FloorDiv) and _is_len_call(stop.left):
            add("OBO002", n.lineno, "medium", "low",
                "range(len(x) // n) bỏ phần dư của lô cuối",
                "Static OBO002: chia nguyên làm mất lô cuối khi len(x) không chia hết cho n. "
                "Dùng range(0, len(x), n) hoặc math.ceil(len(x) / n).", end=getattr(n, "end_lineno", None))
        if has_slice and step is not None and isinstance(stop, ast.BinOp) and isinstance(stop.op, ast.Sub) \
                and _is_len_call(stop.left):
            x = _is_len_call(stop.left)
            replacement = (
                f"{' ' * n.col_offset}for {var} in range({ast.unparse(args[0])}, "
                f"len({x}), {ast.unparse(step)}):"
            )
            add("OBO002", n.lineno, "medium", "low",
                "range(0, len(x) - k, step) bỏ sót lô cuối",
                "Static OBO002: cận trên len(x) - k làm vòng lặp dừng sớm, lô cuối không được xử lý. "
                "Dùng cùng điểm bắt đầu và step như hiện tại, nhưng đổi cận trên thành len(x) để xử lý cả lô cuối.",
                end=n.lineno, suggestion=replacement)
    return out


# ---------------------------------------------------------------------------
# SQL001 / SQL002 / PATH001 - taint nhẹ trong phạm vi một hàm
# ---------------------------------------------------------------------------
_SQL_SINKS = {"execute", "executemany", "executescript", "raw"}
_SQL_RE = re.compile(r"\b(select|insert|update|delete|drop|create|alter|replace)\b", re.IGNORECASE)
_PATH_SINKS = {"open", "send_file", "send_from_directory", "FileResponse", "remove", "unlink", "rmtree",
               "listdir", "rename", "read_text", "write_text", "read_bytes"}
_PATH_GUARDS = {"realpath", "resolve", "commonpath", "is_relative_to", "secure_filename", "basename", "safe_join"}
_CLEAN_CASTS = {"int", "float", "bool", "len", "UUID", "uuid4", "abs"}
_CHECK_METHODS = {"isdigit", "isalnum", "isalpha", "isidentifier", "isnumeric"}


def _is_source(node: ast.AST) -> bool:
    for n in ast.walk(node):
        if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == "input":
            return True
        if isinstance(n, ast.Attribute):
            r = _root_name(n)
            if r == "request" or (r == "sys" and n.attr == "argv"):
                return True
    return False


def _is_const_lookup(v: ast.AST) -> bool:
    """ALLOWED[x] / ALLOWED.get(x, ...) với ALLOWED viết HOA = tra bảng cố định -> kết quả đáng tin."""
    if isinstance(v, ast.Subscript) and isinstance(v.value, ast.Name) and v.value.id.isupper():
        return True
    return bool(isinstance(v, ast.Call) and isinstance(v.func, ast.Attribute) and v.func.attr == "get"
                and isinstance(v.func.value, ast.Name) and v.func.value.id.isupper())


def _sql_const(node: ast.AST) -> bool:
    return any(isinstance(c, ast.Constant) and isinstance(c.value, str) and _SQL_RE.search(c.value)
               for c in ast.walk(node))


def _dyn_str(node: ast.AST, tainted: set[str]) -> bool:
    """Biểu thức dựng chuỗi động (f-string, +, %, .format) có chứa giá trị tainted."""
    if isinstance(node, ast.JoinedStr):
        return any(isinstance(p, ast.FormattedValue) and (_load_names(p.value) & tainted or _is_source(p.value))
                   for p in node.values)
    if isinstance(node, ast.BinOp) and isinstance(node.op, (ast.Add, ast.Mod)):
        return bool(_load_names(node) & tainted or _is_source(node)) and any(
            isinstance(c, (ast.Constant, ast.JoinedStr)) for c in ast.walk(node))
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "format" \
            and isinstance(node.func.value, (ast.Constant, ast.JoinedStr)):
        return any(_load_names(a) & tainted or _is_source(a) for a in list(node.args) + [k.value for k in node.keywords])
    return False


def _sanitized_names(nodes: list[ast.AST]) -> set[str]:
    s: set[str] = set()
    for n in nodes:
        if isinstance(n, ast.Compare) and any(isinstance(o, (ast.In, ast.NotIn)) for o in n.ops):
            s |= _load_names(n.left)
        elif isinstance(n, ast.Call):
            nm = _call_name(n)
            if nm in _CHECK_METHODS and isinstance(n.func, ast.Attribute):
                s |= _load_names(n.func.value)
            elif nm in ("fullmatch", "match"):
                for a in n.args[1:]:
                    s |= _load_names(a)
    return s


def _taint_scope(body: list[ast.stmt], params: set[str], out: list[dict], seen: set[tuple[str, int]]) -> None:
    nodes = list(_iter_scope(body))
    sanitized = _sanitized_names(nodes)
    tainted: set[str] = set(params) - sanitized
    strong: set[str] = set()        # tainted có gốc từ request/input()/sys.argv (không chỉ là tham số)
    built: dict[str, int] = {}      # biến chứa câu SQL đã nối chuỗi động -> dòng dựng
    sqlish: set[str] = set()        # biến đang giữ chuỗi SQL hằng
    has_path_guard = any(isinstance(n, ast.Call) and _call_name(n) in _PATH_GUARDS for n in nodes)

    def emit(rule: str, line: int, sev: str, conf: str, msg: str, expl: str, cwe: str, end: int | None = None) -> None:
        if (rule, line) not in seen:
            seen.add((rule, line))
            out.append(_candidate(rule, line, sev, conf, msg, expl, type_="security", cwe_id=cwe, end_line=end))

    steps = [n for n in nodes if isinstance(n, (ast.Assign, ast.AnnAssign, ast.AugAssign, ast.For, ast.AsyncFor))]
    for n in sorted(steps, key=lambda x: (x.lineno, x.col_offset)):
        if isinstance(n, (ast.For, ast.AsyncFor)):
            if _load_names(n.iter) & tainted or _is_source(n.iter):
                tainted |= set(_target_names(n.target)) - sanitized
                if _load_names(n.iter) & strong or _is_source(n.iter):
                    strong |= set(_target_names(n.target)) - sanitized
            continue
        if isinstance(n, ast.AugAssign):
            if isinstance(n.target, ast.Name) and isinstance(n.op, ast.Add):
                t = n.target.id
                if _load_names(n.value) & tainted or _is_source(n.value):
                    if t in built or t in sqlish:
                        built.setdefault(t, n.lineno)
                    if t not in sanitized:
                        tainted.add(t)
                        if _load_names(n.value) & strong or _is_source(n.value):
                            strong.add(t)
            continue
        if n.value is None:
            continue
        v = n.value
        targets = [t for tg in n.targets for t in _target_names(tg)] if isinstance(n, ast.Assign) \
            else _target_names(n.target)
        if (isinstance(v, ast.Call) and _call_name(v) in _CLEAN_CASTS) or _is_const_lookup(v):
            tainted -= set(targets)
            strong -= set(targets)
            continue
        if isinstance(v, ast.Constant) and isinstance(v.value, str) and _SQL_RE.search(v.value):
            sqlish |= set(targets)
        hit = bool(_load_names(v) & tainted) or _is_source(v)
        if hit:
            tainted |= set(targets) - sanitized
            if _load_names(v) & strong or _is_source(v):
                strong |= set(targets) - sanitized
            if _dyn_str(v, tainted | set(params)) and _sql_const(v):
                for t in targets:
                    built[t] = n.lineno

    for n in nodes:
        if not isinstance(n, ast.Call):
            continue
        name = _call_name(n)
        end = getattr(n, "end_lineno", None) or n.lineno
        # ---- SQL
        if name in _SQL_SINKS and isinstance(n.func, ast.Attribute) and n.args:
            q = n.args[0]
            if _dyn_str(q, tainted):
                emit("SQL001", n.lineno, "high", "medium",
                     "Giá trị không tin cậy được nối/format thẳng vào câu SQL",
                     "Static SQL001: câu truy vấn được dựng bằng nối chuỗi/f-string/format từ tham số hoặc đầu vào "
                     "request rồi truyền vào execute(). Dùng truy vấn tham số hóa (placeholder ? hoặc %s).", "CWE-89", end)
            elif isinstance(q, ast.Name) and q.id in built:
                emit("SQL001", built[q.id], "high", "medium",
                     "Câu SQL dựng bằng nối chuỗi từ dữ liệu không tin cậy rồi mới execute",
                     f"Static SQL001: '{q.id}' được dựng ở dòng {built[q.id]} bằng nối chuỗi/f-string/format từ tham số hoặc "
                     f"đầu vào request, rồi được thực thi ở dòng {n.lineno}. Dùng truy vấn tham số hóa; tên bảng/cột cần allow-list.",
                     "CWE-89", n.lineno)
            elif isinstance(q, ast.Name) and q.id in params and q.id not in sanitized:
                emit("SQL002", n.lineno, "medium", "low",
                     f"Hàm thực thi thẳng câu SQL nhận từ tham số '{q.id}'",
                     f"Static SQL002: '{q.id}' là tham số của hàm và được truyền thẳng vào {name}() mà không có tham số hóa "
                     f"tại đây. Nếu nơi gọi nối chuỗi từ đầu vào người dùng thì đây là SQL injection gián tiếp; "
                     f"cần kiểm tra các điểm gọi.", "CWE-89", n.lineno)
        # ---- Path traversal
        if name in _PATH_SINKS and not has_path_guard:
            exprs: list[ast.AST] = list(n.args) + [k.value for k in n.keywords]
            if name in ("read_text", "write_text", "read_bytes") and isinstance(n.func, ast.Attribute):
                exprs.append(n.func.value)
            if any((_load_names(e) & tainted) or _is_source(e) for e in exprs):
                is_strong = any((_load_names(e) & strong) or _is_source(e) for e in exprs)
                emit("PATH001", n.lineno, "high" if is_strong else "medium", "medium" if is_strong else "low",
                     f"Đường dẫn từ dữ liệu không tin cậy đi vào {name}() mà không kiểm tra",
                     f"Static PATH001: đối số của {name}() xuất phát từ {'đầu vào request/input' if is_strong else 'tham số hàm (chưa rõ nguồn)'} và không thấy "
                     f"realpath/resolve + kiểm tra nằm trong thư mục cho phép (commonpath/is_relative_to) hay secure_filename. "
                     f"Kẻ tấn công có thể dùng '../' để đọc/ghi tệp ngoài thư mục dự kiến.", "CWE-22", end)


def detect_taint_sinks(tree: ast.Module) -> list[dict]:
    out: list[dict] = []
    seen: set[tuple[str, int]] = set()
    for body, params in _scopes(tree):
        _taint_scope(body, params, out, seen)
    return out


# ---------------------------------------------------------------------------
# DIV001 - phép chia có thể dùng độ dài của collection rỗng
# ---------------------------------------------------------------------------
def _truthy_len_names(test: ast.AST) -> set[str]:
    """Nhận diện các guard phổ biến: `if items` và `if len(items) > 0`."""
    if isinstance(test, ast.Name):
        return {test.id}
    if isinstance(test, ast.UnaryOp) and isinstance(test.op, ast.Not):
        return set()
    if isinstance(test, ast.Compare) and len(test.ops) == 1 and len(test.comparators) == 1:
        left, right, op = test.left, test.comparators[0], test.ops[0]
        if isinstance(op, (ast.Gt, ast.NotEq)) and _const_int(right) == 0:
            name = _is_len_call(left)
            if name:
                return {name}
        if isinstance(op, ast.Gt) and _const_int(left) == 0:
            name = _is_len_call(right)
            if name:
                return {name}
    if isinstance(test, ast.BoolOp) and isinstance(test.op, ast.And):
        return set().union(*(_truthy_len_names(v) for v in test.values))
    return set()


def detect_possible_zero_division(tree: ast.Module) -> list[dict]:
    """Bắt chia trực tiếp cho 0 hoặc len(collection) khi collection có thể rỗng."""
    out: list[dict] = []

    def walk(body: list[ast.stmt], guarded: set[str]) -> None:
        for stmt in body:
            if isinstance(stmt, ast.If):
                body_guard = guarded | _truthy_len_names(stmt.test)
                walk(stmt.body, body_guard)
                walk(stmt.orelse, guarded)
                continue
            if isinstance(stmt, _FUNCS + (ast.ClassDef,)):
                continue
            for node in ast.walk(stmt):
                if not isinstance(node, ast.BinOp) or not isinstance(node.op, (ast.Div, ast.FloorDiv, ast.Mod)):
                    continue
                if isinstance(node.op, ast.Mod) and isinstance(node.left, ast.Constant) \
                        and isinstance(node.left.value, (str, bytes)):
                    continue  # string formatting, not modulo arithmetic
                divisor = _const_int(node.right)
                collection = _is_len_call(node.right)
                if divisor != 0 and not collection:
                    continue
                if collection and collection in guarded:
                    continue
                suggestion = ""
                end_line = getattr(node, "end_lineno", None)
                # For a direct return of numerator / len(items), the result is
                # undefined for an empty collection. Fail explicitly instead
                # of inventing an arbitrary metric value such as 0.0.
                if (
                    collection
                    and isinstance(stmt, ast.Return)
                    and stmt.value is node
                    and stmt.lineno == getattr(stmt, "end_lineno", stmt.lineno) == node.lineno
                ):
                    indent = " " * stmt.col_offset
                    return_code = ast.unparse(stmt)
                    suggestion = (
                        f"{indent}if len({collection}) == 0:\n"
                        f"{indent}    raise ValueError(\"Cannot evaluate an empty collection\")\n"
                        f"{indent}{return_code}"
                    )
                    end_line = stmt.lineno
                out.append(_candidate(
                    "DIV001", node.lineno, "medium", "medium",
                    "Phép chia có thể gặp mẫu số bằng 0",
                    "Static DIV001: mẫu số là 0 hoặc len(collection); collection rỗng làm phép chia phát sinh ZeroDivisionError. "
                    "Kiểm tra collection rỗng trước khi chia hoặc xác định giá trị thay thế phù hợp.",
                    type_="bug", cwe_id="CWE-369", end_line=end_line, suggestion=suggestion,
                ))

    walk(tree.body, set())
    for fn in (n for n in ast.walk(tree) if isinstance(n, _FUNCS)):
        walk(fn.body, set())
    return out


# ---------------------------------------------------------------------------
# IDOR001 - truy vấn object theo ID mà không ràng buộc chủ sở hữu trong view đã đăng nhập
# ---------------------------------------------------------------------------
_OWNER_KEYS = {"user", "owner", "created_by", "account", "tenant", "organization"}


def _decorator_names(func: ast.AST) -> set[str]:
    names: set[str] = set()
    for dec in getattr(func, "decorator_list", []):
        name = _call_name(dec) if isinstance(dec, ast.Call) else _last_name(dec)
        if name:
            names.add(name)
    return names


def detect_django_idor(tree: ast.Module) -> list[dict]:
    out: list[dict] = []
    for fn in (n for n in ast.walk(tree) if isinstance(n, _FUNCS)):
        if "login_required" not in _decorator_names(fn):
            continue
        nodes = list(_iter_scope(fn.body))
        for call in nodes:
            if not isinstance(call, ast.Call) or _call_name(call) != "get_object_or_404":
                continue
            lookup = {k.arg for k in call.keywords if k.arg}
            if not lookup.intersection({"pk", "id", "uuid", "order_id", "object_id"}):
                continue
            if any(k.arg in _OWNER_KEYS for k in call.keywords):
                continue
            # A later explicit owner comparison also counts as authorization.
            object_names = {
                target
                for n in nodes if isinstance(n, (ast.Assign, ast.AnnAssign)) and n.value is call
                for target in (_target_names(n.targets[0]) if isinstance(n, ast.Assign) and n.targets
                               else _target_names(n.target) if isinstance(n, ast.AnnAssign) else [])
            }
            owner_checked = False
            for n in nodes:
                if not isinstance(n, ast.If):
                    continue
                for cmp in (x for x in ast.walk(n.test) if isinstance(x, ast.Compare)):
                    values = [cmp.left] + list(cmp.comparators)
                    has_object_owner = any(
                        isinstance(v, ast.Attribute) and v.attr in _OWNER_KEYS
                        and isinstance(v.value, ast.Name) and v.value.id in object_names
                        for v in values
                    )
                    has_request_user = any(
                        isinstance(v, ast.Attribute) and v.attr == "user"
                        and isinstance(v.value, ast.Name) and v.value.id == "request"
                        for v in values
                    )
                    if has_object_owner and has_request_user:
                        owner_checked = True
                        break
                if owner_checked:
                    break
            if owner_checked:
                continue
            out.append(_candidate(
                "IDOR001", call.lineno, "high", "medium",
                "View đã đăng nhập tải object theo ID nhưng chưa kiểm tra quyền sở hữu",
                "Static IDOR001: view yêu cầu đăng nhập nhưng truy vấn object chỉ theo ID và không thấy điều kiện chủ sở hữu "
                "(user/owner/account). Người dùng có thể thử ID của object thuộc tài khoản khác. Lọc truy vấn theo request.user "
                "hoặc kiểm tra quyền truy cập trước khi trả dữ liệu.",
                type_="security", cwe_id="CWE-639", end_line=getattr(call, "end_lineno", None),
            ))
    return out


# ---------------------------------------------------------------------------
# RACE001 - check-then-update trên cùng object lưu trữ mà không khóa hàng
# ---------------------------------------------------------------------------
_RESOURCE_FIELDS = {"stock", "quantity", "balance", "available", "inventory", "credits"}


def _attribute_key(node: ast.AST) -> tuple[str, str] | None:
    if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name):
        return node.value.id, node.attr
    return None


def detect_check_then_update_race(tree: ast.Module) -> list[dict]:
    out: list[dict] = []
    for fn in (n for n in ast.walk(tree) if isinstance(n, _FUNCS)):
        nodes = list(_iter_scope(fn.body))
        calls = [n for n in nodes if isinstance(n, ast.Call)]
        if any(_call_name(c) == "select_for_update" for c in calls):
            continue

        model_objects: set[str] = set()
        for n in nodes:
            if not isinstance(n, (ast.Assign, ast.AnnAssign)) or n.value is None:
                continue
            value_calls = [x for x in ast.walk(n.value) if isinstance(x, ast.Call)]
            if not any(_call_name(c) in {"get", "first", "last"} for c in value_calls):
                continue
            if not any(isinstance(x, ast.Attribute) and x.attr == "objects" for x in ast.walk(n.value)):
                continue
            targets = [t for tg in n.targets for t in _target_names(tg)] if isinstance(n, ast.Assign) \
                else _target_names(n.target)
            model_objects.update(targets)

        checked: set[tuple[str, str]] = set()
        for n in nodes:
            if not isinstance(n, ast.If):
                continue
            for cmp in (x for x in ast.walk(n.test) if isinstance(x, ast.Compare)):
                if not any(isinstance(op, (ast.Lt, ast.LtE)) for op in cmp.ops):
                    continue
                operands = [cmp.left] + list(cmp.comparators)
                attrs = [_attribute_key(x) for x in operands]
                for key in attrs:
                    if key and key[0] in model_objects and key[1] in _RESOURCE_FIELDS:
                        checked.add(key)

        updated: dict[tuple[str, str], int] = {}
        for n in nodes:
            if isinstance(n, ast.AugAssign):
                key = _attribute_key(n.target)
                if key and key in checked:
                    updated.setdefault(key, n.lineno)
            elif isinstance(n, (ast.Assign, ast.AnnAssign)):
                targets = n.targets if isinstance(n, ast.Assign) else [n.target]
                for target in targets:
                    key = _attribute_key(target)
                    if key and key in checked and any(_attribute_key(x) == key for x in ast.walk(n.value)):
                        updated.setdefault(key, n.lineno)

        for call in calls:
            if not isinstance(call.func, ast.Attribute) or call.func.attr != "save":
                continue
            receiver = call.func.value.id if isinstance(call.func.value, ast.Name) else None
            if not receiver:
                continue
            key = next((k for k in updated if k[0] == receiver), None)
            if key:
                out.append(_candidate(
                    "RACE001", updated[key], "high", "medium",
                    f"Cập nhật {key[1]} theo kiểu kiểm tra-rồi-ghi có thể bị race condition",
                    f"Static RACE001: '{receiver}.{key[1]}' được kiểm tra trước, sau đó giảm/cập nhật và lưu riêng; "
                    "hai request đồng thời có thể cùng vượt qua kiểm tra rồi bán/chi vượt số dư. Dùng transaction cùng "
                    "select_for_update() hoặc cập nhật có điều kiện nguyên tử.",
                    type_="bug", cwe_id="CWE-362", end_line=getattr(call, "end_lineno", None),
                ))
                break
    return out


# ---------------------------------------------------------------------------
# SQL interprocedural summaries - truyền trạng thái taint qua helper trả về query
# ---------------------------------------------------------------------------
def _expr_sql_state(node: ast.AST, tainted: set[str], sqlish: set[str], dynamic: set[str], summaries: dict):
    names = _load_names(node)
    calls = [n for n in ast.walk(node) if isinstance(n, ast.Call)]
    taint = bool(names & tainted) or _is_source(node)
    sql = _sql_const(node) or bool(names & sqlish)
    dyn = bool(names & dynamic)
    for call in calls:
        if isinstance(call.func, ast.Name) and call.func.id in summaries:
            s = summaries[call.func.id]
            taint = taint or s[0]
            sql = sql or s[1]
            dyn = dyn or s[2]
    has_string = any(isinstance(n, ast.Constant) and isinstance(n.value, str) for n in ast.walk(node))
    if taint and has_string:
        dyn = True
    for call in calls:
        if isinstance(call.func, ast.Attribute) and call.func.attr == "join":
            receiver_names = _load_names(call.func.value)
            if receiver_names & (tainted | dynamic):
                dyn = True
            if receiver_names & sqlish:
                sql = True
    return taint, sql, dyn


def _sql_function_summary(fn: ast.AST, summaries: dict, findings: list[dict] | None = None) -> tuple[bool, bool, bool]:
    params = _func_params(fn)
    tainted, sqlish, dynamic = set(params), set(), set()
    helper_derived: set[str] = set()
    nodes = sorted(_iter_scope(fn.body), key=lambda n: (getattr(n, "lineno", 0), getattr(n, "col_offset", 0)))
    for n in nodes:
        if isinstance(n, (ast.Assign, ast.AnnAssign)) and n.value is not None:
            value = n.value
            is_taint, is_sql, is_dynamic = _expr_sql_state(value, tainted, sqlish, dynamic, summaries)
            targets = [t for tg in n.targets for t in _target_names(tg)] if isinstance(n, ast.Assign) \
                else _target_names(n.target)
            if is_taint:
                tainted.update(targets)
            if is_sql:
                sqlish.update(targets)
            if is_dynamic:
                dynamic.update(targets)
            if any(isinstance(c.func, ast.Name) and c.func.id in summaries and summaries[c.func.id][2]
                   for c in ast.walk(value) if isinstance(c, ast.Call)):
                helper_derived.update(targets)
        elif isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr == "append" \
                and isinstance(n.func.value, ast.Name) and n.args:
            receiver = n.func.value.id
            is_taint, is_sql, is_dynamic = _expr_sql_state(n.args[0], tainted, sqlish, dynamic, summaries)
            if is_taint:
                tainted.add(receiver)
            if is_sql or (receiver in sqlish and is_taint):
                sqlish.add(receiver)
            if is_dynamic or (receiver in sqlish and is_taint):
                dynamic.add(receiver)
            if any(isinstance(c.func, ast.Name) and c.func.id in summaries and summaries[c.func.id][2]
                   for c in ast.walk(n.args[0]) if isinstance(c, ast.Call)) \
                    or bool(_load_names(n.args[0]) & helper_derived):
                helper_derived.add(receiver)
        elif isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) \
                and n.func.attr in _SQL_SINKS and n.args and findings is not None:
            is_taint, is_sql, is_dynamic = _expr_sql_state(n.args[0], tainted, sqlish, dynamic, summaries)
            derived = bool(_load_names(n.args[0]) & helper_derived) or any(
                isinstance(c.func, ast.Name) and c.func.id in summaries and summaries[c.func.id][2]
                for c in ast.walk(n.args[0]) if isinstance(c, ast.Call)
            )
            if derived and is_taint and is_sql and is_dynamic:
                findings.append(_candidate(
                    "SQL003", n.lineno, "high", "medium",
                    "Câu SQL chứa dữ liệu đầu vào được dựng qua helper và thực thi động",
                    "Static SQL003: dữ liệu từ tham số đi qua một hoặc nhiều hàm trợ giúp, được ghép vào câu SQL rồi "
                    "truyền tới execute() mà không dùng placeholder. Dùng truy vấn tham số hóa.",
                    type_="security", cwe_id="CWE-89", end_line=getattr(n, "end_lineno", None),
                ))

    returns_taint = returns_sql = returns_dynamic = False
    for n in nodes:
        if isinstance(n, ast.Return) and n.value is not None:
            is_taint, is_sql, is_dynamic = _expr_sql_state(n.value, tainted, sqlish, dynamic, summaries)
            returns_taint |= is_taint
            returns_sql |= is_sql and is_taint
            returns_dynamic |= is_dynamic and is_taint
    return returns_taint, returns_sql, returns_dynamic


def detect_interprocedural_sql(tree: ast.Module) -> list[dict]:
    funcs = {f.name: f for f in ast.walk(tree) if isinstance(f, _FUNCS)}
    summaries = {name: (False, False, False) for name in funcs}
    # Tính tới điểm cố định để hỗ trợ helper gọi helper, không phụ thuộc thứ tự định nghĩa.
    for _ in range(max(1, len(funcs))):
        changed = False
        for name, fn in funcs.items():
            found = _sql_function_summary(fn, summaries)
            merged = tuple(a or b for a, b in zip(summaries[name], found))
            if merged != summaries[name]:
                summaries[name] = merged
                changed = True
        if not changed:
            break
    out: list[dict] = []
    seen: set[int] = set()
    for fn in funcs.values():
        findings: list[dict] = []
        _sql_function_summary(fn, summaries, findings)
        for issue in findings:
            if issue["line"] not in seen:
                seen.add(issue["line"])
                out.append(issue)
    return out


# ---------------------------------------------------------------------------
_DETECTORS = (
    detect_deep_nesting, detect_duplicate_functions, detect_duplicate_blocks, detect_split_leakage,
    detect_django_pitfalls, detect_django_idor, detect_off_by_one, detect_taint_sinks,
    detect_interprocedural_sql, detect_possible_zero_division, detect_check_then_update_race,
)


def run_static(code: str) -> tuple[list[dict], str | None]:
    """Trả về (ứng viên, cảnh báo | None). Không bao giờ raise: một detector lỗi không làm hỏng các detector khác."""
    if not USE_STATIC or not code.strip():
        return [], None
    try:
        tree = ast.parse(code)
    except (SyntaxError, ValueError):
        return [], "Mã nguồn có lỗi cú pháp nên bộ phát hiện tự viết (ast) bị bỏ qua."
    out: list[dict] = []
    failed: list[str] = []
    for det in _DETECTORS:
        try:
            out += det(tree)
        except Exception:  # noqa: BLE001 - phòng thủ: detector hỏng chỉ bị bỏ qua
            failed.append(det.__name__)
    warning = f"Detector tự viết bị bỏ qua do lỗi nội bộ: {', '.join(failed)}." if failed else None
    return out, warning
