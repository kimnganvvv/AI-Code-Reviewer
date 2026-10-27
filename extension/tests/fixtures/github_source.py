# -*- coding: utf-8 -*-  # noqa: UP009
"""Fixture GitHub: Tiếng Việt ✓

Dòng trống và khoảng trắng cuối dòng.
"""


def render(command):
	if not command:
		return ""
	value = """line one  
line two"""
	return value + command  # trailing space 
