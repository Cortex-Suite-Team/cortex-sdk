from __future__ import annotations

from pathlib import Path
import shutil
import sys


ROOT = Path(__file__).resolve().parents[1]
JS_DIR = ROOT / "js"
DIST_DIR = JS_DIR / "dist"


def write_text(path: Path, contents: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(contents, encoding="utf-8")


def require_file(path: Path) -> None:
    if not path.exists():
        raise FileNotFoundError(f"Expected build artifact is missing: {path}")


def copy_tree_flattened(source_root: Path, target_root: Path) -> None:
    for source_path in source_root.rglob("*"):
        if source_path.is_dir():
            continue
        relative_path = source_path.relative_to(source_root)
        target_path = target_root / relative_path
        target_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source_path, target_path)


def rewrite_text_file(path: Path, replacements: dict[str, str]) -> None:
    if not (path.name.endswith(".js") or path.name.endswith(".d.ts")):
        return
    contents = path.read_text(encoding="utf-8")
    for old, new in replacements.items():
        contents = contents.replace(old, new)
    path.write_text(contents, encoding="utf-8")


def rebuild_runtime_tree(target_name: str, nested_name: str) -> None:
    source_dir = DIST_DIR / target_name
    require_file(source_dir / nested_name / "index.js")
    require_file(source_dir / "src" / "client.js")

    temp_dir = DIST_DIR / f"_{target_name}_staging"
    shutil.rmtree(temp_dir, ignore_errors=True)
    shutil.move(str(source_dir), temp_dir)

    target_dir = DIST_DIR / target_name
    target_dir.mkdir(parents=True, exist_ok=True)

    copy_tree_flattened(temp_dir / "src", target_dir)
    copy_tree_flattened(temp_dir / nested_name, target_dir)

    for path in target_dir.rglob("*"):
        rewrite_text_file(path, {"../src/": "./"})

    shutil.rmtree(temp_dir, ignore_errors=True)


def create_root_types() -> None:
    types_dir = DIST_DIR / "types"
    shutil.rmtree(types_dir, ignore_errors=True)
    root_types = """export { CortexClient, CortexError } from "../node/index.js";
export type * from "../node/index.js";
"""
    write_text(types_dir / "index.d.ts", root_types)


def main() -> int:
    try:
        rebuild_runtime_tree("browser", "browser")
        rebuild_runtime_tree("node", "node")
        create_root_types()
    except FileNotFoundError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
