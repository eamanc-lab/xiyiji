#!/usr/bin/env python3
import argparse
import hashlib
import json
import os
import shutil
import sys
from pathlib import Path


def log(message: str) -> None:
    print(f"[ydb-prewarm] {message}", file=sys.stderr, flush=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Prewarm yundingyunbo character cache")
    parser.add_argument("--ydb-base", required=True)
    parser.add_argument("--data-dir", required=True)
    parser.add_argument("--video", required=True)
    return parser.parse_args()


def ensure_runtime_paths(ydb_base: str) -> None:
    sys.path.insert(0, ydb_base)
    sys.path.insert(0, os.path.join(ydb_base, "live"))
    sys.path.insert(0, os.path.join(ydb_base, "bin", "image_infer_v2"))


def resolve_clone_video_local():
    import importlib

    main_module = importlib.import_module("main")
    for name in ("clone_video_local", "clone_video_local_v2"):
        candidate = getattr(main_module, name, None)
        if callable(candidate):
            return candidate, getattr(main_module, "initialize_environment", None)

    available = sorted(name for name in dir(main_module) if "clone" in name.lower())
    raise ImportError(
        "Neither clone_video_local nor clone_video_local_v2 is available in main; "
        f"available clone symbols: {available}"
    )


def cache_file(characters_base: str) -> str:
    return os.path.join(characters_base, "_cache.json")


def load_cache(characters_base: str) -> dict:
    cache_path = cache_file(characters_base)
    if not os.path.exists(cache_path):
        return {}
    with open(cache_path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def save_cache(characters_base: str, cache: dict) -> None:
    os.makedirs(characters_base, exist_ok=True)
    with open(cache_file(characters_base), "w", encoding="utf-8") as fh:
        json.dump(cache, fh, ensure_ascii=False, indent=2)


def video_hash(video_path: str) -> str:
    normalized = os.path.normpath(video_path)
    try:
        stat = os.stat(normalized)
        key = f"{Path(normalized).name}|{stat.st_size}|{int(stat.st_mtime * 1000)}"
    except OSError:
        key = Path(normalized).name
    return hashlib.md5(key.encode("utf-8")).hexdigest()[:16]


def validate_character_dir(data_dir: str) -> tuple[bool, str]:
    if not data_dir or not os.path.isdir(data_dir):
        return False, "character directory missing"

    params_path = os.path.join(data_dir, "params.json")
    frames_dir = os.path.join(data_dir, "frames")

    if not os.path.isfile(params_path):
        return False, "params.json missing"
    if not os.path.isdir(frames_dir):
        return False, "frames directory missing"

    try:
        if not any(True for _ in os.scandir(frames_dir)):
            return False, "frames directory is empty"
    except OSError as exc:
        return False, f"frames directory unreadable: {exc}"

    return True, ""


def purge_invalid_character_dir(characters_base: str, cache: dict, data_dir: str, reason: str) -> None:
    normalized = os.path.normcase(os.path.normpath(data_dir))
    for key, value in list(cache.items()):
        try:
            candidate = os.path.normcase(os.path.normpath(str(value)))
        except Exception:
            candidate = str(value)
        if candidate == normalized:
            del cache[key]

    if os.path.isdir(data_dir):
        shutil.rmtree(data_dir, ignore_errors=True)
        log(f"removed invalid cache: {data_dir} ({reason})")

    save_cache(characters_base, cache)


def find_cached_character_by_name(characters_base: str, cache: dict, video_path: str) -> str:
    stem = Path(video_path).stem.strip().lower()
    if not stem or not os.path.isdir(characters_base):
        return ""

    for entry in os.listdir(characters_base):
        data_dir = os.path.join(characters_base, entry)
        params_path = os.path.join(data_dir, "params.json")
        if not os.path.isdir(data_dir) or not os.path.isfile(params_path):
            continue

        try:
            with open(params_path, "r", encoding="utf-8") as fh:
                params = json.load(fh)
            name = str(params.get("name", "")).strip().lower()
        except Exception:
            continue

        if not name or (name != stem and not name.endswith(f"_{stem}") and stem not in name):
            continue

        valid, reason = validate_character_dir(data_dir)
        if not valid:
            purge_invalid_character_dir(characters_base, cache, data_dir, reason)
            continue

        return data_dir

    return ""


def ensure_character(ydb_base: str, data_dir: str, video_path: str) -> str:
    os.chdir(ydb_base)
    clone_video_local, initialize_environment = resolve_clone_video_local()

    if callable(initialize_environment):
        initialize_environment()

    characters_base = os.path.join(data_dir, "yundingyunbo_characters")
    os.makedirs(characters_base, exist_ok=True)
    cache = load_cache(characters_base)
    current_hash = video_hash(video_path)

    cached_dir = cache.get(current_hash, "")
    if cached_dir:
        valid, reason = validate_character_dir(cached_dir)
        if valid:
            return cached_dir
        purge_invalid_character_dir(characters_base, cache, cached_dir, reason)

    cached_by_name = find_cached_character_by_name(characters_base, cache, video_path)
    if cached_by_name:
        cache[current_hash] = cached_by_name
        save_cache(characters_base, cache)
        return cached_by_name

    last_reason = "unknown error"
    for attempt in range(2):
        model_id = clone_video_local(
            video_path=video_path,
            base_character_path=characters_base,
            name=Path(video_path).stem,
        )
        model_dir = os.path.join(characters_base, model_id)
        valid, reason = validate_character_dir(model_dir)
        if valid:
            cache[current_hash] = model_dir
            save_cache(characters_base, cache)
            return model_dir

        last_reason = reason
        purge_invalid_character_dir(characters_base, cache, model_dir, reason)
        log(
            "prewarm produced incomplete output "
            f"(attempt {attempt + 1}/2): {model_dir} ({reason})"
        )

    raise RuntimeError(f"character preprocessing failed: {last_reason}")


def main() -> int:
    args = parse_args()
    ydb_base = os.path.abspath(args.ydb_base)
    data_dir = os.path.abspath(args.data_dir)
    video_path = os.path.abspath(args.video)

    if not os.path.exists(video_path):
        raise FileNotFoundError(f"video not found: {video_path}")
    if not os.path.isdir(ydb_base):
        raise FileNotFoundError(f"ydb base not found: {ydb_base}")

    ensure_runtime_paths(ydb_base)
    os.environ["YUNDINGYUNBO_BASE"] = ydb_base
    os.environ["XIYIJI_DATA_DIR"] = data_dir

    model_dir = ensure_character(ydb_base, data_dir, video_path)
    print(json.dumps({"ok": True, "video": video_path, "data_dir": model_dir}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
