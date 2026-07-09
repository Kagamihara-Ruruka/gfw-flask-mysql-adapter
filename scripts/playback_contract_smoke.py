"""Run playback timeline/frame-buffer contract tests."""

from pathlib import Path
import subprocess


def main() -> int:
    repo_root = Path(__file__).resolve().parents[1]
    test_file = repo_root / "tests" / "playback_contracts.test.mjs"
    return subprocess.call(
        ["node", "--test", str(test_file)],
        cwd=repo_root,
    )


if __name__ == "__main__":
    raise SystemExit(main())
