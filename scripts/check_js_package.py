from __future__ import annotations

import json
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile


ROOT = Path(__file__).resolve().parents[1]
JS_DIR = ROOT / "js"

FORBIDDEN_BROWSER_PATTERNS = ("node:", "from 'ws'", 'from "ws"', "require(")
FORBIDDEN_PACKAGE_PATH_PARTS = ("/src/", "/tests/")
FORBIDDEN_PACKAGE_SUFFIXES = ("mock-server.ts",)


def run(command: list[str], *, cwd: Path) -> subprocess.CompletedProcess[str]:
    executable = command[0]
    if sys.platform == "win32" and executable == "npm":
        command = [shutil.which("npm.cmd") or "npm.cmd", *command[1:]]
    return subprocess.run(
        command,
        cwd=cwd,
        check=True,
        text=True,
        capture_output=True,
    )


def assert_dist_entrypoints() -> None:
    required = [
        JS_DIR / "dist" / "browser" / "index.js",
        JS_DIR / "dist" / "browser" / "index.d.ts",
        JS_DIR / "dist" / "node" / "index.js",
        JS_DIR / "dist" / "node" / "index.d.ts",
        JS_DIR / "dist" / "types" / "index.d.ts",
    ]
    missing = [str(path) for path in required if not path.exists()]
    if missing:
        raise RuntimeError(f"Missing JS package artifacts: {missing}")


def assert_browser_dist_is_runtime_safe() -> None:
    browser_dir = JS_DIR / "dist" / "browser"
    for path in browser_dir.rglob("*.js"):
        contents = path.read_text(encoding="utf-8")
        for pattern in FORBIDDEN_BROWSER_PATTERNS:
            if pattern in contents:
                raise RuntimeError(f"Forbidden browser pattern {pattern!r} found in {path}")


def assert_node_entry_imports() -> None:
    run(
        [
            "node",
            "--input-type=module",
            "-e",
            (
                "const mod = await import('./dist/node/index.js');"
                "if (typeof mod.CortexClient !== 'function') throw new Error('CortexClient missing');"
                "if (typeof mod.CortexError !== 'function') throw new Error('CortexError missing');"
                "console.log('Node dist import OK');"
            ),
        ],
        cwd=JS_DIR,
    )


def create_tarball() -> Path:
    result = run(["npm", "pack", "--json"], cwd=JS_DIR)
    payload = json.loads(result.stdout)
    filename = payload[0]["filename"]
    return JS_DIR / filename


def assert_tarball_contents(tarball: Path) -> None:
    with tarfile.open(tarball, "r:gz") as archive:
        names = archive.getnames()
    for name in names:
        normalized = name.replace("\\", "/")
        if any(part in normalized for part in FORBIDDEN_PACKAGE_PATH_PARTS):
            raise RuntimeError(f"Forbidden package path found in npm tarball: {normalized}")
        if normalized.endswith(FORBIDDEN_PACKAGE_SUFFIXES):
            raise RuntimeError(f"Forbidden package file found in npm tarball: {normalized}")


def run_smoke_install(tarball: Path) -> None:
    with tempfile.TemporaryDirectory(prefix="cortex-smoke-js-") as tmp:
        temp_dir = Path(tmp)
        run(["npm", "init", "-y"], cwd=temp_dir)
        run(["npm", "install", str(tarball)], cwd=temp_dir)

        smoke_path = temp_dir / "smoke.mjs"
        smoke_path.write_text(
            """import { CortexClient, CortexError } from "@cortex-suite/sdk";
import { CortexClient as BrowserClient } from "@cortex-suite/sdk/browser";
import { CortexClient as NodeClient } from "@cortex-suite/sdk/node";

console.assert(typeof CortexClient === "function", "CortexClient not exported");
console.assert(typeof CortexError === "function", "CortexError not exported");
console.assert(typeof BrowserClient === "function", "Browser entry not exported");
console.assert(typeof NodeClient === "function", "Node entry not exported");

const client = new CortexClient({
  apiKey: "test",
  onMessage: () => {},
});
console.assert(typeof client.sessionState === "string", "sessionState should be a string");
console.assert(typeof client.channelState === "string", "channelState should be a string");
console.log("JS smoke test: OK");
""",
            encoding="utf-8",
        )

        run(["node", "smoke.mjs"], cwd=temp_dir)

        type_smoke_path = temp_dir / "smoke.ts"
        type_smoke_path.write_text(
            """import { CortexClient } from "@cortex-suite/sdk";

const client = new CortexClient({ apiKey: "test", onMessage: () => {} });
client.onMessage(() => {});
client.sendLogin({ login: "user", password: "secret" });
client.replyEscalation({ escalationId: "esc", waitToken: "wait", action: "continue" });
client.uploadFile(new Uint8Array());
client.mintSessionFileDownloadUrl("sf_test");
client.downloadFile("sf_test");
client.listFiles();
client.promoteFile("sf_test", { projectId: "project" });
void client.sessionContext;
void client.accessToken;
void client.cpApiUrl;
""",
            encoding="utf-8",
        )
        run(
            [
                "node",
                str(JS_DIR / "node_modules" / "typescript" / "bin" / "tsc"),
                "--strict",
                "--noEmit",
                "--target",
                "ES2022",
                "--module",
                "NodeNext",
                "--moduleResolution",
                "NodeNext",
                str(type_smoke_path),
            ],
            cwd=temp_dir,
        )


def main() -> int:
    tarball: Path | None = None
    try:
        assert_dist_entrypoints()
        assert_browser_dist_is_runtime_safe()
        assert_node_entry_imports()
        tarball = create_tarball()
        assert_tarball_contents(tarball)
        run_smoke_install(tarball)
    except subprocess.CalledProcessError as exc:
        if exc.stdout:
            print(exc.stdout, file=sys.stderr)
        if exc.stderr:
            print(exc.stderr, file=sys.stderr)
        print(str(exc), file=sys.stderr)
        return 1
    except (RuntimeError, json.JSONDecodeError) as exc:
        print(str(exc), file=sys.stderr)
        return 1
    finally:
        if tarball is not None and tarball.exists():
            tarball.unlink()
        package_lock = JS_DIR / "package-lock.json"
        if not package_lock.exists():
            shutil.rmtree(JS_DIR / "node_modules", ignore_errors=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
