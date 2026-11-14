"""Rung 0: the pure core may use the OTel API but never the SDK or instrumentation.

import-linter rejects subpackages of external packages as forbidden modules, so
this clause is enforced statically here instead of in the layer contract.
"""

from __future__ import annotations

import ast
from pathlib import Path

USECASE_ROOT = Path(__file__).parents[2] / "src" / "template" / "usecase"
FORBIDDEN_PREFIXES = (
    "opentelemetry.sdk",
    "opentelemetry.exporter",
    "opentelemetry.instrumentation",
)


def _imported_modules(path: Path) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    modules: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            modules.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            modules.add(node.module)
    return modules


def test_usecase_imports_no_otel_sdk_exporter_or_instrumentation() -> None:
    offenders: list[str] = []
    for path in USECASE_ROOT.rglob("*.py"):
        for module in _imported_modules(path):
            if any(module == prefix or module.startswith(f"{prefix}.") for prefix in FORBIDDEN_PREFIXES):
                offenders.append(f"{path.relative_to(USECASE_ROOT)}: {module}")
    assert offenders == []
