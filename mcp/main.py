from __future__ import annotations

import sys
from pathlib import Path

from clr_loader import get_coreclr
from pythonnet import set_runtime

set_runtime(get_coreclr())

import clr  # noqa: E402

_REPO_ROOT = Path(__file__).resolve().parents[1]
_DLL = (
    _REPO_ROOT
    / "core"
    / "Pupil.Core"
    / "bin"
    / "Release"
    / "net8.0"
    / "Pupil.Core.dll"
)


def main() -> None:
    if not _DLL.is_file():
        print(f"DLL not found: {_DLL}", file=sys.stderr)
        print(r"Build first: .\scripts\build-core.ps1", file=sys.stderr)
        sys.exit(1)

    clr.AddReference(str(_DLL.resolve()))
    from Pupil.Core import Hello  # noqa: PLC0415

    print(Hello.Say())


if __name__ == "__main__":
    main()
