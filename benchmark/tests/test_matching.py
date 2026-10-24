from src.matching import match_file


def pred(line, typ="security"):
    return {"line": line, "type": typ}


def gold(line, typ="security", **extra):
    return {"line": line, "type": typ, **extra}


def test_exact_line_is_tp():
    r = match_file([pred(10)], [gold(10)])
    assert (r.tp, r.fp, r.fn) == (1, 0, 0)


def test_tolerance_two_lines_matches_three_does_not():
    assert match_file([pred(12)], [gold(10)]).tp == 1
    r = match_file([pred(13)], [gold(10)])
    assert (r.tp, r.fp, r.fn) == (0, 1, 1)


def test_type_mismatch_is_fp_and_fn():
    r = match_file([pred(10, "bug")], [gold(10, "security")])
    assert (r.tp, r.fp, r.fn) == (0, 1, 1)


def test_also_lines_are_accepted():
    g = gold(27, also_lines=[8, 10])
    assert match_file([pred(9)], [g]).tp == 1


def test_end_line_range_for_function_level_issue():
    g = gold(1, "quality", end_line=27)
    assert match_file([pred(15, "quality")], [g]).tp == 1
    assert match_file([pred(30, "quality")], [g]).tp == 0


def test_one_gold_matches_only_one_prediction():
    r = match_file([pred(10), pred(10)], [gold(10)])
    assert (r.tp, r.fp, r.fn) == (1, 1, 0)


def test_clean_file_any_prediction_is_fp():
    r = match_file([pred(3)], [])
    assert (r.tp, r.fp, r.fn) == (0, 1, 0)


def test_no_predictions_all_missed():
    r = match_file([], [gold(5), gold(20)])
    assert (r.tp, r.fp, r.fn) == (0, 0, 2)


def test_malformed_predictions_are_fp_not_crash():
    r = match_file([{"line": "abc", "type": "security"}, "rác", {"type": "bug"}], [gold(5)])
    assert r.tp == 0 and r.fn == 1 and r.fp == 2  # chuỗi "rác" bị bỏ qua


def test_closest_prediction_is_chosen():
    r = match_file([pred(12), pred(10)], [gold(10)])
    assert r.tp == 1 and r.matched[0][0]["line"] == 10
