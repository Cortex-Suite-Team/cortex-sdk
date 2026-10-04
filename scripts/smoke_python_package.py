from __future__ import annotations

from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import venv
import zipfile


ROOT = Path(__file__).resolve().parents[1]
PY_DIR = ROOT / "python"


def run(command: list[str], *, cwd: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        cwd=cwd,
        check=True,
        text=True,
        capture_output=True,
    )


def find_artifacts() -> tuple[Path, Path]:
    dist_dir = PY_DIR / "dist"
    wheels = sorted(dist_dir.glob("*.whl"))
    sdists = sorted(dist_dir.glob("*.tar.gz"))
    if not wheels or not sdists:
        raise RuntimeError("Python build artifacts are missing; run `python -m build` first.")
    return wheels[-1], sdists[-1]


def assert_artifacts_include_py_typed(wheel: Path, sdist: Path) -> None:
    with zipfile.ZipFile(wheel) as archive:
        wheel_names = archive.namelist()
    if "cortex_sdk/py.typed" not in wheel_names:
        raise RuntimeError("Wheel is missing cortex_sdk/py.typed")

    with tarfile.open(sdist, "r:gz") as archive:
        sdist_names = archive.getnames()
    if not any(name.endswith("/cortex_sdk/py.typed") for name in sdist_names):
        raise RuntimeError("sdist is missing cortex_sdk/py.typed")


def run_smoke_install(artifact: Path) -> None:
    with tempfile.TemporaryDirectory(prefix="cortex-smoke-py-") as tmp:
        temp_dir = Path(tmp)
        venv_dir = temp_dir / "venv"
        venv.create(venv_dir, with_pip=True)
        python_bin = venv_dir / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")

        run([str(python_bin), "-m", "pip", "install", str(artifact)], cwd=temp_dir)

        smoke_path = temp_dir / "smoke.py"
        smoke_path.write_text(
            """from cortex_sdk import CortexClient, CortexError

assert callable(CortexClient), "CortexClient not exported"
assert issubclass(CortexError, Exception), "CortexError not exported"

client = CortexClient(api_key="test", on_message=lambda message: None)
assert isinstance(client.session_state, str)
assert isinstance(client.channel_state, str)
assert callable(client.upload_file)
assert callable(client.download_file)
assert callable(client.list_files)
assert callable(client.promote_file)

print("Python smoke test: OK")
""",
            encoding="utf-8",
        )
        run([str(python_bin), "smoke.py"], cwd=temp_dir)


def main() -> int:
    try:
        wheel, sdist = find_artifacts()
        assert_artifacts_include_py_typed(wheel, sdist)
        run_smoke_install(wheel)
        run_smoke_install(sdist)
    except (RuntimeError, subprocess.CalledProcessError, zipfile.BadZipFile, tarfile.TarError) as exc:
        print(str(exc), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
