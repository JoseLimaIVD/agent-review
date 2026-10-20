from __future__ import annotations

from pathlib import PurePosixPath

# Built bundles, minified scripts and source maps are kept as reviewable files but never parsed into symbols: a single
# committed bundle yields thousands of anonymous callables and megabytes of source that crowd out the reviewed code.
BUNDLE_EXTENSIONS = {".js", ".mjs", ".cjs", ".jsx", ".css"}
MAX_LINE = 5000
AVERAGE_LINE = 200
MIN_AVERAGED_BYTES = 10_000


def is_generated_source(path: str, content: bytes | str | None) -> bool:
    pure = PurePosixPath(path.replace("\\", "/"))
    name = pure.name.lower()
    if name.endswith(".map") or any(f".min{suffix}" in name for suffix in BUNDLE_EXTENSIONS):
        return True
    if pure.suffix.lower() not in BUNDLE_EXTENSIONS or not content:
        return False
    text = content.decode("utf-8", errors="replace") if isinstance(content, bytes) else content
    lines = text.splitlines() or [""]
    longest = max(len(line) for line in lines)
    average = len(text) / len(lines)
    # Hand-written code rarely averages 200+ characters a line; minified output does even when the file is small.
    return longest >= MAX_LINE or (average >= AVERAGE_LINE and (longest >= 1000 or len(text) >= MIN_AVERAGED_BYTES))


def generated_paths(baseline: dict[str, bytes], current: dict[str, bytes]) -> set[str]:
    return {path for path in set(baseline) | set(current)
            if is_generated_source(path, current.get(path) if current.get(path) is not None else baseline.get(path))}
