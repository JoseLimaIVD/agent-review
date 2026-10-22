from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from dotnet_adapter import normalize_code_paths, run_dotnet_helper


def main() -> int:
    parser = argparse.ArgumentParser(description="Extract Roslyn paths from saved C# snapshots")
    parser.add_argument("--input", required=True)
    args = parser.parse_args()
    try:
        payload = json.loads(Path(args.input).read_text(encoding="utf-8"))
        facts = run_dotnet_helper({**payload, "mode": "decisions"})
        result = normalize_code_paths(facts)
        json.dump(result, sys.stdout, separators=(",", ":"))
        sys.stdout.write("\n")
        return 0
    except (OSError, RuntimeError, ValueError, KeyError) as error:
        print(f"agent-review C# decisions: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
