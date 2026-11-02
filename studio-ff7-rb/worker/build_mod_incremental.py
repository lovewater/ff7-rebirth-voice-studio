#!/usr/bin/env python3
"""Explicit incremental packaging. Invoke only when the user requests 增量."""
import sys


def main():
    if '--full' in sys.argv[1:]:
        raise SystemExit('增量专用入口拒绝 --full；全量请由用户选择 build_mod.py --full')
    import build_mod
    sys.argv.insert(1, '--incremental')
    return build_mod.main()


if __name__ == '__main__':
    raise SystemExit(main())
