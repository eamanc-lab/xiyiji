#!/usr/bin/env python3
"""
yundingyunbo_bridge.py — NDJSON bridge between xiyiji's f2f pipeline and yundingyunbo's V2Manager.

Architecture (matches yundingyunbo native app):
  - Main thread: cv2.waitKey() event pump (required for OpenCV window rendering)
  - Stdin thread: reads NDJSON commands from Electron
  - Init thread: runs clone_video_local() + V2Manager creation (heavy, non-blocking)
"""

import sys
import os
import json
import hashlib
import pickle
import struct
import time
import re
import importlib
import threading
import traceback
import subprocess
import shutil
import argparse
import uuid
import queue as qmod
from contextlib import contextmanager
from pathlib import Path
import numpy as np

# ---------------------------------------------------------------------------
# Resolve yundingyunbo base path
# ---------------------------------------------------------------------------

def _to_windows_short_path(path: str) -> str:
    if os.name != 'nt' or not path:
        return path

    try:
        import ctypes

        buffer_size = 32768
        output = ctypes.create_unicode_buffer(buffer_size)
        result = ctypes.windll.kernel32.GetShortPathNameW(path, output, buffer_size)
        if result and output.value:
            return os.path.normpath(output.value)
    except Exception:
        pass

    return path


def _is_ascii_safe_path(path: str) -> bool:
    if not path:
        return False

    try:
        path.encode('ascii')
        return True
    except UnicodeEncodeError:
        return False


def _ensure_windows_runtime_alias(path: str, alias_prefix: str) -> str:
    normalized = os.path.normpath(os.path.abspath(path))
    if os.name != 'nt':
        return normalized

    short_path = _to_windows_short_path(normalized)
    if short_path and _is_ascii_safe_path(short_path):
        return short_path

    alias_roots = []
    public_dir = os.environ.get('PUBLIC', r'C:\Users\Public')
    for candidate_root in [
        os.environ.get('XIYIJI_RUNTIME_ALIAS_ROOT', ''),
        os.path.join(public_dir, 'Documents', 'XiyijiRuntime'),
        os.path.join(public_dir, 'XiyijiRuntime'),
    ]:
        candidate_root = candidate_root.strip()
        if candidate_root:
            alias_roots.append(candidate_root)

    digest = hashlib.md5(normalized.lower().encode('utf-8')).hexdigest()[:12]
    for alias_root in alias_roots:
        try:
            os.makedirs(alias_root, exist_ok=True)
            alias_path = os.path.join(alias_root, f'{alias_prefix}_{digest}')
            if not os.path.exists(alias_path):
                escaped_alias = alias_path.replace("'", "''")
                escaped_target = normalized.replace("'", "''")
                command = (
                    f"$alias = '{escaped_alias}'; "
                    f"$target = '{escaped_target}'; "
                    "if (-not (Test-Path $alias)) { "
                    "New-Item -ItemType Junction -Path $alias -Target $target | Out-Null "
                    "}"
                )
                completed = subprocess.run(
                    ['powershell.exe', '-NoProfile', '-Command', command],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    encoding='utf-8',
                    errors='replace',
                    creationflags=0x08000000,
                )
                if completed.returncode != 0 and not os.path.exists(alias_path):
                    continue

            aliased_short_path = _to_windows_short_path(alias_path)
            if aliased_short_path and _is_ascii_safe_path(aliased_short_path):
                return os.path.normpath(aliased_short_path)
            if _is_ascii_safe_path(alias_path):
                return os.path.normpath(alias_path)
        except Exception:
            continue

    return short_path or normalized

YUNDINGYUNBO_BASE = os.environ.get(
    'YUNDINGYUNBO_BASE',
    os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
)

if not os.path.exists(os.path.join(YUNDINGYUNBO_BASE, 'live')):
    for candidate in [
        os.environ.get('YUNDINGYUNBO_BASE', ''),
        os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'yundingyunbo_v163'),
    ]:
        if candidate and os.path.exists(os.path.join(candidate, 'live')):
            YUNDINGYUNBO_BASE = candidate
            break

RAW_YUNDINGYUNBO_BASE = os.path.normpath(YUNDINGYUNBO_BASE)
YUNDINGYUNBO_BASE = _ensure_windows_runtime_alias(RAW_YUNDINGYUNBO_BASE, 'ydb')
os.environ['YUNDINGYUNBO_BASE'] = YUNDINGYUNBO_BASE

sys.path.insert(0, YUNDINGYUNBO_BASE)
sys.path.insert(0, os.path.join(YUNDINGYUNBO_BASE, 'live'))
sys.path.insert(0, os.path.join(YUNDINGYUNBO_BASE, 'bin', 'image_infer_v2'))

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def log(msg: str):
    print(f'[YDB] {msg}', file=sys.stderr, flush=True)

def _create_ndjson_stdout():
    try:
        stdout = sys.stdout
        stdout.flush()
        encoding = getattr(stdout, 'encoding', None) or 'utf-8'
        errors = getattr(stdout, 'errors', None) or 'replace'
        dup_fd = os.dup(stdout.fileno())
        return os.fdopen(
            dup_fd,
            'w',
            buffering=1,
            encoding=encoding,
            errors=errors,
            newline='\n',
            closefd=True,
        )
    except Exception:
        return sys.stdout

_NDJSON_STDOUT = _create_ndjson_stdout()
_DEBUG_TRACE_CAMERA = os.environ.get('YDB_DEBUG_TRACE_CAMERA') == '1'
_SKIP_WAITKEY = os.environ.get('YDB_SKIP_WAITKEY') == '1'
_SKIP_QUEUE_POLL = os.environ.get('YDB_SKIP_QUEUE_POLL') == '1'
_DEBUG_INSPECT_MANAGER = os.environ.get('YDB_DEBUG_INSPECT_MANAGER') == '1'
_DEBUG_ORIGIN_FRAME_AUDIO_FLOW = os.environ.get('YDB_DEBUG_ORIGIN_FRAME_AUDIO_FLOW') == '1'
_DEBUG_DUMP_CAMERA_NEXT = os.environ.get('YDB_DEBUG_DUMP_CAMERA_NEXT') == '1'
_CAMERA_NEXT_RETRY_COUNT = max(1, int(os.environ.get('YDB_CAMERA_NEXT_RETRY_COUNT', '120')))
_CAMERA_NEXT_RETRY_DELAY = max(0.01, float(os.environ.get('YDB_CAMERA_NEXT_RETRY_DELAY', '0.10')))
_FAST_NORMALIZE_POLICY_VERSION = 'adaptive_portrait_hifi_v3'
_CHARACTER_CACHE_POLICY_VERSION = 'fullvideo_adaptive_portrait_hifi_v3'


def _prepend_runtime_tools_to_path():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    candidates = [
        os.environ.get('XIYIJI_NODE_DIR', ''),
        os.path.join(script_dir, 'node'),
        os.path.join(YUNDINGYUNBO_BASE, 'node'),
        os.path.join(YUNDINGYUNBO_BASE, 'nodejs'),
        os.environ.get('XIYIJI_FFMPEG_DIR', ''),
        os.path.join(YUNDINGYUNBO_BASE, 'env', 'ffmpeg', 'bin'),
        os.path.join(YUNDINGYUNBO_BASE, 'env_50', 'ffmpeg', 'bin'),
    ]

    extras = []
    seen = set()
    for candidate in candidates:
        if not candidate:
            continue
        resolved = _to_windows_short_path(os.path.normpath(candidate))
        if not os.path.exists(resolved) or resolved in seen:
            continue
        seen.add(resolved)
        extras.append(resolved)

    current_path = os.environ.get('PATH', '')
    if extras:
        path_parts = [part for part in current_path.split(os.pathsep) if part]
        merged = []
        seen_parts = set()
        for value in extras + path_parts:
            normalized = os.path.normcase(os.path.normpath(value))
            if normalized in seen_parts:
                continue
            seen_parts.add(normalized)
            merged.append(value)
        os.environ['PATH'] = os.pathsep.join(merged)
        log(f'Runtime PATH prepared: {" | ".join(extras)}')

    ffmpeg_candidates = [
        os.environ.get('FFMPEG_BINARY', ''),
        os.path.join(os.environ.get('XIYIJI_FFMPEG_DIR', ''), 'ffmpeg.exe'),
        os.path.join(YUNDINGYUNBO_BASE, 'env', 'ffmpeg', 'bin', 'ffmpeg.exe'),
        os.path.join(YUNDINGYUNBO_BASE, 'env_50', 'ffmpeg', 'bin', 'ffmpeg.exe'),
    ]
    for ffmpeg_path in ffmpeg_candidates:
        resolved = _to_windows_short_path(ffmpeg_path) if ffmpeg_path else ''
        if resolved and os.path.exists(resolved):
            ffmpeg_path = resolved
            os.environ['FFMPEG_BINARY'] = ffmpeg_path
            os.environ['IMAGEIO_FFMPEG_EXE'] = ffmpeg_path
            os.environ['PYDUB_FFMPEG_PATH'] = ffmpeg_path
            log(f'Runtime ffmpeg selected: {ffmpeg_path}')
            break


_prepend_runtime_tools_to_path()

_FAST_NORMALIZE_PATCHED = False
_FAST_NORMALIZE_ENCODER = None
_PREPROCESS_MODEL_PATH_PATCHED = False
_PREPROCESS_FORCE_CPU_LOGGED = False
_PREPROCESS_STAGE_LOGGING_PATCHED = False
_ACTIVE_PREPROCESS_REPORTER = None


def _hidden_subprocess_kwargs():
    kwargs = {
        'stdin': subprocess.DEVNULL,
        'stdout': subprocess.PIPE,
        'stderr': subprocess.PIPE,
        'text': True,
        'encoding': 'utf-8',
        'errors': 'replace',
    }
    if os.name == 'nt':
        kwargs['creationflags'] = 0x08000000
    return kwargs


def _resolve_runtime_binary(binary_name: str) -> str:
    ffmpeg_binary = os.environ.get('FFMPEG_BINARY', '').strip()
    ffmpeg_dir = os.environ.get('XIYIJI_FFMPEG_DIR', '').strip()
    candidates = []

    if binary_name == 'ffmpeg' and ffmpeg_binary:
        candidates.append(ffmpeg_binary)

    if ffmpeg_binary:
        candidates.append(os.path.join(os.path.dirname(ffmpeg_binary), f'{binary_name}.exe'))
    if ffmpeg_dir:
        candidates.append(os.path.join(ffmpeg_dir, f'{binary_name}.exe'))

    candidates.extend(
        [
            os.path.join(YUNDINGYUNBO_BASE, 'env', 'ffmpeg', 'bin', f'{binary_name}.exe'),
            os.path.join(YUNDINGYUNBO_BASE, 'env_50', 'ffmpeg', 'bin', f'{binary_name}.exe'),
            f'{binary_name}.exe' if os.name == 'nt' else binary_name,
        ]
    )

    for candidate in candidates:
        if not candidate:
            continue
        if os.path.isabs(candidate) and os.path.exists(candidate):
            return _to_windows_short_path(os.path.normpath(candidate))
        if not os.path.isabs(candidate):
            return candidate

    return f'{binary_name}.exe' if os.name == 'nt' else binary_name


def _parse_fraction(value, fallback: float = 0.0) -> float:
    try:
        if isinstance(value, (int, float)):
            return float(value)
        text = str(value or '').strip()
        if not text:
            return fallback
        if '/' in text:
            numerator, denominator = text.split('/', 1)
            numerator = float(numerator)
            denominator = float(denominator)
            if abs(denominator) < 1e-9:
                return fallback
            return numerator / denominator
        return float(text)
    except Exception:
        return fallback


def _probe_video_metadata(video_path: str) -> dict:
    ffprobe_binary = _resolve_runtime_binary('ffprobe')
    command = [
        ffprobe_binary,
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_streams',
        '-show_format',
        video_path,
    ]
    completed = subprocess.run(command, **_hidden_subprocess_kwargs())
    if completed.returncode != 0:
        stderr = (completed.stderr or '').strip()
        raise RuntimeError(stderr or f'ffprobe failed ({completed.returncode})')

    payload = json.loads(completed.stdout or '{}')
    streams = payload.get('streams') or []
    format_info = payload.get('format') or {}
    video_stream = next((stream for stream in streams if stream.get('codec_type') == 'video'), {})
    audio_stream = next((stream for stream in streams if stream.get('codec_type') == 'audio'), {})

    rotation = 0
    tags = video_stream.get('tags') or {}
    rotation = int(float(tags.get('rotate', 0) or 0))
    if rotation == 0:
        for side_data in video_stream.get('side_data_list') or []:
            if 'rotation' in side_data:
                rotation = int(float(side_data.get('rotation') or 0))
                break

    width = int(video_stream.get('width') or 0)
    height = int(video_stream.get('height') or 0)
    effective_width = height if abs(rotation) % 180 == 90 else width
    effective_height = width if abs(rotation) % 180 == 90 else height

    return {
        'rotation': rotation,
        'width': width,
        'height': height,
        'effective_width': effective_width,
        'effective_height': effective_height,
        'fps': _parse_fraction(video_stream.get('avg_frame_rate') or video_stream.get('r_frame_rate'), 25.0),
        'n_frames': int(video_stream.get('nb_frames') or 0),
        'audio_sample_rate': int(audio_stream.get('sample_rate') or 0),
        'audio_channels': int(audio_stream.get('channels') or 0),
        'duration': _parse_fraction(format_info.get('duration'), 0.0),
    }


def _make_even(value: int) -> int:
    value = max(2, int(value))
    return value if value % 2 == 0 else value - 1


def _compute_normalized_dimensions(metadata: dict, target_width: int, target_height: int) -> tuple[int, int]:
    source_width = int(metadata.get('effective_width') or metadata.get('width') or target_width)
    source_height = int(metadata.get('effective_height') or metadata.get('height') or target_height)
    if source_width <= 0 or source_height <= 0:
        return _make_even(target_width), _make_even(target_height)

    box_width = int(target_width)
    box_height = int(target_height)
    if source_width > source_height and target_height > target_width:
        box_width, box_height = target_height, target_width

    scale = min(box_width / float(source_width), box_height / float(source_height))
    normalized_width = _make_even(round(source_width * scale))
    normalized_height = _make_even(round(source_height * scale))
    return normalized_width, normalized_height


def _resolve_fast_normalize_target_dimensions(
    metadata: dict,
    target_width: int,
    target_height: int,
) -> tuple[int, int, bool]:
    source_width = int(metadata.get('effective_width') or metadata.get('width') or target_width)
    source_height = int(metadata.get('effective_height') or metadata.get('height') or target_height)
    base_width = _make_even(target_width)
    base_height = _make_even(target_height)
    if source_width <= 0 or source_height <= 0:
        return base_width, base_height, False

    max_width = _make_even(int(os.environ.get('YDB_FAST_NORMALIZE_MAX_WIDTH', '1080')))
    max_height = _make_even(int(os.environ.get('YDB_FAST_NORMALIZE_MAX_HEIGHT', '1920')))
    if max_width < base_width:
        max_width = base_width
    if max_height < base_height:
        max_height = base_height

    if source_height <= source_width:
        return base_width, base_height, False

    preserve_hifi = str(os.environ.get('YDB_FAST_NORMALIZE_PRESERVE_HIGH_RES', '1')).strip().lower()
    if preserve_hifi in ('0', 'false', 'no', 'off'):
        return base_width, base_height, False

    upscale_limit = min(max_width / float(source_width), max_height / float(source_height), 1.0)
    output_width = _make_even(round(source_width * upscale_limit))
    output_height = _make_even(round(source_height * upscale_limit))
    if output_width < base_width or output_height < base_height:
        return base_width, base_height, False

    if output_width == base_width and output_height == base_height:
        return base_width, base_height, False

    return output_width, output_height, True


def _is_valid_video_file(video_path: str) -> bool:
    if not video_path or not os.path.isfile(video_path):
        return False
    try:
        if os.path.getsize(video_path) <= 4096:
            return False
        metadata = _probe_video_metadata(video_path)
        return metadata.get('duration', 0.0) > 0.05
    except Exception:
        return False


def _build_normalized_output_candidates(input_path: str) -> list[str]:
    directory = os.path.dirname(input_path)
    suffix = Path(input_path).suffix or '.mp4'
    stem = Path(input_path).stem
    try:
        stat = os.stat(input_path)
        cache_key = (
            f'{Path(input_path).name}|{stat.st_size}|{int(stat.st_mtime * 1000)}|'
            f'{_FAST_NORMALIZE_POLICY_VERSION}'
        )
    except OSError:
        cache_key = f'{input_path}|{_FAST_NORMALIZE_POLICY_VERSION}'
    digest = hashlib.md5(cache_key.encode('utf-8')).hexdigest()[:10]

    candidates = [
        os.path.join(directory, f'normalized_{Path(input_path).name}'),
        os.path.join(directory, f'normalized_{stem}_{digest}{suffix}'),
        os.path.join(directory, f'normalized_{stem}_{digest}_{os.getpid()}{suffix}'),
    ]

    unique_candidates = []
    seen = set()
    for candidate in candidates:
        normalized = os.path.normcase(os.path.normpath(candidate))
        if normalized in seen:
            continue
        seen.add(normalized)
        unique_candidates.append(candidate)
    return unique_candidates


def _build_portrait_crop_scale_filter(metadata: dict, target_width: int, target_height: int) -> tuple[str, int, int]:
    source_width = int(metadata.get('effective_width') or metadata.get('width') or target_width)
    source_height = int(metadata.get('effective_height') or metadata.get('height') or target_height)
    output_width = _make_even(target_width)
    output_height = _make_even(target_height)

    if source_width <= 0 or source_height <= 0:
        return f'scale={output_width}:{output_height}', output_width, output_height

    source_ratio = float(source_width) / float(source_height)
    target_ratio = float(output_width) / float(output_height)

    if source_ratio >= target_ratio:
        scaled_width = _make_even(round(source_width * (output_height / float(source_height))))
        crop_x = max(0, (scaled_width - output_width) // 2)
        return (
            f'scale={scaled_width}:{output_height},crop={output_width}:{output_height}:{crop_x}:0',
            output_width,
            output_height,
        )

    scaled_height = _make_even(round(source_height * (output_width / float(source_width))))
    crop_y = max(0, (scaled_height - output_height) // 2)
    return (
        f'scale={output_width}:{scaled_height},crop={output_width}:{output_height}:0:{crop_y}',
        output_width,
        output_height,
    )


def _select_fast_normalize_encoder() -> str:
    global _FAST_NORMALIZE_ENCODER
    if _FAST_NORMALIZE_ENCODER:
        return _FAST_NORMALIZE_ENCODER

    ffmpeg_binary = _resolve_runtime_binary('ffmpeg')
    try:
        completed = subprocess.run(
            [ffmpeg_binary, '-hide_banner', '-encoders'],
            **_hidden_subprocess_kwargs(),
        )
        output = f'{completed.stdout or ""}\n{completed.stderr or ""}'
        if completed.returncode == 0 and 'h264_nvenc' in output:
            _FAST_NORMALIZE_ENCODER = 'h264_nvenc'
        else:
            _FAST_NORMALIZE_ENCODER = 'libx264'
    except Exception:
        _FAST_NORMALIZE_ENCODER = 'libx264'

    log(f'Fast normalize encoder selected: {_FAST_NORMALIZE_ENCODER}')
    return _FAST_NORMALIZE_ENCODER


def _fast_normalize_video(input_path: str, target_width: int = 720, target_height: int = 1280) -> str:
    normalized_input = _remap_to_runtime_alias(input_path)
    input_name = os.path.basename(normalized_input)
    metadata = _probe_video_metadata(normalized_input)
    resolved_width, resolved_height, preserve_source_aspect = _resolve_fast_normalize_target_dimensions(
        metadata,
        target_width,
        target_height,
    )
    if preserve_source_aspect:
        output_width, output_height = _compute_normalized_dimensions(
            metadata,
            resolved_width,
            resolved_height,
        )
        video_filter = f'scale={output_width}:{output_height}'
        log(
            'Fast normalize using high-fidelity portrait target: '
            f'source={int(metadata.get("effective_width") or metadata.get("width") or 0)}x'
            f'{int(metadata.get("effective_height") or metadata.get("height") or 0)}, '
            f'output={output_width}x{output_height}'
        )
    elif target_height > target_width:
        video_filter, output_width, output_height = _build_portrait_crop_scale_filter(
            metadata,
            target_width,
            target_height,
        )
    else:
        output_width, output_height = _compute_normalized_dimensions(
            metadata,
            target_width,
            target_height,
        )
        video_filter = f'scale={output_width}:{output_height}'

    def _candidate_matches_target(candidate_path: str) -> bool:
        try:
            candidate_metadata = _probe_video_metadata(candidate_path)
        except Exception as exc:
            log(f'Failed to inspect normalized video candidate {candidate_path}: {exc}')
            return False

        candidate_width = int(
            candidate_metadata.get('effective_width') or candidate_metadata.get('width') or 0
        )
        candidate_height = int(
            candidate_metadata.get('effective_height') or candidate_metadata.get('height') or 0
        )
        if candidate_width == output_width and candidate_height == output_height:
            return True

        log(
            'Normalized video candidate target mismatch: '
            f'{candidate_path} (got {candidate_width}x{candidate_height}, '
            f'expected {output_width}x{output_height})'
        )
        return False

    if input_name.lower().startswith('normalized_') and _is_valid_video_file(normalized_input):
        if _candidate_matches_target(normalized_input):
            return normalized_input
        log(
            'Normalized input does not match current target; rebuilding derived cache '
            f'for {normalized_input}'
        )

    output_path = ''
    for candidate in _build_normalized_output_candidates(normalized_input):
        if _is_valid_video_file(candidate):
            if _candidate_matches_target(candidate):
                log(f'Reusing normalized video: {candidate}')
                return candidate
            try:
                os.remove(candidate)
                log(f'Removed stale normalized video with mismatched target: {candidate}')
            except Exception as exc:
                log(f'Normalized video candidate busy, skipping {candidate}: {exc}')
                continue

        if os.path.exists(candidate):
            try:
                os.remove(candidate)
                log(f'Removed invalid normalized video: {candidate}')
            except Exception as exc:
                log(f'Normalized video candidate busy, skipping {candidate}: {exc}')
                continue

        output_path = candidate
        break

    if not output_path:
        output_path = (
            os.path.join(
                os.path.dirname(normalized_input),
                f'normalized_{Path(normalized_input).stem}_{int(time.time() * 1000)}.mp4',
            )
        )

    ffmpeg_binary = _resolve_runtime_binary('ffmpeg')
    encoder = _select_fast_normalize_encoder()
    tmp_output = (
        output_path
        + f'.tmp_{os.getpid()}_{threading.get_ident()}_{int(time.time() * 1000)}.mp4'
    )

    def build_command(selected_encoder: str) -> list[str]:
        command = [
            ffmpeg_binary,
            '-hide_banner',
            '-loglevel',
            'error',
            '-y',
            '-i',
            normalized_input,
            '-vf',
            video_filter,
            '-r',
            '25',
            '-ar',
            '16000',
            '-ac',
            '1',
            '-pix_fmt',
            'yuv420p',
        ]

        if selected_encoder == 'h264_nvenc':
            command.extend(
                [
                    '-c:v',
                    'h264_nvenc',
                    '-preset',
                    'p1',
                    '-rc',
                    'vbr',
                    '-cq',
                    '23',
                ]
            )
        else:
            command.extend(
                [
                    '-c:v',
                    'libx264',
                    '-preset',
                    'ultrafast',
                    '-crf',
                    '23',
                ]
            )

        command.extend(
            [
                '-c:a',
                'aac',
                '-b:a',
                '128k',
                '-movflags',
                '+faststart',
                tmp_output,
            ]
        )
        return command

    try:
        encoder_attempts = [encoder]
        if encoder == 'h264_nvenc':
            encoder_attempts.append('libx264')

        last_error = None
        for selected_encoder in encoder_attempts:
            if os.path.exists(tmp_output):
                try:
                    os.remove(tmp_output)
                except Exception:
                    pass

            log(
                'Fast normalizing video: '
                f'{normalized_input} -> {output_path} '
                f'({output_width}x{output_height}, encoder={selected_encoder})'
            )
            completed = subprocess.run(
                build_command(selected_encoder),
                **_hidden_subprocess_kwargs(),
            )
            if completed.returncode == 0 and _is_valid_video_file(tmp_output):
                os.replace(tmp_output, output_path)
                return output_path

            stderr = (completed.stderr or '').strip()
            last_error = stderr or f'ffmpeg failed ({completed.returncode})'
            if selected_encoder == 'h264_nvenc':
                log(f'Fast normalize falling back to libx264: {last_error}')

        raise RuntimeError(last_error or 'ffmpeg produced an invalid normalized output')
    except Exception:
        if os.path.exists(tmp_output):
            try:
                os.remove(tmp_output)
            except Exception:
                pass
        raise


def _install_fast_normalize_patch():
    global _FAST_NORMALIZE_PATCHED
    if _FAST_NORMALIZE_PATCHED:
        return

    import importlib

    patched_modules = []
    for module_name in (
        'bin.image_clone.infer_api',
        'bin.image_clone.tools.step0_video_normalize',
        'bin.image_generate_video.tools.step0_video_normalize',
    ):
        try:
            module = importlib.import_module(module_name)
        except Exception as exc:
            log(f'Fast normalize patch skipped for {module_name}: {exc}')
            continue

        if callable(getattr(module, 'normalize_video', None)):
            setattr(module, 'normalize_video', _fast_normalize_video)
            patched_modules.append(module_name)

    _FAST_NORMALIZE_PATCHED = True
    if patched_modules:
        log(f'Installed fast normalize patch: {", ".join(patched_modules)}')


def _resolve_existing_runtime_path(path_value: str, expect_file: bool) -> str:
    raw_value = str(path_value or '').strip()
    if not raw_value:
        return ''

    candidates = [raw_value]
    if not os.path.isabs(raw_value):
        candidates.extend(
            [
                os.path.join(YUNDINGYUNBO_BASE, raw_value),
                os.path.join(RAW_YUNDINGYUNBO_BASE, raw_value),
            ]
        )

    for candidate in candidates:
        normalized = os.path.normpath(candidate)
        if expect_file:
            if os.path.isfile(normalized):
                return normalized
        else:
            if os.path.isdir(normalized):
                return normalized

    return ''


def _resolve_face_detect_model_path(model_path: str) -> str:
    resolved = _resolve_existing_runtime_path(model_path, expect_file=False)
    if resolved:
        return resolved

    fallback = os.path.normpath(
        os.path.join(YUNDINGYUNBO_BASE, 'assets', 'pretrained_models', 'face_detect')
    )
    if os.path.isdir(fallback):
        return fallback

    raw_value = str(model_path or '').strip()
    return os.path.normpath(raw_value) if raw_value else fallback


def _resolve_xseg_model_path(xseg_model_path: str) -> str:
    resolved = _resolve_existing_runtime_path(xseg_model_path, expect_file=True)
    if resolved:
        return resolved

    for fallback in (
        os.path.join(YUNDINGYUNBO_BASE, 'assets', 'pretrained_models', 'dfl_xseg.onnx'),
        os.path.join(YUNDINGYUNBO_BASE, 'assets', 'pretrained_models', 'xseg', 'dfl_xseg.onnx'),
    ):
        normalized = os.path.normpath(fallback)
        if os.path.isfile(normalized):
            return normalized

    raw_value = str(xseg_model_path or '').strip()
    return os.path.normpath(raw_value) if raw_value else ''


def _install_preprocess_model_path_patch():
    global _PREPROCESS_MODEL_PATH_PATCHED
    if _PREPROCESS_MODEL_PATH_PATCHED:
        return

    import importlib

    patched_targets = []
    force_cpu = _truthy_env('YDB_PREPROCESS_FORCE_CPU', '0')

    for module_name in (
        'bin.image_clone.tools.generate_infer_data.face_detect',
        'bin.image_generate_video.tools.generate_infer_data.face_detect',
    ):
        try:
            module = importlib.import_module(module_name)
        except Exception as exc:
            log(f'Preprocess model path patch skipped for {module_name}: {exc}')
            continue

        face_detect_cls = getattr(module, 'FaceDetect', None)
        if face_detect_cls is None or getattr(face_detect_cls, '_xiyiji_model_path_patched', False):
            continue

        orig_init = getattr(face_detect_cls, '__init__', None)
        if not callable(orig_init):
            continue

        def patched_init(
            self,
            mode='scrfd_500m',
            cpu=False,
            model_path='./resources/',
            _orig_init=orig_init,
        ):
            resolved_model_path = _resolve_face_detect_model_path(model_path)
            effective_cpu = bool(cpu or force_cpu)
            if force_cpu:
                global _PREPROCESS_FORCE_CPU_LOGGED
                if not _PREPROCESS_FORCE_CPU_LOGGED:
                    log('Preprocess CPU fallback enabled for FaceDetect')
                    _PREPROCESS_FORCE_CPU_LOGGED = True
                _preprocess_report(
                    f'FaceDetect forcing CPU mode: model_path={resolved_model_path}'
                )
            return _orig_init(self, mode=mode, cpu=effective_cpu, model_path=resolved_model_path)

        setattr(face_detect_cls, '__init__', patched_init)
        setattr(face_detect_cls, '_xiyiji_model_path_patched', True)
        patched_targets.append(f'{module_name}.FaceDetect')

    for module_name in (
        'bin.image_clone.infer_api',
        'bin.image_clone.tools.generate_infer_data.infer_api',
        'bin.image_generate_video.tools.generate_infer_data.infer_api',
    ):
        try:
            module = importlib.import_module(module_name)
        except Exception as exc:
            log(f'Preprocess model path patch skipped for {module_name}: {exc}')
            continue

        process_face_frames = getattr(module, 'process_face_frames', None)
        if process_face_frames is None or getattr(process_face_frames, '_xiyiji_model_path_patched', False):
            continue

        def patched_process_face_frames(*args, _orig_process_face_frames=process_face_frames, **kwargs):
            arg_list = list(args)

            if len(arg_list) > 6:
                arg_list[6] = _resolve_face_detect_model_path(arg_list[6])
            else:
                kwargs['model_path'] = _resolve_face_detect_model_path(kwargs.get('model_path'))

            if len(arg_list) > 7:
                resolved_xseg_path = _resolve_xseg_model_path(arg_list[7])
                if resolved_xseg_path:
                    arg_list[7] = resolved_xseg_path
            else:
                resolved_xseg_path = _resolve_xseg_model_path(kwargs.get('xseg_model_path'))
                if resolved_xseg_path:
                    kwargs['xseg_model_path'] = resolved_xseg_path
                elif 'xseg_model_path' in kwargs and not kwargs['xseg_model_path']:
                    kwargs.pop('xseg_model_path', None)

            if force_cpu:
                global _PREPROCESS_FORCE_CPU_LOGGED
                if len(arg_list) > 5:
                    arg_list[5] = True
                else:
                    kwargs['cpu'] = True
                if not _PREPROCESS_FORCE_CPU_LOGGED:
                    log('Preprocess CPU fallback enabled for process_face_frames')
                    _PREPROCESS_FORCE_CPU_LOGGED = True
                _preprocess_report('process_face_frames forcing CPU mode')

            return _orig_process_face_frames(*arg_list, **kwargs)

        setattr(patched_process_face_frames, '_xiyiji_model_path_patched', True)
        setattr(module, 'process_face_frames', patched_process_face_frames)
        patched_targets.append(f'{module_name}.process_face_frames')

    _PREPROCESS_MODEL_PATH_PATCHED = True
    if patched_targets:
        log(f'Installed preprocess model path patch: {", ".join(patched_targets)}')

class _StdoutToStderr:
    """Keep stdout reserved for NDJSON; route all other prints to stderr."""

    def write(self, data):
        if data:
            sys.stderr.write(data)
        return len(data)

    def flush(self):
        sys.stderr.flush()

    def isatty(self):
        return False

class _DirectPreviewThreadHandle:
    """Minimal thread-like handle for ydb code paths that only check liveness."""

    def __init__(self, stop_event: threading.Event, name: str):
        self._stop_event = stop_event
        self.name = name

    def is_alive(self):
        return not self._stop_event.is_set()

    def join(self, timeout=None):
        return None

try:
    if _NDJSON_STDOUT is not sys.stdout:
        sys.stdout.flush()
        os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
except Exception:
    pass

sys.stdout = _StdoutToStderr()

_emit_lock = threading.Lock()
def emit(obj: dict):
    with _emit_lock:
        line = json.dumps(obj, ensure_ascii=False)
        _NDJSON_STDOUT.write(line + '\n')
        _NDJSON_STDOUT.flush()


class _PreprocessReporter:
    def __init__(self, video_path: str, model_id: str, force_cpu: bool, clone_source: str):
        self.video_path = video_path
        self.model_id = model_id
        self.force_cpu = force_cpu
        self.clone_source = clone_source
        self._lock = threading.Lock()
        self.current_stage = 'bootstrap'
        self.current_detail = ''
        self.current_stage_started_at = time.time()
        self._heartbeat_stop = threading.Event()
        self._heartbeat_thread = None

    def start(self):
        self.log(
            'Worker started: '
            f'video={self.video_path}, model_id={self.model_id}, '
            f'force_cpu={self.force_cpu}, clone_source={self.clone_source}'
        )
        self._heartbeat_thread = threading.Thread(
            target=self._heartbeat_loop,
            daemon=True,
            name='ydb-preprocess-heartbeat',
        )
        self._heartbeat_thread.start()

    def stop(self):
        self._heartbeat_stop.set()
        if self._heartbeat_thread is not None:
            self._heartbeat_thread.join(timeout=1.0)

    def log(self, message: str):
        emit({'type': 'log', 'message': message})

    def stage_started(self, stage: str, detail: str = '') -> float:
        now = time.time()
        with self._lock:
            self.current_stage = stage
            self.current_detail = detail
            self.current_stage_started_at = now
        emit(
            {
                'type': 'stage',
                'stage': stage,
                'detail': detail,
                'at': now,
            }
        )
        return now

    def stage_finished(self, stage: str, started_at: float):
        elapsed = max(0.0, time.time() - started_at)
        self.log(f'Stage finished: {stage} ({elapsed:.1f}s)')

    def stage_failed(self, stage: str, started_at: float, error: Exception):
        elapsed = max(0.0, time.time() - started_at)
        self.log(f'Stage failed: {stage} ({elapsed:.1f}s): {error}')

    def current_stage_snapshot(self) -> tuple[str, str, float]:
        with self._lock:
            elapsed = max(0.0, time.time() - self.current_stage_started_at)
            return self.current_stage, self.current_detail, elapsed

    def _heartbeat_loop(self):
        while not self._heartbeat_stop.wait(10.0):
            stage, detail, elapsed = self.current_stage_snapshot()
            emit(
                {
                    'type': 'heartbeat',
                    'stage': stage,
                    'detail': detail,
                    'elapsed': elapsed,
                }
            )


def _get_preprocess_reporter():
    return _ACTIVE_PREPROCESS_REPORTER


@contextmanager
def _preprocess_stage(stage: str, detail: str = ''):
    reporter = _get_preprocess_reporter()
    started_at = reporter.stage_started(stage, detail) if reporter is not None else time.time()
    try:
        yield
    except Exception as exc:
        if reporter is not None:
            reporter.stage_failed(stage, started_at, exc)
        raise
    else:
        if reporter is not None:
            reporter.stage_finished(stage, started_at)


def _preprocess_report(message: str):
    reporter = _get_preprocess_reporter()
    if reporter is not None:
        reporter.log(message)


def _truthy_env(name: str, default: str = '0') -> bool:
    raw = str(os.environ.get(name, default)).strip().lower()
    return raw not in ('', '0', 'false', 'no', 'off')

def model_path(rel: str) -> str:
    return os.path.join(YUNDINGYUNBO_BASE, rel)


def _install_preprocess_stage_logging_patch():
    global _PREPROCESS_STAGE_LOGGING_PATCHED
    if _PREPROCESS_STAGE_LOGGING_PATCHED:
        return

    import importlib

    patched_targets = []

    def _patch_function(module_name: str, attr_name: str, detail_builder=None):
        try:
            module = importlib.import_module(module_name)
        except Exception as exc:
            log(f'Preprocess stage patch skipped for {module_name}.{attr_name}: {exc}')
            return

        original = getattr(module, attr_name, None)
        if not callable(original) or getattr(original, '_xiyiji_stage_logging_patched', False):
            return

        def wrapped(*args, _orig=original, _module_name=module_name, _attr_name=attr_name, **kwargs):
            detail = ''
            if callable(detail_builder):
                try:
                    detail = str(detail_builder(args, kwargs))
                except Exception:
                    detail = ''
            stage_name = f'{_module_name}.{_attr_name}'
            with _preprocess_stage(stage_name, detail):
                return _orig(*args, **kwargs)

        setattr(wrapped, '_xiyiji_stage_logging_patched', True)
        setattr(module, attr_name, wrapped)
        patched_targets.append(f'{module_name}.{attr_name}')

    _patch_function(
        'bin.image_clone.infer_api',
        'find_cached_preprocessing',
        lambda args, _kwargs: f'video={args[0]}' if len(args) > 0 else '',
    )
    _patch_function(
        'bin.image_clone.infer_api',
        'preprocess_video',
        lambda args, _kwargs: (
            'video='
            f'{args[0] if len(args) > 0 else _kwargs.get("video_path", "")}, '
            'output='
            f'{args[1] if len(args) > 1 else _kwargs.get("output_dir", "")}'
        ),
    )
    _patch_function(
        'bin.image_clone.infer_api',
        'read_video_frames',
        lambda args, _kwargs: (
            f'video={args[0]}, frames_dir={args[1]}'
            if len(args) > 1 else ''
        ),
    )
    _patch_function(
        'bin.image_clone.infer_api',
        'process_face_frames',
        lambda args, kwargs: (
            f'frames_dir={args[0] if len(args) > 0 else kwargs.get("frames_dir", "")}, '
            f'output_dir={args[2] if len(args) > 2 else kwargs.get("output_dir", "")}, '
            f'cpu={bool((args[5] if len(args) > 5 else kwargs.get("cpu", False)) or _truthy_env("YDB_PREPROCESS_FORCE_CPU", "0"))}'
        ),
    )
    _patch_function(
        'bin.image_clone.tools.generate_infer_data.infer_api',
        'process_face_frames',
        lambda args, kwargs: (
            f'frames_dir={args[0] if len(args) > 0 else kwargs.get("frames_dir", "")}, '
            f'output_dir={args[2] if len(args) > 2 else kwargs.get("output_dir", "")}, '
            f'cpu={bool((args[5] if len(args) > 5 else kwargs.get("cpu", False)) or _truthy_env("YDB_PREPROCESS_FORCE_CPU", "0"))}'
        ),
    )

    _PREPROCESS_STAGE_LOGGING_PATCHED = True
    if patched_targets:
        log(f'Installed preprocess stage logging patch: {", ".join(patched_targets)}')


def resolve_clone_video_local(clone_source: str = 'auto'):
    import importlib

    _install_fast_normalize_patch()
    _install_preprocess_model_path_patch()
    _install_preprocess_stage_logging_patch()

    normalized_source = str(clone_source or 'auto').strip().lower()
    if normalized_source not in ('auto', 'main', 'image_clone'):
        raise ValueError(f'Unsupported clone source: {clone_source}')

    if normalized_source in ('auto', 'main'):
        main_module = importlib.import_module('main')
        if callable(getattr(main_module, 'normalize_video', None)):
            setattr(main_module, 'normalize_video', _fast_normalize_video)
        for name in ('clone_video_local', 'clone_video_local_v2'):
            fn = getattr(main_module, name, None)
            if callable(fn):
                return fn, name
        if normalized_source == 'main':
            available = sorted(name for name in dir(main_module) if 'clone' in name.lower())
            raise ImportError(
                f'Neither clone_video_local nor clone_video_local_v2 is available in main; '
                f'available clone symbols: {available}'
            )

    image_clone_module = importlib.import_module('bin.image_clone.infer_api')
    image_clone_fn = getattr(image_clone_module, 'clone_video_local', None)
    if callable(image_clone_fn):
        return image_clone_fn, 'bin.image_clone.infer_api.clone_video_local'

    raise ImportError('No usable clone_video_local implementation found')

WENET_CONF   = model_path('assets/pretrained_models/wenet/conf/train_conformer_multi_cn.yaml')
WENET_MODEL  = model_path('assets/pretrained_models/wenet/exp/conformer/wenetmodel.pt')
UNET_MODEL   = model_path('assets/pretrained_models/image_infer_v2/unet_v2.onnx')
SILENCE_NPY  = model_path('assets/pretrained_models/image_infer_v2/silence.npy')
YOLO_MODEL   = model_path('assets/pretrained_models/lip_detect_weights/yolov8n-face.pt')

RAW_DATA_DIR = os.environ.get(
    'XIYIJI_DATA_DIR',
    os.path.join(os.path.dirname(RAW_YUNDINGYUNBO_BASE), 'heygem_data')
)
RAW_DATA_DIR = os.path.normpath(RAW_DATA_DIR)
DATA_DIR = _ensure_windows_runtime_alias(RAW_DATA_DIR, 'data')
os.environ['XIYIJI_DATA_DIR'] = DATA_DIR
CHARACTERS_BASE = os.path.join(DATA_DIR, 'yundingyunbo_characters')
YOLO_CONFIG_DIR = os.environ.get('YOLO_CONFIG_DIR', os.path.join(DATA_DIR, 'ultralytics'))
YOLO_CONFIG_DIR = _ensure_windows_runtime_alias(YOLO_CONFIG_DIR, 'yolo')
os.environ['YOLO_CONFIG_DIR'] = YOLO_CONFIG_DIR


def _remap_to_runtime_alias(path: str) -> str:
    if not path:
        return path

    normalized = os.path.normpath(path)
    for raw_root, runtime_root in [
        (RAW_DATA_DIR, DATA_DIR),
        (RAW_YUNDINGYUNBO_BASE, YUNDINGYUNBO_BASE),
    ]:
        raw_root = os.path.normpath(raw_root)
        runtime_root = os.path.normpath(runtime_root)
        raw_root_cmp = os.path.normcase(raw_root)
        normalized_cmp = os.path.normcase(normalized)
        if normalized_cmp == raw_root_cmp:
            return runtime_root
        if normalized_cmp.startswith(raw_root_cmp + os.sep):
            relative_path = os.path.relpath(normalized, raw_root)
            return os.path.normpath(os.path.join(runtime_root, relative_path))

    return normalized
try:
    os.makedirs(YOLO_CONFIG_DIR, exist_ok=True)
except Exception as e:
    log(f'Failed to prepare YOLO_CONFIG_DIR "{YOLO_CONFIG_DIR}": {e}')


def _validate_character_dir_tree(data_dir: str, characters_base: str | None = None):
    normalized = os.path.normpath(str(data_dir or '').strip())
    if not normalized or not os.path.isdir(normalized):
        return False, 'character directory missing'

    if characters_base:
        try:
            base = os.path.normcase(os.path.normpath(characters_base))
            candidate = os.path.normcase(os.path.normpath(normalized))
            if candidate != base and not candidate.startswith(base + os.sep):
                return False, 'character directory is outside current characters base'
        except Exception:
            return False, 'character directory path is invalid'

    params_path = os.path.join(normalized, 'params.json')
    frames_dir = os.path.join(normalized, 'frames')
    masks_dir = os.path.join(normalized, 'masks')
    positions_dir = os.path.join(normalized, 'positions')

    if not os.path.isfile(params_path):
        return False, 'params.json missing'
    if not os.path.isdir(frames_dir):
        return False, 'frames directory missing'
    if not os.path.isdir(masks_dir):
        return False, 'masks directory missing'
    if not os.path.isdir(positions_dir):
        return False, 'positions directory missing'

    try:
        if not any(True for _ in os.scandir(frames_dir)):
            return False, 'frames directory is empty'
        if not any(True for _ in os.scandir(masks_dir)):
            return False, 'masks directory is empty'
        if not any(True for _ in os.scandir(positions_dir)):
            return False, 'positions directory is empty'
    except OSError as exc:
        return False, f'character directory unreadable: {exc}'

    return True, ''


# ---------------------------------------------------------------------------
# Bridge class
# ---------------------------------------------------------------------------

class YundingyunboBridge:
    def __init__(self):
        self.manager = None
        self.manager_data_dir = None
        self.manager_input_mode = None  # 'file' or 'camera' — track to detect mode change
        self.manager_file_mode_backend = None
        self.manager_driving_video_path = None
        self.manager_started = False
        self.character_cache = {}
        self.running = True
        self.cmd_queue = qmod.Queue()
        self._pending_audio = {}
        self._init_lock = threading.Lock()
        self._init_busy = False
        self._latest_init_generation = 0
        self._latest_init_req_id = ''
        self._tearing_down_manager = False
        # Deferred init: clone_video_local runs in bg thread, result queued
        # for main thread to create V2Manager (OpenCV requires main thread).
        self._deferred_init_queue = qmod.Queue()
        self._load_cache()
        self._debug_patches_installed = False
        self._runtime_patches_installed = False
        self._origin_frame_runtime_patches_installed = False
        self._origin_frame_infer_api_module = None
        self._origin_frame_audio_bypass_patch_installed = False
        self._origin_frame_audio_bypass_targets = set()
        self._origin_frame_audio_feature_override_lock = threading.Lock()
        self._origin_frame_audio_feature_overrides = {}
        self._origin_frame_v2_audio_extractor = None
        self._origin_frame_v2_audio_extractor_data_dir = None
        self._last_good_camera_frame = None
        self._last_good_file_mode_frame = None
        self._camera_placeholder_replacements = 0
        self._camera_next_dump_count = 0
        self._last_native_player_upload_at = 0.0
        self._last_preview_player_upload_at = 0.0
        self._native_camera_upload_count = 0
        self._direct_next_return_count = 0
        self._direct_preview_proc = None
        self._direct_preview_thread = None
        self._direct_preview_stop = threading.Event()
        self._direct_preview_started = False
        self._direct_preview_upload_count = 0
        self._direct_preview_frame_count = 0
        self._direct_preview_latest_frame = None
        self._direct_preview_camera_index = -1
        self._direct_preview_camera_name = ''
        self._creating_camera_mode = False
        camera_capture_mode = str(os.environ.get('YDB_CAMERA_CAPTURE_MODE', 'proxy_native')).strip().lower()
        if camera_capture_mode in ('proxy', 'native_proxy'):
            camera_capture_mode = 'proxy_native'
        if camera_capture_mode not in ('proxy_native', 'direct', 'native'):
            log(f'Unknown YDB_CAMERA_CAPTURE_MODE "{camera_capture_mode}", falling back to proxy_native')
            camera_capture_mode = 'proxy_native'
        try:
            proxy_queue_size = max(1, int(os.environ.get('YDB_PROXY_CAMERA_QUEUE_SIZE', '5')))
        except Exception:
            proxy_queue_size = 5
        self._camera_capture_mode = camera_capture_mode
        self._prefer_direct_camera = self._camera_capture_mode != 'native'
        self._use_proxy_native_camera = self._camera_capture_mode == 'proxy_native'
        self._use_native_manager_camera = self._camera_capture_mode == 'native'
        self._proxy_camera_reader = None
        self._proxy_camera_thread = None
        self._proxy_camera_stderr_thread = None
        self._proxy_camera_stop = threading.Event()
        self._proxy_camera_batch_queue = qmod.Queue(maxsize=proxy_queue_size)
        self._proxy_camera_latest_batch = None
        self._proxy_camera_error = ''
        self._proxy_camera_batch_count = 0
        self._proxy_camera_drop_count = 0
        self._direct_face_readers = {}
        self._last_direct_detection = None
        self._last_positive_direct_detection = None
        self._last_direct_detection_at = 0.0
        self._last_positive_direct_detection_at = 0.0
        self._last_yolo_direct_detection_at = 0.0
        self._last_preview_detection_warmup_at = 0.0
        self._direct_detection_hit_count = 0
        self._direct_detection_miss_count = 0
        self._direct_preview_layout_logged = False
        self._file_drive_state_lock = threading.Lock()
        self._file_drive_serial_lock = threading.Lock()
        self._file_drive_queue = qmod.Queue()
        self._file_drive_session_id = 0
        self._file_drive_video_path = ''
        self._file_drive_video_info = {}
        self._file_drive_cursor_sec = 0.0
        self._file_drive_cursor_frame = 0
        self._file_drive_worker_thread = threading.Thread(
            target=self._file_drive_worker_loop,
            daemon=True,
            name='ydb-file-drive',
        )
        self._file_drive_worker_thread.start()
        self._file_mode_reference_video_path = ''
        self._file_mode_reference_video_info = {}
        self._pygame_window_patch_installed = False
        self._player_window_mode = None
        self._file_window_layout_last = None
        self._file_window_runtime_state_last = None
        self._video_stream_direct_drive_enabled = False
        force_seq_live = str(os.environ.get('YDB_FORCE_SEQUENTIAL_FILE_FRAMES', '1')).strip().lower()
        self._force_sequential_file_frames = force_seq_live not in ('0', 'false', 'no', 'off')
        self._mouth_refine_mask_cache = {}
        self._mouth_refine_apply_count = 0
        self._source_mouth_refine_apply_count = 0

    # ── Character cache ────────────────────────────────────────────────

    def _cache_file(self) -> str:
        return os.path.join(CHARACTERS_BASE, '_cache.json')

    def _character_policy_file(self, data_dir: str) -> str:
        return os.path.join(self._normalize_character_dir(data_dir), '.xiyiji_policy_version')

    def _write_character_policy_version(self, data_dir: str) -> None:
        policy_file = self._character_policy_file(data_dir)
        try:
            with open(policy_file, 'w', encoding='utf-8') as f:
                f.write(_CHARACTER_CACHE_POLICY_VERSION)
        except Exception as e:
            log(f'Failed to write character policy file "{policy_file}": {e}')

    def _read_character_policy_version(self, data_dir: str) -> str:
        policy_file = self._character_policy_file(data_dir)
        try:
            with open(policy_file, 'r', encoding='utf-8') as f:
                return str(f.read()).strip()
        except Exception:
            return ''

    def _is_within_characters_base(self, data_dir: str) -> bool:
        if not data_dir:
            return False

        try:
            base = os.path.normcase(os.path.normpath(CHARACTERS_BASE))
            candidate = os.path.normcase(os.path.normpath(data_dir))
        except Exception:
            return False

        return candidate == base or candidate.startswith(base + os.sep)

    def _normalize_character_dir(self, data_dir: str) -> str:
        if not data_dir:
            return ''

        try:
            raw_value = os.path.expandvars(str(data_dir).strip())
        except Exception:
            return ''

        if not raw_value:
            return ''

        if not os.path.isabs(raw_value):
            return os.path.normpath(os.path.join(CHARACTERS_BASE, raw_value))

        normalized = os.path.normpath(raw_value)
        if self._is_within_characters_base(normalized):
            return normalized

        # Older packaged caches stored absolute paths. Re-anchor those entries
        # into the current runtime so moving the whole folder remains safe.
        if Path(normalized).parent.name.lower() == Path(CHARACTERS_BASE).name.lower():
            return os.path.normpath(os.path.join(CHARACTERS_BASE, Path(normalized).name))

        return normalized

    def _serialize_character_dir(self, data_dir: str) -> str:
        normalized = self._normalize_character_dir(data_dir)
        if not normalized:
            return ''

        if self._is_within_characters_base(normalized):
            try:
                return os.path.relpath(normalized, CHARACTERS_BASE)
            except Exception:
                return normalized

        return normalized

    def _load_cache(self):
        try:
            if os.path.exists(self._cache_file()):
                with open(self._cache_file(), 'r', encoding='utf-8') as f:
                    loaded_cache = json.load(f)

                migrated = 0
                if isinstance(loaded_cache, dict):
                    normalized_cache = {}
                    for key, value in loaded_cache.items():
                        normalized = self._normalize_character_dir(value)
                        if not normalized:
                            migrated += 1
                            continue
                        if normalized != value:
                            migrated += 1
                        normalized_cache[str(key)] = normalized
                    self.character_cache = normalized_cache
                else:
                    self.character_cache = {}
                    migrated = 1

                log(f'Loaded character cache: {len(self.character_cache)} entries')
                if migrated:
                    log(f'Migrated character cache entries for current runtime: {migrated}')
                    self._save_cache()
        except Exception as e:
            log(f'Failed to load cache: {e}')

    def _save_cache(self):
        try:
            os.makedirs(CHARACTERS_BASE, exist_ok=True)
            serialized_cache = {}
            for key, value in self.character_cache.items():
                serialized = self._serialize_character_dir(value)
                if serialized:
                    serialized_cache[str(key)] = serialized
            with open(self._cache_file(), 'w', encoding='utf-8') as f:
                json.dump(serialized_cache, f, ensure_ascii=False, indent=2)
        except Exception as e:
            log(f'Failed to save cache: {e}')

    def _video_hash(self, video_path: str) -> str:
        p = os.path.normpath(video_path)
        try:
            stat = os.stat(p)
            key = (
                f'{Path(p).name}|{stat.st_size}|{int(stat.st_mtime * 1000)}|'
                f'{_CHARACTER_CACHE_POLICY_VERSION}'
            )
        except OSError:
            key = f'{Path(p).name}|{_CHARACTER_CACHE_POLICY_VERSION}'
        return hashlib.md5(key.encode()).hexdigest()[:16]

    def _get_expected_character_normalized_dimensions(self, video_path: str):
        normalized_video_path = _remap_to_runtime_alias(video_path)
        if not normalized_video_path or not os.path.isfile(normalized_video_path):
            return None

        try:
            metadata = _probe_video_metadata(normalized_video_path)
            target_width = 720
            target_height = 1280
            resolved_width, resolved_height, preserve_source_aspect = _resolve_fast_normalize_target_dimensions(
                metadata,
                target_width,
                target_height,
            )
            if preserve_source_aspect:
                return _compute_normalized_dimensions(metadata, resolved_width, resolved_height)
            if target_height > target_width:
                _, output_width, output_height = _build_portrait_crop_scale_filter(
                    metadata,
                    target_width,
                    target_height,
                )
                return output_width, output_height
            return _compute_normalized_dimensions(metadata, target_width, target_height)
        except Exception as exc:
            log(f'Failed to inspect expected character dimensions for {video_path}: {exc}')
            return None

    def _validate_character_dir(self, data_dir: str, video_path: str = ''):
        normalized = self._normalize_character_dir(data_dir)
        valid, reason = _validate_character_dir_tree(normalized, CHARACTERS_BASE)
        if not valid:
            return valid, reason

        policy_version = self._read_character_policy_version(normalized)
        if policy_version != _CHARACTER_CACHE_POLICY_VERSION:
            if not policy_version:
                return False, 'character policy version missing'
            return (
                False,
                f'character policy version mismatch ({policy_version} != {_CHARACTER_CACHE_POLICY_VERSION})',
            )

        if video_path:
            normalized_video_path = os.path.join(normalized, 'normalized_video.mp4')
            if not os.path.isfile(normalized_video_path):
                return False, 'normalized_video missing'

            expected_dimensions = self._get_expected_character_normalized_dimensions(video_path)
            if expected_dimensions:
                try:
                    normalized_metadata = _probe_video_metadata(normalized_video_path)
                    actual_width = int(
                        normalized_metadata.get('effective_width')
                        or normalized_metadata.get('width')
                        or 0
                    )
                    actual_height = int(
                        normalized_metadata.get('effective_height')
                        or normalized_metadata.get('height')
                        or 0
                    )
                except Exception as exc:
                    return False, f'normalized_video unreadable: {exc}'

                expected_width, expected_height = expected_dimensions
                if actual_width != expected_width or actual_height != expected_height:
                    return (
                        False,
                        'normalized video size mismatch '
                        f'({actual_width}x{actual_height} != {expected_width}x{expected_height})',
                    )
        return True, ''

    def _drop_cached_character_refs(self, data_dir: str) -> bool:
        normalized = os.path.normcase(os.path.normpath(self._normalize_character_dir(data_dir)))
        changed = False
        for key, value in list(self.character_cache.items()):
            try:
                candidate = os.path.normcase(os.path.normpath(self._normalize_character_dir(value)))
            except Exception:
                candidate = str(value)
            if candidate == normalized:
                del self.character_cache[key]
                changed = True
        return changed

    def _purge_invalid_character_dir(self, data_dir: str, reason: str) -> None:
        if not data_dir:
            return

        cache_changed = self._drop_cached_character_refs(data_dir)

        if os.path.isdir(data_dir):
            try:
                shutil.rmtree(data_dir)
                log(f'Removed invalid character cache: {data_dir} ({reason})')
            except Exception as exc:
                log(f'Failed to remove invalid character cache {data_dir}: {exc}')

        if cache_changed:
            self._save_cache()

    def _build_video_name_keys(self, video_path: str) -> list[str]:
        stem = Path(video_path).stem.strip().lower()
        if not stem:
            return []
        return [stem]

    def _character_name_matches_video(self, candidate_name: str, video_path: str) -> bool:
        expected = Path(video_path).stem.strip().lower()
        candidate = str(candidate_name or '').strip().lower()
        if not expected or not candidate:
            return False
        return candidate == expected or candidate.startswith(expected + '_')

    def _character_dir_matches_video(self, data_dir: str, video_path: str) -> bool:
        try:
            params_path = os.path.join(data_dir, 'params.json')
            with open(params_path, 'r', encoding='utf-8') as f:
                params = json.load(f)
            name = str(params.get('name', '')).strip().lower()
            return self._character_name_matches_video(name, video_path)
        except Exception:
            return False

    def _find_cached_character_by_name(self, video_path: str) -> str:
        stem_keys = self._build_video_name_keys(video_path)
        if not stem_keys or not os.path.isdir(CHARACTERS_BASE):
            return ''

        for entry in os.listdir(CHARACTERS_BASE):
            data_dir = os.path.join(CHARACTERS_BASE, entry)
            if not os.path.isdir(data_dir):
                continue
            params_path = os.path.join(data_dir, 'params.json')
            if not os.path.exists(params_path):
                continue
            try:
                with open(params_path, 'r', encoding='utf-8') as f:
                    params = json.load(f)
                name = str(params.get('name', '')).strip().lower()
            except Exception:
                continue
            if name and self._character_name_matches_video(name, video_path):
                valid, reason = self._validate_character_dir(data_dir, video_path)
                if not valid:
                    log(
                        f'Ignoring incomplete character cache "{",".join(stem_keys)}": '
                        f'{data_dir} ({reason})'
                    )
                    self._purge_invalid_character_dir(data_dir, reason)
                    continue
                log(f'Character cache matched by name "{",".join(stem_keys)}": {data_dir}')
                return data_dir
        return ''

    def _estimate_preprocess_timeout(self, video_path: str, force_cpu: bool = False) -> float:
        duration = 0.0
        fps = 25.0
        n_frames = 0
        try:
            metadata = _probe_video_metadata(video_path)
            duration = max(0.0, float(metadata.get('duration') or 0.0))
            fps = max(1.0, float(metadata.get('fps') or 25.0))
            n_frames = max(0, int(metadata.get('n_frames') or 0))
            if n_frames <= 0 and duration > 0.0 and fps > 0.0:
                n_frames = max(1, int(round(duration * fps)))
        except Exception:
            duration = 0.0
            fps = 25.0
            n_frames = 0

        base_timeout = 180.0 if not force_cpu else 300.0
        duration_scale = duration * (4.0 if not force_cpu else 6.0)
        frame_scale = n_frames * (0.08 if not force_cpu else 0.16)
        max_timeout = 1800.0 if not force_cpu else 3600.0
        return min(max_timeout, max(base_timeout, duration_scale, frame_scale))

    def _run_preprocess_worker(
        self,
        video_path: str,
        name: str,
        model_id: str,
        force_cpu: bool = False,
        clone_source: str = 'auto',
        progress_cb=None,
    ) -> dict:
        helper_script = os.path.abspath(__file__)
        python_exe = sys.executable
        timeout_s = self._estimate_preprocess_timeout(video_path, force_cpu=force_cpu)
        command = [
            python_exe,
            '-u',
            helper_script,
            '--preprocess-worker',
            '--video',
            video_path,
            '--base-character-path',
            CHARACTERS_BASE,
            '--name',
            name,
            '--model-id',
            model_id,
            '--clone-source',
            clone_source,
        ]
        if force_cpu:
            command.append('--force-cpu')

        env = os.environ.copy()
        env['PYTHONIOENCODING'] = 'utf-8'
        env['YUNDINGYUNBO_BASE'] = YUNDINGYUNBO_BASE
        env['XIYIJI_DATA_DIR'] = DATA_DIR
        if force_cpu:
            env['YDB_PREPROCESS_FORCE_CPU'] = '1'
        else:
            env.pop('YDB_PREPROCESS_FORCE_CPU', None)

        log(
            'Launching preprocess worker: '
            f'model_id={model_id}, force_cpu={force_cpu}, clone_source={clone_source}, '
            f'timeout={timeout_s:.0f}s'
        )

        popen_kwargs = {
            'cwd': YUNDINGYUNBO_BASE,
            'stdin': subprocess.DEVNULL,
            'stdout': subprocess.PIPE,
            'stderr': subprocess.PIPE,
            'text': True,
            'encoding': 'utf-8',
            'errors': 'replace',
            'bufsize': 1,
            'env': env,
        }
        if os.name == 'nt':
            popen_kwargs['creationflags'] = 0x08000000

        proc = subprocess.Popen(command, **popen_kwargs)
        stdout_queue = qmod.Queue()
        stderr_queue = qmod.Queue()
        stdout_done = threading.Event()
        stderr_done = threading.Event()
        last_stage = 'bootstrap'
        last_detail = ''
        recent_stderr = []
        result_payload = None
        error_payload = None

        def _reader(stream, queue_obj, done_event):
            try:
                for line in stream:
                    queue_obj.put(line.rstrip('\r\n'))
            finally:
                done_event.set()

        stdout_thread = threading.Thread(
            target=_reader,
            args=(proc.stdout, stdout_queue, stdout_done),
            daemon=True,
            name='ydb-preprocess-worker-stdout',
        )
        stderr_thread = threading.Thread(
            target=_reader,
            args=(proc.stderr, stderr_queue, stderr_done),
            daemon=True,
            name='ydb-preprocess-worker-stderr',
        )
        stdout_thread.start()
        stderr_thread.start()

        def _drain_stdout():
            nonlocal last_stage, last_detail, result_payload, error_payload
            while True:
                try:
                    line = stdout_queue.get_nowait()
                except qmod.Empty:
                    break
                if not line:
                    continue
                try:
                    payload = json.loads(line)
                except Exception:
                    log(f'Preprocess worker stdout: {line}')
                    continue
                payload_type = str(payload.get('type', '')).strip().lower()
                if payload_type == 'stage':
                    last_stage = str(payload.get('stage') or last_stage)
                    last_detail = str(payload.get('detail') or '')
                    log(f'Preprocess worker stage: {last_stage} | {last_detail}')
                    if progress_cb is not None:
                        try:
                            progress_cb(last_stage, last_detail, 0.0)
                        except Exception:
                            pass
                elif payload_type == 'heartbeat':
                    hb_stage = str(payload.get('stage') or last_stage)
                    hb_detail = str(payload.get('detail') or last_detail)
                    hb_elapsed = float(payload.get('elapsed') or 0.0)
                    last_stage = hb_stage or last_stage
                    last_detail = hb_detail or last_detail
                    log(
                        f'Preprocess worker heartbeat: stage={last_stage}, '
                        f'elapsed={hb_elapsed:.1f}s, detail={hb_detail}'
                    )
                    if progress_cb is not None:
                        try:
                            progress_cb(last_stage, hb_detail, hb_elapsed)
                        except Exception:
                            pass
                elif payload_type == 'log':
                    log(f'Preprocess worker: {payload.get("message", "")}')
                elif payload_type == 'result':
                    result_payload = payload
                elif payload_type == 'error':
                    error_payload = payload
                    error_stage = payload.get('stage') or last_stage
                    log(f'Preprocess worker error at stage {error_stage}: {payload.get("error", "")}')
                    tb_text = str(payload.get('traceback') or '').strip()
                    if tb_text:
                        for tb_line in tb_text.splitlines():
                            log(f'Preprocess worker traceback: {tb_line}')
                else:
                    log(f'Preprocess worker event [{payload_type}]: {payload}')

        def _drain_stderr():
            while True:
                try:
                    line = stderr_queue.get_nowait()
                except qmod.Empty:
                    break
                if not line:
                    continue
                recent_stderr.append(line)
                if len(recent_stderr) > 60:
                    del recent_stderr[:-60]
                log(f'Preprocess worker stderr: {line}')

        deadline = time.time() + timeout_s
        timed_out = False
        try:
            while True:
                _drain_stdout()
                _drain_stderr()

                if result_payload is not None:
                    break

                if error_payload is not None and proc.poll() is not None:
                    break

                if proc.poll() is not None and stdout_done.is_set() and stderr_done.is_set():
                    break

                if time.time() > deadline:
                    timed_out = True
                    break

                time.sleep(0.1)
        finally:
            if timed_out and proc.poll() is None:
                stage_msg = f'stage={last_stage}'
                if last_detail:
                    stage_msg += f', detail={last_detail}'
                log(
                    'Preprocess worker timeout: '
                    f'model_id={model_id}, force_cpu={force_cpu}, {stage_msg}'
                )
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except Exception:
                    proc.kill()
                    try:
                        proc.wait(timeout=5)
                    except Exception:
                        pass

            try:
                stdout_thread.join(timeout=1.0)
            except Exception:
                pass
            try:
                stderr_thread.join(timeout=1.0)
            except Exception:
                pass
            _drain_stdout()
            _drain_stderr()

        if timed_out:
            stage_hint = last_stage or 'unknown'
            if last_detail:
                stage_hint = f'{stage_hint} | {last_detail}'
            raise RuntimeError(
                f'Character preprocessing timed out after {timeout_s:.0f}s at {stage_hint}'
            )

        if result_payload is not None:
            return result_payload

        if error_payload is not None:
            stage_hint = str(error_payload.get('stage') or last_stage or 'unknown')
            error_text = str(error_payload.get('error') or 'unknown worker error')
            raise RuntimeError(f'Character preprocessing failed at {stage_hint}: {error_text}')

        if proc.returncode not in (0, None):
            stderr_hint = recent_stderr[-1] if recent_stderr else f'worker exit code {proc.returncode}'
            stage_hint = last_stage or 'unknown'
            raise RuntimeError(f'Character preprocessing worker exited at {stage_hint}: {stderr_hint}')

        raise RuntimeError('Character preprocessing worker exited without a result')

    def _ensure_character(self, video_path: str, progress_cb=None) -> str:
        video_path = _remap_to_runtime_alias(video_path)
        vhash = self._video_hash(video_path)
        if vhash in self.character_cache:
            data_dir = self._normalize_character_dir(self.character_cache[vhash])
            if data_dir != self.character_cache[vhash]:
                self.character_cache[vhash] = data_dir
                self._save_cache()
            valid, reason = self._validate_character_dir(data_dir, video_path)
            if valid:
                if not self._character_dir_matches_video(data_dir, video_path):
                    log(f'Character cache stem mismatch for {video_path}: {data_dir}')
                    del self.character_cache[vhash]
                    self._save_cache()
                else:
                    log(f'Character cache hit: {data_dir}')
                    if progress_cb is not None:
                        try:
                            progress_cb('cache_hit', data_dir, 0.0)
                        except Exception:
                            pass
                    return data_dir
            else:
                log(f'Character cache invalid: {data_dir} ({reason})')
                self._purge_invalid_character_dir(data_dir, reason)

        data_dir = self._find_cached_character_by_name(video_path)
        if data_dir:
            self.character_cache[vhash] = data_dir
            self._save_cache()
            return data_dir

        log(f'Preprocessing video: {video_path}')
        if progress_cb is not None:
            try:
                progress_cb('preprocess_start', video_path, 0.0)
            except Exception:
                pass
        os.makedirs(CHARACTERS_BASE, exist_ok=True)
        name = Path(video_path).stem
        last_reason = 'unknown error'

        preprocess_attempts = [
            {
                'clone_source': 'main',
                'force_cpu': False,
                'label': 'isolated-main',
            },
            {
                'clone_source': 'image_clone',
                'force_cpu': True,
                'label': 'isolated-image-clone-cpu',
            },
        ]

        for attempt_index, attempt_cfg in enumerate(preprocess_attempts, start=1):
            model_id = str(uuid.uuid4())
            data_dir = os.path.join(CHARACTERS_BASE, model_id)
            if os.path.isdir(data_dir):
                self._purge_invalid_character_dir(data_dir, 'stale pre-existing worker output')

            log(
                'Character preprocessing attempt '
                f'{attempt_index}/{len(preprocess_attempts)}: '
                f'label={attempt_cfg["label"]}, model_id={model_id}, video={video_path}'
            )

            try:
                worker_result = self._run_preprocess_worker(
                    video_path=video_path,
                    name=name,
                    model_id=model_id,
                    force_cpu=bool(attempt_cfg.get('force_cpu')),
                    clone_source=str(attempt_cfg.get('clone_source') or 'auto'),
                    progress_cb=progress_cb,
                )
                if worker_result.get('model_id'):
                    data_dir = os.path.join(CHARACTERS_BASE, str(worker_result['model_id']))
            except Exception as exc:
                last_reason = str(exc)
                log(
                    'Character preprocessing attempt failed '
                    f'(attempt {attempt_index}/{len(preprocess_attempts)}): {last_reason}'
                )
                self._purge_invalid_character_dir(data_dir, last_reason)
                continue

            self._write_character_policy_version(data_dir)
            valid, reason = self._validate_character_dir(data_dir, video_path)
            if valid:
                self.character_cache[vhash] = data_dir
                self._save_cache()
                log(
                    f'Preprocessed: model_id={worker_result.get("model_id", model_id)}, '
                    f'data_dir={data_dir}'
                )
                return data_dir

            last_reason = str(worker_result.get('reason') or reason or 'incomplete character output')
            log(
                f'Character preprocessing produced incomplete output '
                f'(attempt {attempt_index}/{len(preprocess_attempts)}): {data_dir} ({last_reason})'
            )
            self._purge_invalid_character_dir(data_dir, last_reason)

        raise RuntimeError(f'Character preprocessing failed: {last_reason}')

    # ── V2Manager lifecycle ────────────────────────────────────────────

    def _is_file_mode_driving_segment_path(self, video_path: str) -> bool:
        if not video_path:
            return False

        try:
            segment_dir = os.path.normcase(os.path.normpath(os.path.join(DATA_DIR, 'yundingyunbo_driving_segments')))
            candidate = os.path.normcase(os.path.normpath(video_path))
            return candidate.startswith(segment_dir + os.sep) or candidate == segment_dir
        except Exception:
            return False

    def _start_video_face_reader_capture_once(self, reader, video_path: str):
        video_path = _remap_to_runtime_alias(video_path)
        if not video_path:
            raise RuntimeError('special video face reader requires a video path')

        stop_capture = getattr(reader, 'stop_capture', None)
        capture_thread = getattr(reader, 'capture_thread', None)
        preprocess_thread = getattr(reader, 'preprocess_thread', None)
        if (
            getattr(reader, 'ffmpeg_process', None) is not None
            or capture_thread is not None
            or preprocess_thread is not None
        ) and callable(stop_capture):
            stop_capture()

        get_video_properties = getattr(reader, '_get_video_properties', None)
        if not callable(get_video_properties):
            raise RuntimeError('special video face reader _get_video_properties unavailable')

        frame_width, frame_height, _fps = get_video_properties(video_path)
        if int(frame_width or 0) <= 0 or int(frame_height or 0) <= 0:
            raise RuntimeError(f'failed to resolve special drive segment size: {video_path}')

        setattr(reader, 'video_path', video_path)
        setattr(reader, 'playlist_path', None)
        setattr(reader, 'frame_width', int(frame_width))
        setattr(reader, 'frame_height', int(frame_height))
        setattr(reader, 'frame_size', int(frame_width) * int(frame_height) * 3)
        setattr(reader, 'stop_event', threading.Event())
        setattr(reader, 'raw_frames_queue', qmod.Queue(maxsize=64))
        setattr(reader, 'processed_frames_queue', qmod.Queue(maxsize=64))

        ffmpeg_binary = _resolve_runtime_binary('ffmpeg')
        command = [
            ffmpeg_binary,
            '-hide_banner',
            '-loglevel',
            'warning',
            '-re',
            '-i',
            video_path,
            '-pix_fmt',
            'bgr24',
            '-vcodec',
            'rawvideo',
            '-an',
            '-sn',
            '-f',
            'image2pipe',
            '-',
        ]

        popen_kwargs = {
            'stdin': subprocess.DEVNULL,
            'stdout': subprocess.PIPE,
            'stderr': subprocess.PIPE,
        }
        if os.name == 'nt':
            popen_kwargs['creationflags'] = 0x08000000

        ffmpeg_process = subprocess.Popen(command, **popen_kwargs)
        setattr(reader, 'ffmpeg_process', ffmpeg_process)

        stderr_thread = threading.Thread(
            target=reader._drain_stderr,
            daemon=True,
            name='ydb-video-face-reader-stderr',
        )
        stderr_thread.start()

        capture_thread = threading.Thread(
            target=reader._capture_thread,
            daemon=True,
            name='ydb-video-face-reader-capture',
        )
        preprocess_thread = threading.Thread(
            target=reader._preprocess_thread,
            daemon=True,
            name='ydb-video-face-reader-preprocess',
        )
        setattr(reader, 'capture_thread', capture_thread)
        setattr(reader, 'preprocess_thread', preprocess_thread)
        capture_thread.start()
        preprocess_thread.start()
        log(f'Started one-shot special video face reader: {video_path}')

    def _install_runtime_patches(self):
        if self._runtime_patches_installed:
            return

        try:
            from bin.image_infer_v2.tools.realtime_face_reader.realtime_face_reader import RealtimeFaceReader
            from bin.image_infer_v2.tools.video_face_reader.video_face_reader import VideoFaceReader
            from bin.image_infer_v2.infer_api import VideoStreamManager
        except Exception as e:
            log(f'Failed to install runtime patches: {e}')
            return

        if not hasattr(RealtimeFaceReader, '_xiyiji_orig_start_capture'):
            RealtimeFaceReader._xiyiji_orig_start_capture = RealtimeFaceReader.start_capture
        if not hasattr(RealtimeFaceReader, '_xiyiji_orig_stop_capture'):
            RealtimeFaceReader._xiyiji_orig_stop_capture = RealtimeFaceReader.stop_capture
        if not hasattr(RealtimeFaceReader, '_xiyiji_orig_iter'):
            RealtimeFaceReader._xiyiji_orig_iter = RealtimeFaceReader.__iter__
        if not hasattr(RealtimeFaceReader, '_xiyiji_orig_next'):
            RealtimeFaceReader._xiyiji_orig_next = RealtimeFaceReader.__next__

        orig_start_capture = RealtimeFaceReader._xiyiji_orig_start_capture
        orig_stop_capture = RealtimeFaceReader._xiyiji_orig_stop_capture
        orig_iter = RealtimeFaceReader._xiyiji_orig_iter
        orig_next = RealtimeFaceReader._xiyiji_orig_next

        if not hasattr(VideoFaceReader, '_xiyiji_orig_start_capture'):
            VideoFaceReader._xiyiji_orig_start_capture = VideoFaceReader.start_capture
        if not hasattr(VideoFaceReader, '_xiyiji_orig_rewind'):
            VideoFaceReader._xiyiji_orig_rewind = VideoFaceReader.rewind

        orig_video_start_capture = VideoFaceReader._xiyiji_orig_start_capture
        orig_video_rewind = VideoFaceReader._xiyiji_orig_rewind

        if not getattr(VideoStreamManager, '_xiyiji_safe_process_audio_batch', False):
            orig_process_audio_batch = getattr(VideoStreamManager, '_process_audio_batch', None)

            if orig_process_audio_batch is not None:
                def safe_process_audio_batch(inst, *args, **kwargs):
                    try:
                        return orig_process_audio_batch(inst, *args, **kwargs)
                    except AttributeError as exc:
                        player = getattr(inst, 'player', None)
                        if (
                            'upload_frame' in str(exc)
                            and (
                                not self.running
                                or self.manager is None
                                or player is None
                                or getattr(player, 'upload_frame', None) is None
                            )
                        ):
                            log('Ignoring late upload_frame after shutdown')
                            return None
                        raise

                VideoStreamManager._process_audio_batch = safe_process_audio_batch
                VideoStreamManager._xiyiji_safe_process_audio_batch = True
                log('Installed safe _process_audio_batch shutdown patch')

        if not getattr(VideoFaceReader, '_xiyiji_segment_capture_patch', False):
            def segment_aware_start_capture(inst, video_path):
                if self._is_file_mode_driving_segment_path(video_path):
                    return self._start_video_face_reader_capture_once(inst, video_path)
                return orig_video_start_capture(inst, video_path)

            def segment_aware_rewind(inst):
                video_path = getattr(inst, 'video_path', '')
                if self._is_file_mode_driving_segment_path(video_path):
                    return self._start_video_face_reader_capture_once(inst, video_path)
                return orig_video_rewind(inst)

            VideoFaceReader.start_capture = segment_aware_start_capture
            VideoFaceReader.rewind = segment_aware_rewind
            VideoFaceReader._xiyiji_segment_capture_patch = True
            log('Installed VideoFaceReader segment capture patch')

        if not getattr(RealtimeFaceReader, '_xiyiji_direct_capture_patch', False):
            def direct_start_capture(inst, camera_index):
                use_direct_preview = (
                    not self._tearing_down_manager
                    and
                    self._prefer_direct_camera
                    and (self.manager_input_mode == 'camera' or self._creating_camera_mode)
                )
                if not use_direct_preview:
                    return orig_start_capture(inst, camera_index)

                try:
                    resolved_index = int(camera_index)
                except Exception:
                    resolved_index = -1
                if resolved_index < 0:
                    return orig_start_capture(inst, camera_index)

                camera_name = self._resolve_camera_name(resolved_index)
                if not camera_name:
                    return orig_start_capture(inst, camera_index)

                self._mark_face_reader_direct_preview(inst, resolved_index, camera_name)
                self._ensure_direct_camera_preview(camera_index=resolved_index)
                if self._wait_for_direct_preview_frame(
                    timeout_s=float(os.environ.get('YDB_DIRECT_CAMERA_WARMUP', '3.5'))
                ):
                    log(
                        'RealtimeFaceReader.start_capture switched to direct preview mode '
                        f'(camera_index={resolved_index}, name={camera_name})'
                    )
                    return None

                log(
                    'Direct preview camera warmup timed out; falling back to native capture '
                    f'(camera_index={resolved_index}, name={camera_name})'
                )
                self._stop_direct_camera_preview()
                self._clear_face_reader_direct_preview(inst)
                return orig_start_capture(inst, camera_index)

            def direct_stop_capture(inst):
                if self._camera_uses_direct_preview(inst):
                    if (
                        self._use_proxy_native_camera
                        and self._proxy_camera_reader is inst
                        and self._proxy_camera_thread is not None
                        and threading.current_thread() is self._proxy_camera_thread
                    ):
                        return orig_stop_capture(inst)
                    self._clear_face_reader_direct_preview(inst)
                    self._stop_direct_camera_preview()
                    log('RealtimeFaceReader.stop_capture handled by direct preview patch')
                    return None
                return orig_stop_capture(inst)

            RealtimeFaceReader.start_capture = direct_start_capture
            RealtimeFaceReader.stop_capture = direct_stop_capture
            RealtimeFaceReader._xiyiji_direct_capture_patch = True
            log('Installed RealtimeFaceReader direct camera patch')

        if not getattr(RealtimeFaceReader, '_xiyiji_direct_iter_patch', False):
            def direct_iter(inst):
                if self._camera_uses_direct_preview(inst):
                    return inst
                return orig_iter(inst)

            RealtimeFaceReader.__iter__ = direct_iter
            RealtimeFaceReader._xiyiji_direct_iter_patch = True
            log('Installed RealtimeFaceReader direct iterator patch')

        if not getattr(RealtimeFaceReader, '_xiyiji_normalized_next', False):
            def normalized_next(inst, *args, **kwargs):
                if self._camera_uses_direct_preview(inst):
                    direct_info = self._direct_face_readers.get(id(inst), {})
                    direct_index = direct_info.get('camera_index', -1)
                    if self._tearing_down_manager:
                        raise StopIteration
                    self._ensure_direct_camera_preview(camera_index=direct_index)
                    for attempt in range(_CAMERA_NEXT_RETRY_COUNT):
                        if not self.running or self.manager is None or self._tearing_down_manager:
                            raise StopIteration
                        direct_result = self._direct_preview_next_result(inst)
                        if direct_result is not None:
                            self._direct_next_return_count += 1
                            if _DEBUG_TRACE_CAMERA and (
                                self._direct_next_return_count <= 5
                                or self._direct_next_return_count % 50 == 0
                            ):
                                log(
                                    'RealtimeFaceReader.__next__ returned direct preview frame '
                                    f'(count={self._direct_next_return_count})'
                                )
                            return direct_result
                        if attempt < 5 or (attempt + 1) % 10 == 0:
                            log(
                                'RealtimeFaceReader.__next__ waiting for direct preview frame; '
                                f'retrying {attempt + 1}/{_CAMERA_NEXT_RETRY_COUNT}'
                            )
                        time.sleep(_CAMERA_NEXT_RETRY_DELAY)
                    raise StopIteration

                last_exc = None
                for attempt in range(_CAMERA_NEXT_RETRY_COUNT):
                    try:
                        frames, detections = orig_next(inst, *args, **kwargs)
                        break
                    except StopIteration as exc:
                        last_exc = exc
                        if self.manager_input_mode != 'camera' or attempt + 1 >= _CAMERA_NEXT_RETRY_COUNT:
                            raise
                        self._ensure_direct_camera_preview()
                        direct_result = self._direct_preview_next_result(inst)
                        if direct_result is not None:
                            return direct_result
                        if attempt < 5 or (attempt + 1) % 10 == 0:
                            log(
                                f'RealtimeFaceReader.__next__ raised StopIteration; '
                                f'retrying {attempt + 1}/{_CAMERA_NEXT_RETRY_COUNT}'
                            )
                        if not self._direct_preview_started:
                            self._restart_camera_capture()
                        time.sleep(_CAMERA_NEXT_RETRY_DELAY)
                    except Exception as exc:
                        last_exc = exc
                        if self.manager_input_mode != 'camera' or attempt + 1 >= _CAMERA_NEXT_RETRY_COUNT:
                            raise
                        self._ensure_direct_camera_preview()
                        direct_result = self._direct_preview_next_result(inst)
                        if direct_result is not None:
                            return direct_result
                        if attempt < 5 or (attempt + 1) % 10 == 0:
                            log(
                                f'RealtimeFaceReader.__next__ error ({type(exc).__name__}: {exc}); '
                                f'retrying {attempt + 1}/{_CAMERA_NEXT_RETRY_COUNT}'
                            )
                        if not self._direct_preview_started:
                            self._restart_camera_capture()
                        time.sleep(_CAMERA_NEXT_RETRY_DELAY)
                else:
                    if last_exc is not None:
                        raise last_exc
                    raise StopIteration

                if _DEBUG_DUMP_CAMERA_NEXT and self.manager_input_mode == 'camera' and self._camera_next_dump_count < 6:
                    try:
                        from PIL import Image
                        dump_dir = Path(os.environ.get('YDB_DEBUG_DUMP_DIR', Path.cwd() / 'tmp' / 'ydb_next_frames'))
                        dump_dir.mkdir(parents=True, exist_ok=True)
                        for idx, frame in enumerate(frames[:2]):
                            if not isinstance(frame, np.ndarray) or frame.size == 0:
                                continue
                            arr = frame if frame.dtype == np.uint8 else np.clip(frame, 0, 255).astype(np.uint8)
                            Image.fromarray(arr[:, :, ::-1] if arr.ndim == 3 and arr.shape[2] >= 3 else arr).save(
                                dump_dir / f'next_{self._camera_next_dump_count + 1}_frame{idx}.jpg'
                            )
                        log(f'DEBUG next detections #{self._camera_next_dump_count + 1}: {detections}')
                        self._camera_next_dump_count += 1
                    except Exception as dump_exc:
                        log(f'DEBUG next dump failed: {dump_exc}')

                normalized_detections = self._normalize_detection_batches(detections)
                normalized_detections = self._stabilize_detection_batches(frames, normalized_detections)
                return frames, normalized_detections

            RealtimeFaceReader.__next__ = normalized_next
            RealtimeFaceReader._xiyiji_normalized_next = True
            log('Installed RealtimeFaceReader detection normalization patch')

        self._runtime_patches_installed = True

    def _install_origin_frame_runtime_patches(self):
        if self._origin_frame_runtime_patches_installed:
            return

        try:
            from bin.image_infer_origin_frame.tools.video_face_reader.video_face_reader import (
                VideoFaceReader as OriginFrameVideoFaceReader,
            )
            from bin.image_infer_origin_frame.infer_api import (
                FrameData as OriginFrameFrameData,
                VideoStreamManager as OriginFrameVideoStreamManager,
            )
            self._origin_frame_infer_api_module = sys.modules.get(
                getattr(OriginFrameVideoStreamManager, '__module__', '')
            )
        except Exception as e:
            log(f'Failed to install origin-frame runtime patches: {e}')
            return

        if not hasattr(OriginFrameVideoFaceReader, '_xiyiji_orig_start_capture'):
            OriginFrameVideoFaceReader._xiyiji_orig_start_capture = OriginFrameVideoFaceReader.start_capture
        if not hasattr(OriginFrameVideoFaceReader, '_xiyiji_orig_stop_capture'):
            OriginFrameVideoFaceReader._xiyiji_orig_stop_capture = OriginFrameVideoFaceReader.stop_capture
        if not hasattr(OriginFrameVideoFaceReader, '_xiyiji_orig_rewind'):
            OriginFrameVideoFaceReader._xiyiji_orig_rewind = OriginFrameVideoFaceReader.rewind
        if not hasattr(OriginFrameVideoFaceReader, '_xiyiji_orig_iter'):
            OriginFrameVideoFaceReader._xiyiji_orig_iter = OriginFrameVideoFaceReader.__iter__
        if not hasattr(OriginFrameVideoFaceReader, '_xiyiji_orig_next'):
            OriginFrameVideoFaceReader._xiyiji_orig_next = OriginFrameVideoFaceReader.__next__
        if not hasattr(OriginFrameVideoStreamManager, '_xiyiji_orig_add_audio_to_queue'):
            OriginFrameVideoStreamManager._xiyiji_orig_add_audio_to_queue = (
                OriginFrameVideoStreamManager.add_audio_to_queue
            )
        if not hasattr(OriginFrameVideoStreamManager, '_xiyiji_orig_extract_audio_features'):
            OriginFrameVideoStreamManager._xiyiji_orig_extract_audio_features = (
                OriginFrameVideoStreamManager.extract_audio_features
            )
        if not hasattr(OriginFrameVideoStreamManager, '_xiyiji_orig_get_next_audio_batch'):
            OriginFrameVideoStreamManager._xiyiji_orig_get_next_audio_batch = (
                getattr(OriginFrameVideoStreamManager, '_get_next_audio_batch', None)
            )
        if not hasattr(OriginFrameVideoStreamManager, '_xiyiji_orig_process_audio_batch'):
            OriginFrameVideoStreamManager._xiyiji_orig_process_audio_batch = (
                getattr(OriginFrameVideoStreamManager, '_process_audio_batch', None)
            )
        if not hasattr(OriginFrameVideoStreamManager, '_xiyiji_orig_get_one_boomerang_frame'):
            OriginFrameVideoStreamManager._xiyiji_orig_get_one_boomerang_frame = (
                OriginFrameVideoStreamManager._get_one_boomerang_frame
            )

        orig_start_capture = OriginFrameVideoFaceReader._xiyiji_orig_start_capture
        orig_stop_capture = OriginFrameVideoFaceReader._xiyiji_orig_stop_capture
        orig_rewind = OriginFrameVideoFaceReader._xiyiji_orig_rewind
        orig_iter = OriginFrameVideoFaceReader._xiyiji_orig_iter
        orig_next = OriginFrameVideoFaceReader._xiyiji_orig_next
        orig_add_audio_to_queue = OriginFrameVideoStreamManager._xiyiji_orig_add_audio_to_queue
        orig_extract_audio_features = OriginFrameVideoStreamManager._xiyiji_orig_extract_audio_features
        orig_get_next_audio_batch = OriginFrameVideoStreamManager._xiyiji_orig_get_next_audio_batch
        orig_process_audio_batch = OriginFrameVideoStreamManager._xiyiji_orig_process_audio_batch
        orig_get_one_boomerang_frame = OriginFrameVideoStreamManager._xiyiji_orig_get_one_boomerang_frame

        def _reader_path(inst) -> str:
            return str(
                getattr(inst, 'video_path', '')
                or getattr(inst, '_xiyiji_last_video_path', '')
                or ''
            ).strip()

        def _remember_reader_path(inst, video_path: str = '') -> str:
            resolved_path = str(video_path or _reader_path(inst) or '').strip()
            if not resolved_path:
                return ''

            try:
                setattr(inst, '_xiyiji_last_video_path', resolved_path)
            except Exception:
                pass
            try:
                setattr(inst, 'video_path', resolved_path)
            except Exception:
                pass
            return resolved_path

        def _thread_alive(thread_obj) -> bool:
            return bool(thread_obj is not None and getattr(thread_obj, 'is_alive', lambda: False)())

        def _reader_state(inst) -> dict:
            capture_thread = getattr(inst, 'capture_thread', None)
            preprocess_thread = getattr(inst, 'preprocess_thread', None)
            stop_event = getattr(inst, 'stop_event', None)
            return {
                'video_path': _reader_path(inst),
                'capture_alive': _thread_alive(capture_thread),
                'preprocess_alive': preprocess_thread is None or _thread_alive(preprocess_thread),
                'stop_set': bool(stop_event is not None and getattr(stop_event, 'is_set', lambda: False)()),
            }

        def _ensure_reader_ready(inst, reason: str = '') -> bool:
            video_path = _remember_reader_path(inst)
            if not video_path:
                log(
                    'Origin-frame reader recovery skipped: missing stored video path '
                    f'(reason={reason or "unspecified"})'
                )
                return False

            state = _reader_state(inst)
            restart_required = (
                not state['capture_alive']
                or not state['preprocess_alive']
                or state['stop_set']
            )
            if not restart_required:
                return True

            try:
                orig_stop_capture(inst)
            except Exception as exc:
                log(
                    'Origin-frame reader stop before restart failed: '
                    f'{exc} (reason={reason or "unspecified"})'
                )

            try:
                orig_start_capture(inst, video_path)
                _remember_reader_path(inst, video_path)
            except Exception as exc:
                log(
                    'Origin-frame reader restart failed: '
                    f'{exc} (reason={reason or "unspecified"}, video={video_path})'
                )
                return False

            state = _reader_state(inst)
            log(
                'Origin-frame reader restarted: '
                f'reason={reason or "unspecified"}, video={video_path}, '
                f'capture_alive={state["capture_alive"]}, '
                f'preprocess_alive={state["preprocess_alive"]}, '
                f'stop_set={state["stop_set"]}'
            )
            return True

        def _refresh_manager_iterator(inst, reason: str = '') -> bool:
            reader = getattr(inst, 'face_reader', None)
            if reader is None:
                log(
                    'Origin-frame manager iterator refresh skipped: face_reader unavailable '
                    f'(reason={reason or "unspecified"})'
                )
                return False

            if not _ensure_reader_ready(reader, reason=f'{reason or "refresh"}:reader'):
                return False

            try:
                iterator = orig_iter(reader)
            except Exception:
                try:
                    iterator = iter(reader)
                except Exception as exc:
                    log(
                        'Origin-frame manager iterator rebuild failed: '
                        f'{exc} (reason={reason or "unspecified"})'
                    )
                    return False

            try:
                setattr(inst, 'face_reader_iterator', iterator)
            except Exception as exc:
                log(
                    'Origin-frame manager iterator assign failed: '
                    f'{exc} (reason={reason or "unspecified"})'
                )
                return False

            log(f'Origin-frame manager iterator refreshed (reason={reason or "unspecified"})')
            return True

        def _soft_fetch_manager_reader_frame(inst, reason: str = ''):
            fetch_next_reader_frame = getattr(inst, '_fetch_next_reader_frame', None)
            if not callable(fetch_next_reader_frame):
                return None, None

            try:
                attempts = max(1, int(os.environ.get('YDB_ORIGIN_FRAME_EMPTY_FRAME_RETRY_COUNT', '6')))
            except Exception:
                attempts = 6
            try:
                delay = max(0.01, float(os.environ.get('YDB_ORIGIN_FRAME_EMPTY_FRAME_RETRY_DELAY', '0.08')))
            except Exception:
                delay = 0.08

            for attempt in range(attempts):
                frame, metadata = fetch_next_reader_frame()
                if frame is not None:
                    if attempt > 0:
                        log(
                            'Origin-frame reader soft-recovered frame: '
                            f'reason={reason or "unspecified"}, attempt={attempt + 1}/{attempts}'
                        )
                    return frame, metadata
                if attempt + 1 < attempts:
                    time.sleep(delay)
            return None, None

        if not getattr(OriginFrameVideoFaceReader, '_xiyiji_recovery_patch', False):
            def patched_start_capture(inst, video_path):
                resolved_path = _remember_reader_path(inst, video_path)
                result = orig_start_capture(inst, video_path)
                _remember_reader_path(inst, resolved_path)
                state = _reader_state(inst)
                log(
                    'Origin-frame reader start_capture: '
                    f'video={resolved_path or "(empty)"}, '
                    f'capture_alive={state["capture_alive"]}, '
                    f'preprocess_alive={state["preprocess_alive"]}, '
                    f'stop_set={state["stop_set"]}'
                )
                return result

            def patched_stop_capture(inst):
                preserved_path = _remember_reader_path(inst)
                try:
                    return orig_stop_capture(inst)
                finally:
                    _remember_reader_path(inst, preserved_path)
                    log(
                        'Origin-frame reader stop_capture: '
                        f'preserved_video={preserved_path or "(empty)"}'
                    )

            def patched_rewind(inst):
                video_path = _remember_reader_path(inst)
                if not video_path:
                    log('Origin-frame reader rewind requested without stored video path')
                    return orig_rewind(inst)

                if not _ensure_reader_ready(inst, reason='rewind'):
                    return orig_start_capture(inst, video_path)

                try:
                    _remember_reader_path(inst, video_path)
                    return orig_rewind(inst)
                except Exception as exc:
                    message = str(exc)
                    recoverable = (
                        'Cannot rewind' in message
                        or 'start_capture' in message
                        or '迭代之前调用' in message
                        or 'no video path stored' in message
                    )
                    if not recoverable:
                        raise

                    log(
                        'Origin-frame reader rewind recovered by restart: '
                        f'{message} (video={video_path})'
                    )
                    if not _ensure_reader_ready(inst, reason='rewind-retry'):
                        raise
                    return orig_start_capture(inst, video_path)

            def patched_iter(inst):
                _ensure_reader_ready(inst, reason='iter')
                return orig_iter(inst)

            def patched_next(inst, *args, **kwargs):
                active_origin_frame_reader = (
                    self.manager_input_mode == 'file'
                    and self.manager_file_mode_backend == 'origin_frame'
                    and self.manager is not None
                    and getattr(self.manager, 'face_reader', None) is inst
                )
                if not active_origin_frame_reader:
                    _ensure_reader_ready(inst, reason='next')
                try:
                    return orig_next(inst, *args, **kwargs)
                except Exception as exc:
                    message = str(exc)
                    recoverable = (
                        'start_capture' in message
                        or '迭代之前调用' in message
                        or 'Cannot rewind' in message
                        or 'no video path stored' in message
                    )
                    if not recoverable:
                        raise

                    log(f'Origin-frame reader __next__ recoverable error: {message}')
                    if not _ensure_reader_ready(inst, reason='next-retry'):
                        raise
                    return orig_next(inst, *args, **kwargs)

            OriginFrameVideoFaceReader.start_capture = patched_start_capture
            OriginFrameVideoFaceReader.stop_capture = patched_stop_capture
            OriginFrameVideoFaceReader.rewind = patched_rewind
            OriginFrameVideoFaceReader.__iter__ = patched_iter
            OriginFrameVideoFaceReader.__next__ = patched_next
            OriginFrameVideoFaceReader._xiyiji_recovery_patch = True
            log('Installed origin-frame VideoFaceReader recovery patch')

        if not getattr(OriginFrameVideoStreamManager, '_xiyiji_recovery_patch', False):
            orig_process_and_manage_audio = getattr(OriginFrameVideoStreamManager, 'process_and_manage_audio', None)

            def patched_add_audio_to_queue(inst, audio_path: str, queue_name='normal'):
                before_lengths = {}
                get_queue_lengths = getattr(inst, 'get_queue_lengths', None)
                if callable(get_queue_lengths):
                    try:
                        before_lengths = dict(get_queue_lengths() or {})
                    except Exception:
                        before_lengths = {}

                started_at = time.time()
                log(
                    'Origin-frame add_audio_to_queue begin: '
                    f'audio={audio_path}, queue={queue_name}, before={before_lengths}'
                )
                try:
                    result = orig_add_audio_to_queue(inst, audio_path, queue_name=queue_name)
                except Exception as exc:
                    elapsed = time.time() - started_at
                    log(
                        'Origin-frame add_audio_to_queue error: '
                        f'audio={audio_path}, queue={queue_name}, elapsed={elapsed:.2f}s, error={exc}'
                    )
                    raise

                after_lengths = {}
                if callable(get_queue_lengths):
                    try:
                        after_lengths = dict(get_queue_lengths() or {})
                    except Exception:
                        after_lengths = {}
                elapsed = time.time() - started_at
                log(
                    'Origin-frame add_audio_to_queue end: '
                    f'audio={audio_path}, queue={queue_name}, elapsed={elapsed:.2f}s, after={after_lengths}'
                )
                return result

            def patched_extract_audio_features(inst, audio_path):
                started_at = time.time()
                log(f'Origin-frame extract_audio_features begin: audio={audio_path}')
                override = self._take_origin_frame_audio_feature_override(audio_path)
                if override is not None:
                    prepared_batches = override.get('batches')
                    source_tag = str(override.get('source') or 'prepared')
                    try:
                        result_len = len(prepared_batches)
                    except Exception:
                        result_len = 'unknown'
                    elapsed = time.time() - started_at
                    log(
                        'Origin-frame extract_audio_features override: '
                        f'audio={audio_path}, source={source_tag}, '
                        f'elapsed={elapsed:.2f}s, len={result_len}'
                    )
                    return prepared_batches
                try:
                    result = orig_extract_audio_features(inst, audio_path)
                except Exception as exc:
                    elapsed = time.time() - started_at
                    log(
                        'Origin-frame extract_audio_features error: '
                        f'audio={audio_path}, elapsed={elapsed:.2f}s, error={exc}'
                    )
                    raise
                elapsed = time.time() - started_at
                try:
                    result_len = len(result)
                except Exception:
                    result_len = 'unknown'
                log(
                    'Origin-frame extract_audio_features end: '
                    f'audio={audio_path}, elapsed={elapsed:.2f}s, len={result_len}'
                )
                return result

            def patched_get_one_boomerang_frame(inst):
                if (
                    self.manager is inst
                    and self.manager_input_mode == 'file'
                    and self.manager_file_mode_backend == 'origin_frame'
                ):
                    try:
                        frame, metadata = _soft_fetch_manager_reader_frame(
                            inst,
                            reason='boomerang-override',
                        )
                        if frame is not None:
                            metadata = dict(metadata or {})
                            physical_index = metadata.get('physical_index')
                            if physical_index is None:
                                physical_index = metadata.get('frame_index')
                            if physical_index is None:
                                physical_index = metadata.get('index')
                            try:
                                physical_index = int(physical_index)
                            except Exception:
                                physical_index = -1
                            log(
                                'Origin-frame boomerang override: using sequential driving frame '
                                f'(physical_index={physical_index})'
                            )
                            return frame, metadata
                        fallback_frame = self._latest_origin_frame_frame()
                        if fallback_frame is not None:
                            try:
                                physical_index = int(getattr(inst, 'last_frame_index', -1))
                            except Exception:
                                physical_index = -1
                            metadata = {
                                'physical_index': physical_index,
                                'frame_index': physical_index,
                                'index': physical_index,
                                'source': 'xiyiji_last_good_origin_frame',
                            }
                            log(
                                'Origin-frame boomerang override: reader empty; '
                                f'using last uploaded frame (physical_index={physical_index})'
                            )
                            return fallback_frame, metadata

                        if not self._pending_audio and _refresh_manager_iterator(inst, reason='boomerang-override'):
                            frame, metadata = _soft_fetch_manager_reader_frame(
                                inst,
                                reason='boomerang-override-refresh',
                            )
                            if frame is not None:
                                metadata = dict(metadata or {})
                                physical_index = metadata.get('physical_index')
                                if physical_index is None:
                                    physical_index = metadata.get('frame_index')
                                if physical_index is None:
                                    physical_index = metadata.get('index')
                                try:
                                    physical_index = int(physical_index)
                                except Exception:
                                    physical_index = -1
                                log(
                                    'Origin-frame boomerang override: using sequential driving frame '
                                    f'after idle refresh (physical_index={physical_index})'
                                )
                                return frame, metadata
                        log('Origin-frame boomerang override: no reader frame available')
                    except Exception as exc:
                        log(f'Origin-frame boomerang override failed: {exc}')
                    fallback_frame = self._latest_origin_frame_frame()
                    if fallback_frame is not None:
                        try:
                            physical_index = int(getattr(inst, 'last_frame_index', -1))
                        except Exception:
                            physical_index = -1
                        metadata = {
                            'physical_index': physical_index,
                            'frame_index': physical_index,
                            'index': physical_index,
                            'source': 'xiyiji_last_good_origin_frame',
                        }
                        log(
                            'Origin-frame boomerang override: using last uploaded frame '
                            f'(physical_index={physical_index})'
                        )
                        return fallback_frame, metadata
                log('Origin-frame boomerang frame requested')
                return orig_get_one_boomerang_frame(inst)

            if orig_process_and_manage_audio is not None:
                def patched_process_and_manage_audio(inst, *args, **kwargs):
                    recovery_count = 0
                    while True:
                        try:
                            return orig_process_and_manage_audio(inst, *args, **kwargs)
                        except Exception as exc:
                            message = str(exc)
                            recoverable = (
                                'start_capture' in message
                                or '迭代之前调用' in message
                                or 'Cannot rewind' in message
                                or 'no video path stored' in message
                            )
                            if not recoverable or recovery_count >= 2 or not self.running:
                                raise

                            recovery_count += 1
                            log(
                                'Origin-frame process loop recoverable error: '
                                f'{message} (recovery={recovery_count})'
                            )
                            if not _refresh_manager_iterator(
                                inst,
                                reason=f'process-loop-recovery#{recovery_count}',
                            ):
                                raise
                            time.sleep(0.1)

                OriginFrameVideoStreamManager.add_audio_to_queue = patched_add_audio_to_queue
                OriginFrameVideoStreamManager.extract_audio_features = patched_extract_audio_features
                OriginFrameVideoStreamManager._get_one_boomerang_frame = patched_get_one_boomerang_frame
                OriginFrameVideoStreamManager.process_and_manage_audio = patched_process_and_manage_audio

            if (
                orig_get_next_audio_batch is not None
                and not getattr(OriginFrameVideoStreamManager, '_xiyiji_debug_get_next_audio_batch', False)
            ):
                def patched_get_next_audio_batch(inst, *args, **kwargs):
                    if not _DEBUG_ORIGIN_FRAME_AUDIO_FLOW:
                        return orig_get_next_audio_batch(inst, *args, **kwargs)

                    try:
                        debug_call_index = int(getattr(inst, '_xiyiji_debug_get_next_audio_batch_calls', 0))
                    except Exception:
                        debug_call_index = 0
                    setattr(inst, '_xiyiji_debug_get_next_audio_batch_calls', debug_call_index + 1)
                    should_log = debug_call_index < 12

                    def _queue_detail() -> dict:
                        audio_queues = getattr(inst, 'audio_queues', None)
                        detail = {}
                        if isinstance(audio_queues, dict):
                            for queue_name, queue_obj in audio_queues.items():
                                try:
                                    detail[str(queue_name)] = self._queue_like_length(queue_obj)
                                except Exception:
                                    detail[str(queue_name)] = 'err'
                        return detail

                    if should_log:
                        try:
                            log(
                                'Origin-frame _get_next_audio_batch begin: '
                                f'call={debug_call_index + 1}, args={len(args)}, '
                                f'kwargs={list(kwargs.keys())}, queue={_queue_detail()}, '
                                f'cursor={getattr(inst, "interaction_cursor", "na")}, '
                                f'cachedFrames={len(getattr(inst, "cached_interaction_frames", []) or [])}, '
                                f'cachedMetas={len(getattr(inst, "cached_interaction_metas", []) or [])}, '
                                f'currentAudio={getattr(inst, "current_interaction_audio_path", None)}'
                            )
                        except Exception as debug_exc:
                            log(f'Origin-frame _get_next_audio_batch begin debug failed: {debug_exc}')

                    result = orig_get_next_audio_batch(inst, *args, **kwargs)

                    if should_log:
                        try:
                            if isinstance(result, (list, tuple)):
                                result_len = len(result)
                                inner_types = [type(item).__name__ for item in result[:4]]
                            else:
                                result_len = 'na'
                                inner_types = []
                            log(
                                'Origin-frame _get_next_audio_batch end: '
                                f'call={debug_call_index + 1}, resultType={type(result).__name__}, '
                                f'resultLen={result_len}, innerTypes={inner_types}, '
                                f'queue={_queue_detail()}, cursor={getattr(inst, "interaction_cursor", "na")}'
                            )
                        except Exception as debug_exc:
                            log(f'Origin-frame _get_next_audio_batch end debug failed: {debug_exc}')

                    return result

                OriginFrameVideoStreamManager._get_next_audio_batch = patched_get_next_audio_batch
                OriginFrameVideoStreamManager._xiyiji_debug_get_next_audio_batch = True

            if (
                orig_process_audio_batch is not None
                and not getattr(OriginFrameVideoStreamManager, '_xiyiji_safe_process_audio_batch', False)
            ):
                def safe_origin_frame_process_audio_batch(inst, *args, **kwargs):
                    if _DEBUG_ORIGIN_FRAME_AUDIO_FLOW:
                        try:
                            debug_call_index = int(getattr(inst, '_xiyiji_debug_process_audio_batch_calls', 0))
                        except Exception:
                            debug_call_index = 0
                        setattr(inst, '_xiyiji_debug_process_audio_batch_calls', debug_call_index + 1)
                        if debug_call_index < 12:
                            arg_desc = []
                            for arg in args[:4]:
                                if isinstance(arg, (list, tuple)):
                                    arg_desc.append(f'{type(arg).__name__}(len={len(arg)})')
                                else:
                                    arg_desc.append(type(arg).__name__)
                            log(
                                'Origin-frame _process_audio_batch begin: '
                                f'call={debug_call_index + 1}, args={arg_desc}, '
                                f'kwargs={list(kwargs.keys())}, queue={self._get_queue_lengths_snapshot()}, '
                                f'cursor={getattr(inst, "interaction_cursor", "na")}, '
                                f'cachedFrames={len(getattr(inst, "cached_interaction_frames", []) or [])}, '
                                f'cachedMetas={len(getattr(inst, "cached_interaction_metas", []) or [])}'
                            )
                    try:
                        result = orig_process_audio_batch(inst, *args, **kwargs)
                        if _DEBUG_ORIGIN_FRAME_AUDIO_FLOW:
                            try:
                                current_debug_call = int(
                                    getattr(inst, '_xiyiji_debug_process_audio_batch_calls', 1)
                                ) - 1
                            except Exception:
                                current_debug_call = 0
                            if current_debug_call < 12:
                                log(
                                    'Origin-frame _process_audio_batch end: '
                                    f'call={current_debug_call + 1}, resultType={type(result).__name__}, '
                                    f'queue={self._get_queue_lengths_snapshot()}, '
                                    f'cursor={getattr(inst, "interaction_cursor", "na")}'
                                )
                        return result
                    except AttributeError as exc:
                        player = getattr(inst, 'player', None)
                        if (
                            'upload_frame' in str(exc)
                            and (
                                not self.running
                                or self.manager is None
                                or player is None
                                or getattr(player, 'upload_frame', None) is None
                            )
                        ):
                            log('Ignoring late origin-frame upload_frame after shutdown')
                            return None
                        raise

                OriginFrameVideoStreamManager._process_audio_batch = safe_origin_frame_process_audio_batch
                OriginFrameVideoStreamManager._xiyiji_safe_process_audio_batch = True
                log('Installed safe origin-frame _process_audio_batch shutdown patch')

            OriginFrameVideoStreamManager._xiyiji_recovery_patch = True
            log('Installed origin-frame VideoStreamManager recovery patch')

        self._origin_frame_runtime_patches_installed = True

    def _normalize_origin_frame_audio_bypass_path(self, raw_path: str) -> str:
        path = str(raw_path or '').strip()
        if not path:
            return ''
        remapped = _remap_to_runtime_alias(path)
        return os.path.normcase(os.path.normpath(remapped))

    def _normalize_origin_frame_audio_feature_path(self, raw_path: str) -> str:
        return self._normalize_origin_frame_audio_bypass_path(raw_path)

    def _take_origin_frame_audio_feature_override(self, audio_path: str):
        normalized_path = self._normalize_origin_frame_audio_feature_path(audio_path)
        if not normalized_path:
            return None

        with self._origin_frame_audio_feature_override_lock:
            overrides = self._origin_frame_audio_feature_overrides.get(normalized_path)
            if not overrides:
                return None
            override = overrides.pop(0)
            if not overrides:
                self._origin_frame_audio_feature_overrides.pop(normalized_path, None)
            return override

    @contextmanager
    def _origin_frame_audio_feature_override(self, audio_path: str, batches, source_tag: str):
        normalized_path = self._normalize_origin_frame_audio_feature_path(audio_path)
        if not normalized_path:
            raise RuntimeError('origin-frame audio override path is empty')

        override = {
            'batches': list(batches or []),
            'source': str(source_tag or 'prepared'),
            'created_at': time.time(),
        }
        with self._origin_frame_audio_feature_override_lock:
            self._origin_frame_audio_feature_overrides.setdefault(normalized_path, []).append(override)

        try:
            yield normalized_path
        finally:
            with self._origin_frame_audio_feature_override_lock:
                overrides = self._origin_frame_audio_feature_overrides.get(normalized_path)
                if not overrides:
                    return
                for idx, item in enumerate(overrides):
                    if item is override:
                        overrides.pop(idx)
                        break
                if not overrides:
                    self._origin_frame_audio_feature_overrides.pop(normalized_path, None)

    def _arm_origin_frame_audio_bypass(self, video_path: str):
        normalized_path = self._normalize_origin_frame_audio_bypass_path(video_path)
        if not normalized_path:
            self._origin_frame_audio_bypass_targets = set()
            return
        self._origin_frame_audio_bypass_targets = {normalized_path}
        log(f'Origin-frame original-audio bypass armed: {video_path}')

    def _install_origin_frame_audio_bypass_patch(self):
        log('Origin-frame original-audio bypass patch: enter')
        if self._origin_frame_audio_bypass_patch_installed:
            log('Origin-frame original-audio bypass patch already installed')
            return

        infer_api_module = self._origin_frame_infer_api_module
        if infer_api_module is None:
            log('Failed to install origin-frame original-audio bypass patch: infer_api module missing')
            return
        log('Origin-frame original-audio bypass patch: infer_api module ready')

        librosa_module = sys.modules.get('librosa')
        if librosa_module is None:
            try:
                librosa_module = importlib.import_module('librosa')
                log('Origin-frame original-audio bypass patch: imported librosa proactively')
            except Exception as exc:
                log(
                    'Origin-frame original-audio bypass patch skipped: '
                    f'failed to import librosa ({exc})'
                )
                return
        log('Origin-frame original-audio bypass patch: librosa module ready')

        librosa_dict = getattr(librosa_module, '__dict__', {})
        orig_load = librosa_dict.get('_xiyiji_orig_load')
        if not callable(orig_load):
            orig_load = librosa_dict.get('load')
        orig_getattr = librosa_dict.get('_xiyiji_orig_getattr')
        if not callable(orig_getattr):
            orig_getattr = librosa_dict.get('__getattr__')

        if not callable(orig_load) and not callable(orig_getattr):
            log('Origin-frame original-audio bypass patch skipped: librosa resolver unavailable')
            return
        if callable(orig_load):
            log('Origin-frame original-audio bypass patch: using preloaded librosa.load')
        else:
            log('Origin-frame original-audio bypass patch: using librosa.__getattr__("load") fallback')

        librosa_dict['_xiyiji_orig_load'] = orig_load
        librosa_dict['_xiyiji_orig_getattr'] = orig_getattr

        def patched_load(*args, **kwargs):
            target = args[0] if args else kwargs.get('path')
            normalized_target = self._normalize_origin_frame_audio_bypass_path(target)
            if (
                normalized_target
                and normalized_target in self._origin_frame_audio_bypass_targets
            ):
                raise RuntimeError(
                    'xiyiji origin-frame original audio bypass: '
                    f'{target}'
                )
            if callable(orig_load):
                return orig_load(*args, **kwargs)
            resolved_load = orig_getattr('load') if callable(orig_getattr) else None
            if not callable(resolved_load):
                raise RuntimeError('xiyiji origin-frame bypass fallback could not resolve librosa.load')
            return resolved_load(*args, **kwargs)

        librosa_dict['load'] = patched_load

        self._origin_frame_audio_bypass_patch_installed = True
        log('Installed origin-frame original-audio bypass patch')

    def _resolve_camera_name(self, camera_index: int) -> str:
        try:
            from bin.image_infer_v2.tools.realtime_face_reader.realtime_face_reader import RealtimeFaceReader
            cameras = RealtimeFaceReader.get_available_cameras()
            return str(cameras.get(camera_index, '')).strip()
        except Exception:
            return ''

    def _camera_log_sizes(self, sizes: dict) -> str:
        return (
            f'raw={sizes["raw"]}, processed={sizes["processed"]}, '
            f'buffer={sizes["buffer"]}, direct={sizes.get("direct", 0)}'
        )

    def _mark_face_reader_direct_preview(self, face_reader, camera_index: int, camera_name: str):
        if face_reader is None:
            return

        self._direct_face_readers[id(face_reader)] = {
            'camera_index': camera_index,
            'camera_name': camera_name,
        }

        stop_event = getattr(face_reader, 'stop_event', None)
        if not isinstance(stop_event, threading.Event):
            stop_event = threading.Event()
            try:
                setattr(face_reader, 'stop_event', stop_event)
            except Exception:
                stop_event = None

        if stop_event is not None:
            try:
                stop_event.clear()
            except Exception:
                pass
            for attr_name, thread_name in (
                ('capture_thread', 'xiyiji-direct-capture'),
                ('preprocess_thread', 'xiyiji-direct-preprocess'),
            ):
                try:
                    setattr(face_reader, attr_name, _DirectPreviewThreadHandle(stop_event, thread_name))
                except Exception:
                    pass

        for queue_name in ('raw_frames_queue', 'processed_frames_queue'):
            if getattr(face_reader, queue_name, None) is None:
                try:
                    setattr(face_reader, queue_name, qmod.Queue())
                except Exception:
                    pass

    def _clear_face_reader_direct_preview(self, face_reader):
        if face_reader is None:
            return
        self._direct_face_readers.pop(id(face_reader), None)
        stop_event = getattr(face_reader, 'stop_event', None)
        if isinstance(stop_event, threading.Event):
            try:
                stop_event.set()
            except Exception:
                pass

    def _camera_uses_direct_preview(self, face_reader=None) -> bool:
        if face_reader is None:
            face_reader = self._get_face_reader()
        if face_reader is None:
            return False
        return id(face_reader) in self._direct_face_readers

    def _wait_for_direct_preview_frame(self, timeout_s: float = 3.0) -> bool:
        deadline = time.time() + max(0.1, timeout_s)
        while time.time() < deadline:
            if self._get_direct_preview_frame() is not None:
                return True
            time.sleep(0.05)
        return self._get_direct_preview_frame() is not None

    def _select_direct_preview_frame(self, frame_bgr):
        if not isinstance(frame_bgr, np.ndarray) or frame_bgr.size == 0:
            return None
        try:
            import cv2
        except Exception:
            return frame_bgr.copy()

        src_h, src_w = frame_bgr.shape[:2]
        target_w = max(64, int(os.environ.get('YDB_DIRECT_PREVIEW_WIDTH', '720')))
        target_h = max(64, int(os.environ.get('YDB_DIRECT_PREVIEW_HEIGHT', '1280')))
        target_ratio = target_w / float(target_h)
        src_ratio = src_w / float(src_h)

        crop_x = 0
        crop_y = 0
        crop_w = src_w
        crop_h = src_h

        # Match the native portrait camera path more closely: keep the camera
        # upright, crop to portrait, then scale to the portrait working size.
        if src_ratio > target_ratio:
            crop_w = max(1, int(round(src_h * target_ratio)))
            crop_x = max(0, (src_w - crop_w) // 2)
        else:
            crop_h = max(1, int(round(src_w / target_ratio)))
            crop_y = max(0, (src_h - crop_h) // 2)

        cropped = frame_bgr[crop_y:crop_y + crop_h, crop_x:crop_x + crop_w]
        if cropped.size == 0:
            cropped = frame_bgr
            crop_x = 0
            crop_y = 0
            crop_w = src_w
            crop_h = src_h

        interpolation = cv2.INTER_AREA if crop_w > target_w or crop_h > target_h else cv2.INTER_LINEAR
        resized = cv2.resize(cropped, (target_w, target_h), interpolation=interpolation)
        if not self._direct_preview_layout_logged:
            self._direct_preview_layout_logged = True
            log(
                'Direct preview frame normalized '
                f'(src={src_w}x{src_h}, crop={crop_w}x{crop_h}@{crop_x},{crop_y}, '
                f'target={target_w}x{target_h})'
            )
        return resized.copy()

    def _stop_direct_camera_preview(self):
        self._direct_preview_stop.set()
        self._proxy_camera_stop.set()
        self._direct_preview_latest_frame = None
        self._direct_preview_camera_index = -1
        self._direct_preview_camera_name = ''
        self._last_preview_player_upload_at = 0.0
        self._direct_preview_layout_logged = False
        self._proxy_camera_latest_batch = None
        self._proxy_camera_error = ''
        self._proxy_camera_batch_count = 0
        self._proxy_camera_drop_count = 0
        proc = self._direct_preview_proc
        self._direct_preview_proc = None
        if proc is not None:
            try:
                proc.terminate()
            except Exception:
                pass
            try:
                proc.wait(timeout=2)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass
        thread = self._direct_preview_thread
        self._direct_preview_thread = None
        proxy_thread = self._proxy_camera_thread
        self._proxy_camera_thread = None
        proxy_stderr_thread = self._proxy_camera_stderr_thread
        self._proxy_camera_stderr_thread = None
        reader = self._proxy_camera_reader
        self._proxy_camera_reader = None
        if reader is not None:
            try:
                stop_capture = getattr(type(reader), '_xiyiji_orig_stop_capture', None)
                if callable(stop_capture):
                    stop_capture(reader)
            except Exception:
                pass
        if proxy_thread is not None and proxy_thread is not thread:
            try:
                proxy_thread.join(timeout=2)
            except Exception:
                pass
        if proxy_stderr_thread is not None:
            try:
                proxy_stderr_thread.join(timeout=2)
            except Exception:
                pass
        if thread is not None:
            try:
                thread.join(timeout=2)
            except Exception:
                pass
        self._clear_proxy_camera_queue()
        self._direct_preview_started = False

    def _reset_direct_detection_state(self):
        self._last_direct_detection = None
        self._last_positive_direct_detection = None
        self._last_direct_detection_at = 0.0
        self._last_positive_direct_detection_at = 0.0
        self._last_yolo_direct_detection_at = 0.0
        self._last_preview_detection_warmup_at = 0.0
        self._direct_detection_hit_count = 0
        self._direct_detection_miss_count = 0

    def _clear_proxy_camera_queue(self):
        self._drain_queue_like(self._proxy_camera_batch_queue)

    def _queue_proxy_camera_batch(self, batch):
        if batch is None:
            return
        while True:
            try:
                self._proxy_camera_batch_queue.put_nowait(batch)
                return
            except qmod.Full:
                self._proxy_camera_drop_count += 1
                try:
                    self._proxy_camera_batch_queue.get_nowait()
                except qmod.Empty:
                    return

    def _take_proxy_camera_batch(self, timeout_s: float = 0.0):
        if timeout_s > 0:
            try:
                return self._proxy_camera_batch_queue.get(timeout=max(0.01, timeout_s))
            except qmod.Empty:
                return None
        try:
            return self._proxy_camera_batch_queue.get_nowait()
        except qmod.Empty:
            return None

    def _start_proxy_native_camera_preview(self, camera_index: int, camera_name: str):
        self._direct_preview_stop.clear()
        self._proxy_camera_stop.clear()
        self._direct_preview_frame_count = 0
        self._direct_preview_upload_count = 0
        self._last_preview_player_upload_at = 0.0
        self._direct_preview_camera_index = camera_index
        self._direct_preview_camera_name = camera_name
        self._proxy_camera_latest_batch = None
        self._proxy_camera_error = ''
        self._proxy_camera_batch_count = 0
        self._proxy_camera_drop_count = 0
        self._clear_proxy_camera_queue()
        face_reader = self._get_face_reader()
        if face_reader is not None:
            self._mark_face_reader_direct_preview(face_reader, camera_index, camera_name)

        helper_candidates = [
            Path(__file__).with_name('yundingyunbo_camera_proxy.py'),
            Path(__file__).with_name('yundingyunbo_camera_proxy.pyc'),
        ]
        helper_script = next((candidate for candidate in helper_candidates if candidate.exists()), None)
        if helper_script is None:
            self._proxy_camera_error = f'missing helper script: {helper_candidates[0]}'
            log(f'Proxy native camera preview cannot start: helper script missing ({helper_candidates[0]})')
            return

        env = os.environ.copy()
        env['PYTHONIOENCODING'] = 'utf-8'
        env['YUNDINGYUNBO_BASE'] = YUNDINGYUNBO_BASE
        env['XIYIJI_DATA_DIR'] = DATA_DIR
        cmd = [sys.executable, '-u', str(helper_script), str(camera_index)]

        try:
            proc = subprocess.Popen(
                cmd,
                cwd=YUNDINGYUNBO_BASE,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                bufsize=0,
                env=env,
            )
        except Exception as e:
            self._proxy_camera_error = f'{type(e).__name__}: {e}'
            log(f'Proxy native camera preview failed to launch helper: {e}')
            return

        self._direct_preview_proc = proc

        def _read_exact(stream, size):
            chunks = []
            remaining = size
            while remaining > 0:
                chunk = stream.read(remaining)
                if not chunk:
                    return None
                chunks.append(chunk)
                remaining -= len(chunk)
            return b''.join(chunks)

        def _preview_loop():
            if proc.stdout is None:
                return
            try:
                while not self._proxy_camera_stop.is_set():
                    header = _read_exact(proc.stdout, 4)
                    if header is None:
                        break
                    payload_size = struct.unpack('<I', header)[0]
                    payload = _read_exact(proc.stdout, payload_size)
                    if payload is None:
                        break
                    try:
                        message = pickle.loads(payload)
                    except Exception as decode_exc:
                        self._proxy_camera_error = f'pickle decode failed: {decode_exc}'
                        log(f'Proxy native camera helper decode failed: {decode_exc}')
                        break

                    message_type = message.get('type')
                    if message_type == 'batch':
                        frames = message.get('frames') or []
                        if not frames:
                            continue
                        detections = self._normalize_detection_batches(message.get('detections') or [])
                        detections = self._stabilize_detection_batches(frames, detections)
                        frames = self._refine_source_batch_frames(frames, detections)
                        batch = (frames, detections)

                        preview_frame = frames[-1]
                        if isinstance(preview_frame, np.ndarray) and preview_frame.size > 0:
                            self._direct_preview_latest_frame = preview_frame.copy()
                            self._last_good_camera_frame = preview_frame.copy()

                        self._proxy_camera_latest_batch = batch
                        self._queue_proxy_camera_batch(batch)
                        self._proxy_camera_batch_count += 1
                        self._direct_preview_frame_count += len(frames)
                        if (
                            self._proxy_camera_batch_count <= 3
                            or self._proxy_camera_batch_count % 25 == 0
                        ):
                            log(
                                'Proxy native camera helper captured batch '
                                f'(count={self._proxy_camera_batch_count}, frames={len(frames)}, '
                                f'queue={self._proxy_camera_batch_queue.qsize()}, drops={self._proxy_camera_drop_count})'
                            )
                    elif message_type == 'started':
                        log(
                            'Proxy native camera helper started '
                            f'(camera_index={camera_index}, name={camera_name}, pid={proc.pid})'
                        )
                    elif message_type == 'error':
                        self._proxy_camera_error = str(message.get('error', 'unknown error'))
                        log(f'Proxy native camera helper error: {self._proxy_camera_error}')
                    elif message_type == 'status':
                        details = str(message.get('message', '')).strip()
                        if details:
                            log(f'Proxy native camera helper status: {details}')
            finally:
                if proc.poll() is None and self._proxy_camera_stop.is_set():
                    return
                if not self._proxy_camera_stop.is_set() and self._proxy_camera_error:
                    log(f'Proxy native camera helper exited without batches: {self._proxy_camera_error}')

        def _stderr_loop():
            if proc.stderr is None:
                return
            for raw_line in proc.stderr:
                if self._proxy_camera_stop.is_set():
                    break
                try:
                    text = raw_line.decode('utf-8', errors='replace').rstrip('\r\n')
                except Exception:
                    text = str(raw_line).rstrip('\r\n')
                if text:
                    log(f'Proxy helper: {text}')

        self._proxy_camera_thread = threading.Thread(
            target=_preview_loop,
            daemon=True,
            name='ydb-proxy-native-camera',
        )
        self._proxy_camera_stderr_thread = threading.Thread(
            target=_stderr_loop,
            daemon=True,
            name='ydb-proxy-native-camera-stderr',
        )
        self._direct_preview_thread = self._proxy_camera_thread
        self._proxy_camera_thread.start()
        self._proxy_camera_stderr_thread.start()
        self._direct_preview_started = True
        log(
            'Started proxy native camera preview: '
            f'camera_index={camera_index}, name={camera_name}'
        )

    def _ensure_direct_camera_preview(self, camera_index=None):
        if self._tearing_down_manager or not self.running:
            return
        if camera_index is None:
            if self.manager_input_mode == 'camera' and self.manager is not None:
                camera_index = getattr(self.manager, 'camera_index', -1)
            else:
                camera_index = self._direct_preview_camera_index
        try:
            camera_index = int(camera_index)
        except Exception:
            camera_index = -1
        camera_name = self._resolve_camera_name(camera_index)
        if camera_index < 0 or not camera_name:
            return
        if (
            self._direct_preview_started
            and camera_index == self._direct_preview_camera_index
            and camera_name == self._direct_preview_camera_name
            and (
                not self._use_proxy_native_camera
                or (self._proxy_camera_thread is not None and self._proxy_camera_thread.is_alive())
            )
        ):
            return
        if self._direct_preview_started:
            self._stop_direct_camera_preview()

        if self._use_proxy_native_camera:
            self._start_proxy_native_camera_preview(camera_index, camera_name)
            return

        ffmpeg_path = os.path.join(YUNDINGYUNBO_BASE, 'env', 'ffmpeg', 'bin', 'ffmpeg.exe')
        if not os.path.exists(ffmpeg_path):
            ffmpeg_path = 'ffmpeg'

        self._direct_preview_stop.clear()
        self._direct_preview_frame_count = 0
        self._direct_preview_upload_count = 0
        self._last_preview_player_upload_at = 0.0
        self._direct_preview_camera_index = camera_index
        self._direct_preview_camera_name = camera_name

        def _preview_loop():
            frame_size = 1280 * 720 * 3
            attempt = 0
            while not self._direct_preview_stop.is_set():
                attempt += 1
                cmd = [
                    ffmpeg_path,
                    '-nostdin',
                    '-f', 'dshow',
                    '-vcodec', 'mjpeg',
                    '-framerate', '30',
                    '-video_size', '1280x720',
                    '-rtbufsize', '150M',
                    '-i', f'video={camera_name}',
                    '-pix_fmt', 'bgr24',
                    '-vcodec', 'rawvideo',
                    '-f', 'image2pipe',
                    '-',
                ]
                try:
                    if attempt <= 3:
                        log(
                            'Direct camera preview fallback ffmpeg starting '
                            f'(attempt={attempt}, camera={camera_name}, index={camera_index})'
                        )
                    proc = subprocess.Popen(
                        cmd,
                        stdin=subprocess.DEVNULL,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.DEVNULL,
                    )
                    self._direct_preview_proc = proc
                    while not self._direct_preview_stop.is_set():
                        if proc.stdout is None:
                            break
                        data = proc.stdout.read(frame_size)
                        if len(data) != frame_size:
                            if self._direct_preview_frame_count == 0:
                                log(
                                    'Direct camera preview fallback incomplete frame '
                                    f'(bytes={len(data)}, expected={frame_size})'
                                )
                            break
                        frame = np.frombuffer(data, dtype=np.uint8).reshape((720, 1280, 3))
                        frame = self._select_direct_preview_frame(frame)
                        if frame is None:
                            continue
                        self._direct_preview_frame_count += 1
                        if self._direct_preview_frame_count <= 3:
                            log(
                                'Direct camera preview fallback captured frame '
                                f'(count={self._direct_preview_frame_count})'
                            )
                        self._direct_preview_latest_frame = frame.copy()
                        self._last_good_camera_frame = frame.copy()
                        time.sleep(0.01)
                except Exception as e:
                    log(f'Direct camera preview fallback failed: {e}')
                finally:
                    old_proc = self._direct_preview_proc
                    self._direct_preview_proc = None
                    if old_proc is not None:
                        try:
                            old_proc.terminate()
                        except Exception:
                            pass
                        try:
                            old_proc.wait(timeout=1)
                        except Exception:
                            try:
                                old_proc.kill()
                            except Exception:
                                pass
                if not self._direct_preview_stop.is_set():
                    time.sleep(0.5)

        self._direct_preview_thread = threading.Thread(
            target=_preview_loop,
            daemon=True,
            name='ydb-direct-preview',
        )
        self._direct_preview_thread.start()
        self._direct_preview_started = True
        log(f'Started direct camera preview fallback: camera_index={camera_index}, name={camera_name}')

    def _get_direct_preview_frame(self):
        frame = self._direct_preview_latest_frame
        if isinstance(frame, np.ndarray) and frame.size > 0:
            return frame.copy()
        return None

    def _clone_detection(self, detection):
        if detection is None:
            return None
        cloned = {}
        for key, value in detection.items():
            if isinstance(value, np.ndarray):
                cloned[key] = value.copy()
            else:
                cloned[key] = value
        return cloned

    def _normalize_detection_batches(self, detections):
        normalized_detections = []
        if detections is None:
            return normalized_detections

        for detection in detections:
            if detection is None:
                normalized_detections.append([])
            elif isinstance(detection, list):
                normalized_list = []
                for item in detection:
                    if isinstance(item, dict):
                        if item.get('is_no_face'):
                            continue
                        normalized_list.append(
                            {key: value for key, value in item.items() if key != 'is_no_face'}
                        )
                    else:
                        normalized_list.append(item)
                normalized_detections.append(normalized_list)
            elif isinstance(detection, dict):
                if detection.get('is_no_face'):
                    normalized_detections.append([])
                else:
                    normalized_detections.append([
                        {key: value for key, value in detection.items() if key != 'is_no_face'}
                    ])
            else:
                normalized_detections.append(detection)
        return normalized_detections

    def _clone_batch_result(self, frames, detections):
        cloned_frames = []
        if frames is not None:
            for frame in frames:
                if isinstance(frame, np.ndarray):
                    cloned_frames.append(frame.copy())
                else:
                    cloned_frames.append(frame)

        cloned_detections = []
        for detection_group in self._normalize_detection_batches(detections):
            if isinstance(detection_group, list):
                cloned_detections.append([
                    self._clone_detection(item) if isinstance(item, dict) else item
                    for item in detection_group
                ])
            elif isinstance(detection_group, dict):
                cloned_detections.append(self._clone_detection(detection_group))
            else:
                cloned_detections.append(detection_group)
        return cloned_frames, cloned_detections

    def _primary_detection_from_group(self, detection_group):
        if isinstance(detection_group, dict):
            return self._clone_detection(detection_group)
        if isinstance(detection_group, list):
            for item in detection_group:
                if isinstance(item, dict):
                    return self._clone_detection(item)
        return None

    def _prepare_detection(self, detection, frame_shape):
        if not isinstance(detection, dict):
            return None

        prepared = {
            key: value for key, value in detection.items() if key != 'is_no_face'
        }

        landmarks = prepared.get('landmarks')
        if isinstance(landmarks, np.ndarray):
            try:
                prepared['landmarks'] = landmarks.astype(np.float32, copy=True)
            except Exception:
                prepared['landmarks'] = landmarks.copy()

        box = prepared.get('bbox')
        if isinstance(box, np.ndarray):
            clamped_box = self._clamp_detection_box(box, frame_shape)
        elif box is not None:
            clamped_box = self._clamp_detection_box(np.array(box, dtype=np.float32), frame_shape)
        else:
            clamped_box = None

        if clamped_box is None and isinstance(prepared.get('landmarks'), np.ndarray):
            rebuilt = self._build_detection_from_landmarks(prepared['landmarks'], frame_shape)
            if rebuilt is not None:
                prepared = rebuilt
                clamped_box = rebuilt.get('bbox')

        if clamped_box is None:
            return None

        prepared['bbox'] = clamped_box
        return prepared

    def _stabilize_detection(self, detection, frame_shape):
        prepared = self._prepare_detection(detection, frame_shape)
        if prepared is None:
            return None

        now = time.time()
        prev = self._last_positive_direct_detection
        prev_at = self._last_positive_direct_detection_at
        sticky_seconds = max(0.15, float(os.environ.get('YDB_MOUTH_REFINE_STICKY_SECONDS', '0.80')))

        if (
            isinstance(prev, dict)
            and now - prev_at <= sticky_seconds
        ):
            prev_box = prev.get('bbox')
            new_box = prepared.get('bbox')
            if isinstance(prev_box, np.ndarray) and isinstance(new_box, np.ndarray):
                prev_w = max(1.0, float(prev_box[2] - prev_box[0]))
                prev_h = max(1.0, float(prev_box[3] - prev_box[1]))
                prev_cx = float(prev_box[0] + prev_box[2]) * 0.5
                prev_cy = float(prev_box[1] + prev_box[3]) * 0.5
                new_cx = float(new_box[0] + new_box[2]) * 0.5
                new_cy = float(new_box[1] + new_box[3]) * 0.5
                jump = max(abs(new_cx - prev_cx), abs(new_cy - prev_cy))
                max_jump = max(prev_w, prev_h) * max(
                    0.18,
                    float(os.environ.get('YDB_MOUTH_REFINE_MAX_JUMP_RATIO', '0.42')),
                )
                if jump <= max_jump:
                    bbox_alpha = min(0.95, max(0.15, float(os.environ.get('YDB_MOUTH_REFINE_BBOX_ALPHA', '0.62'))))
                    mixed_box = prev_box.astype(np.float32) * (1.0 - bbox_alpha) + new_box.astype(np.float32) * bbox_alpha
                    prepared['bbox'] = self._clamp_detection_box(mixed_box, frame_shape)

                    prev_landmarks = prev.get('landmarks')
                    new_landmarks = prepared.get('landmarks')
                    if (
                        isinstance(prev_landmarks, np.ndarray)
                        and isinstance(new_landmarks, np.ndarray)
                        and prev_landmarks.shape == new_landmarks.shape
                    ):
                        landmark_alpha = min(0.95, max(0.10, float(os.environ.get('YDB_MOUTH_REFINE_LANDMARK_ALPHA', '0.58'))))
                        mouth_alpha = min(0.95, max(0.05, float(os.environ.get('YDB_MOUTH_REFINE_MOUTH_ALPHA', '0.46'))))
                        mixed_landmarks = (
                            prev_landmarks.astype(np.float32) * (1.0 - landmark_alpha)
                            + new_landmarks.astype(np.float32) * landmark_alpha
                        )
                        if mixed_landmarks.shape[0] >= 68:
                            mixed_landmarks[48:68] = (
                                prev_landmarks[48:68].astype(np.float32) * (1.0 - mouth_alpha)
                                + new_landmarks[48:68].astype(np.float32) * mouth_alpha
                            )
                        prepared['landmarks'] = mixed_landmarks.astype(np.float32)

        stabilized = self._prepare_detection(prepared, frame_shape)
        if stabilized is None:
            return None

        self._last_direct_detection = self._clone_detection(stabilized)
        self._last_direct_detection_at = now
        self._last_positive_direct_detection = self._clone_detection(stabilized)
        self._last_positive_direct_detection_at = now
        return stabilized

    def _update_recent_detection_from_batch(self, frames, detections):
        if not frames or detections is None:
            return
        frame = frames[-1]
        if not isinstance(frame, np.ndarray) or frame.size == 0:
            return
        normalized = self._normalize_detection_batches(detections)
        if not normalized:
            return
        detection = self._primary_detection_from_group(normalized[-1])
        if detection is None:
            return
        self._stabilize_detection(detection, frame.shape)

    def _stabilize_detection_batches(self, frames, detections):
        if not frames or detections is None:
            return detections

        stabilized_batches = []
        for idx, detection_group in enumerate(detections):
            frame = frames[min(idx, len(frames) - 1)]
            if not isinstance(frame, np.ndarray) or frame.size == 0:
                stabilized_batches.append(detection_group)
                continue

            if isinstance(detection_group, list):
                stabilized_group = []
                for item_idx, item in enumerate(detection_group):
                    if not isinstance(item, dict):
                        stabilized_group.append(item)
                        continue
                    if item_idx == 0:
                        stabilized = self._stabilize_detection(item, frame.shape)
                        if stabilized is not None:
                            stabilized_group.append(stabilized)
                    else:
                        prepared = self._prepare_detection(item, frame.shape)
                        if prepared is not None:
                            stabilized_group.append(prepared)
                stabilized_batches.append(stabilized_group)
                continue

            if isinstance(detection_group, dict):
                stabilized = self._stabilize_detection(detection_group, frame.shape)
                stabilized_batches.append([stabilized] if stabilized is not None else [])
                continue

            stabilized_batches.append(detection_group)

        return stabilized_batches

    def _estimate_mouth_roi(self, detection, frame_shape):
        frame_h, frame_w = frame_shape[:2]
        landmarks = detection.get('landmarks') if isinstance(detection, dict) else None
        if isinstance(landmarks, np.ndarray) and landmarks.ndim == 2 and landmarks.shape[0] >= 60:
            mouth_points = landmarks[48:min(68, landmarks.shape[0])]
            if mouth_points.size > 0:
                x1, y1 = mouth_points.min(axis=0)
                x2, y2 = mouth_points.max(axis=0)
                mouth_w = max(6.0, float(x2 - x1))
                mouth_h = max(4.0, float(y2 - y1))
                return self._clamp_detection_box(
                    [
                        x1 - mouth_w * 0.55,
                        y1 - mouth_h * 0.75,
                        x2 + mouth_w * 0.55,
                        y2 + mouth_h * 1.10,
                    ],
                    frame_shape,
                )

        box = detection.get('bbox') if isinstance(detection, dict) else None
        if isinstance(box, np.ndarray) and box.size == 4:
            x1, y1, x2, y2 = [float(v) for v in box]
            box_w = max(8.0, x2 - x1)
            box_h = max(8.0, y2 - y1)
            return self._clamp_detection_box(
                [
                    x1 + box_w * 0.18,
                    y1 + box_h * 0.54,
                    x2 - box_w * 0.18,
                    y1 + box_h * 0.90,
                ],
                frame_shape,
            )
        return None

    def _mouth_refine_mask(self, height: int, width: int):
        key = (int(height), int(width))
        cached = self._mouth_refine_mask_cache.get(key)
        if cached is not None:
            return cached

        try:
            import cv2
        except Exception:
            return None

        mask = np.zeros((height, width), dtype=np.float32)
        inset_x = max(2, int(round(width * 0.16)))
        inset_y = max(2, int(round(height * 0.18)))
        if width - inset_x * 2 <= 1 or height - inset_y * 2 <= 1:
            mask[:, :] = 1.0
        else:
            mask[inset_y:height - inset_y, inset_x:width - inset_x] = 1.0

        blur_size = max(5, int(round(min(height, width) * 0.30)))
        if blur_size % 2 == 0:
            blur_size += 1
        mask = cv2.GaussianBlur(mask, (blur_size, blur_size), blur_size / 4.0)
        mask = np.clip(mask, 0.0, 1.0)
        self._mouth_refine_mask_cache[key] = mask
        return mask

    def _refine_mouth_roi(self, frame, detection, *, source_tag: str):
        if not isinstance(frame, np.ndarray) or frame.size == 0:
            return frame

        enabled = str(os.environ.get('YDB_MOUTH_REFINE_ENABLED', '1')).strip().lower() not in ('0', 'false', 'no', 'off')
        if not enabled:
            return frame

        prepared = self._prepare_detection(detection, frame.shape)
        if prepared is None:
            return frame

        mouth_roi = self._estimate_mouth_roi(prepared, frame.shape)
        if mouth_roi is None:
            return frame

        x1, y1, x2, y2 = [int(v) for v in mouth_roi]
        roi_w = x2 - x1
        roi_h = y2 - y1
        if roi_w < 12 or roi_h < 8:
            return frame

        try:
            import cv2
        except Exception:
            return frame

        alpha_strength = min(1.0, max(0.0, float(os.environ.get('YDB_MOUTH_REFINE_ALPHA', '0.72'))))
        sharpen_amount = min(1.2, max(0.0, float(os.environ.get('YDB_MOUTH_REFINE_AMOUNT', '0.38'))))
        sigma = max(0.45, min(2.4, float(os.environ.get('YDB_MOUTH_REFINE_SIGMA', '1.05'))))

        refined = frame.copy()
        patch = refined[y1:y2, x1:x2]
        if patch.size == 0:
            return frame

        patch_ycrcb = cv2.cvtColor(patch, cv2.COLOR_BGR2YCrCb).astype(np.float32)
        luma = patch_ycrcb[:, :, 0]
        blurred_luma = cv2.GaussianBlur(luma, (0, 0), sigma)
        sharpened_luma = np.clip(luma * (1.0 + sharpen_amount) - blurred_luma * sharpen_amount, 0.0, 255.0)
        patch_ycrcb[:, :, 0] = sharpened_luma
        sharpened_patch = cv2.cvtColor(patch_ycrcb.astype(np.uint8), cv2.COLOR_YCrCb2BGR).astype(np.float32)

        alpha_mask = self._mouth_refine_mask(roi_h, roi_w)
        if alpha_mask is None:
            return frame
        alpha3 = alpha_mask[:, :, np.newaxis] * alpha_strength
        blended = sharpened_patch * alpha3 + patch.astype(np.float32) * (1.0 - alpha3)
        refined[y1:y2, x1:x2] = np.clip(blended, 0.0, 255.0).astype(np.uint8)

        if source_tag == 'camera-batch':
            self._source_mouth_refine_apply_count += 1
            count = self._source_mouth_refine_apply_count
            if count <= 3 or count % 120 == 0:
                log(
                    'Applied source mouth refine '
                    f'(count={count}, roi={roi_w}x{roi_h}@{x1},{y1})'
                )
        else:
            self._mouth_refine_apply_count += 1
            count = self._mouth_refine_apply_count
            if count <= 3 or count % 120 == 0:
                log(
                    'Applied live mouth refine '
                    f'(count={count}, roi={roi_w}x{roi_h}@{x1},{y1})'
                )
        return refined

    def _refine_source_batch_frames(self, frames, detections):
        if not frames:
            return frames

        refined_frames = []
        last_detection = self._last_positive_direct_detection or self._last_direct_detection
        for idx, frame in enumerate(frames):
            detection_group = detections[min(idx, len(detections) - 1)] if detections else None
            detection = self._primary_detection_from_group(detection_group)
            if detection is None:
                detection = last_detection
            refined_frames.append(self._refine_mouth_roi(frame, detection, source_tag='camera-batch'))
        return refined_frames

    def _refine_live_mouth_frame(self, frame):
        if not isinstance(frame, np.ndarray) or frame.size == 0:
            return frame

        enabled = str(os.environ.get('YDB_MOUTH_REFINE_ENABLED', '1')).strip().lower() not in ('0', 'false', 'no', 'off')
        if not enabled:
            return frame

        detection = self._last_positive_direct_detection or self._last_direct_detection
        detection_at = max(self._last_positive_direct_detection_at, self._last_direct_detection_at)
        if not isinstance(detection, dict):
            return frame
        if time.time() - detection_at > max(0.08, float(os.environ.get('YDB_MOUTH_REFINE_STALE_SECONDS', '0.45'))):
            return frame

        return self._refine_mouth_roi(frame, detection, source_tag='final-output')

    def _build_preview_audio_stub(self, player):
        try:
            samples_per_frame = int(getattr(player, 'samples_per_frame', 1280) or 1280)
        except Exception:
            samples_per_frame = 1280
        return np.zeros((max(1, samples_per_frame),), dtype=np.float32)

    def _clamp_detection_box(self, box, frame_shape):
        if box is None:
            return None
        try:
            frame_h, frame_w = frame_shape[:2]
            x1, y1, x2, y2 = [float(v) for v in box]
        except Exception:
            return None

        x1 = int(max(0, min(frame_w - 2, round(x1))))
        y1 = int(max(0, min(frame_h - 2, round(y1))))
        x2 = int(max(x1 + 1, min(frame_w - 1, round(x2))))
        y2 = int(max(y1 + 1, min(frame_h - 1, round(y2))))
        if x2 <= x1 or y2 <= y1:
            return None
        return np.array([x1, y1, x2, y2], dtype=np.int32)

    def _build_detection_from_landmarks(self, landmarks, frame_shape):
        if not isinstance(landmarks, np.ndarray) or landmarks.size == 0:
            return None
        try:
            x1, y1 = landmarks.min(axis=0)
            x2, y2 = landmarks.max(axis=0)
        except Exception:
            return None

        width = max(1.0, float(x2 - x1))
        height = max(1.0, float(y2 - y1))
        box = self._clamp_detection_box(
            [
                x1 - width * 0.35,
                y1 - height * 0.45,
                x2 + width * 0.35,
                y2 + height * 0.30,
            ],
            frame_shape,
        )
        if box is None:
            return None
        return {
            'bbox': box,
            'landmarks': landmarks.astype(np.float32),
            'is_no_face': False,
        }

    def _track_detection_with_predictor(self, frame, detection, predictor):
        if predictor is None or not isinstance(detection, dict):
            return None
        prev_box = detection.get('bbox')
        if not isinstance(prev_box, np.ndarray) or prev_box.size != 4:
            return None

        try:
            import cv2
            import dlib
        except Exception:
            return None

        frame_h, frame_w = frame.shape[:2]
        x1, y1, x2, y2 = [float(v) for v in prev_box]
        width = max(1.0, x2 - x1)
        height = max(1.0, y2 - y1)
        tracked_box = self._clamp_detection_box(
            [
                x1 - width * 0.18,
                y1 - height * 0.22,
                x2 + width * 0.18,
                y2 + height * 0.18,
            ],
            frame.shape,
        )
        if tracked_box is None:
            return None

        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        rect = dlib.rectangle(
            int(tracked_box[0]),
            int(tracked_box[1]),
            int(tracked_box[2]),
            int(tracked_box[3]),
        )
        try:
            shape = predictor(gray, rect)
        except Exception:
            return None

        landmarks = np.array(
            [[shape.part(i).x, shape.part(i).y] for i in range(shape.num_parts)],
            dtype=np.float32,
        )
        if landmarks.size == 0:
            return None
        if (
            np.any(landmarks[:, 0] < 0)
            or np.any(landmarks[:, 0] >= frame_w)
            or np.any(landmarks[:, 1] < 0)
            or np.any(landmarks[:, 1] >= frame_h)
        ):
            return None

        return self._build_detection_from_landmarks(landmarks, frame.shape)

    def _estimate_detection_from_frame(self, frame, face_reader=None):
        if not isinstance(frame, np.ndarray) or frame.size == 0:
            return None

        if face_reader is None:
            face_reader = self._get_face_reader()
        if face_reader is None:
            return self._clone_detection(self._last_positive_direct_detection or self._last_direct_detection)

        detector = getattr(face_reader, 'face_detector', None)
        predictor = getattr(face_reader, 'landmark_predictor', None)
        if detector is None:
            return self._clone_detection(self._last_positive_direct_detection or self._last_direct_detection)

        now = time.time()
        hit_interval = max(0.08, float(os.environ.get('YDB_DIRECT_DETECTION_INTERVAL_HIT', '0.90')))
        miss_interval = max(0.04, float(os.environ.get('YDB_DIRECT_DETECTION_INTERVAL_MISS', '0.20')))
        sticky_seconds = max(0.2, float(os.environ.get('YDB_DIRECT_DETECTION_STICKY_SECONDS', '2.00')))

        cached_positive = None
        if (
            isinstance(self._last_positive_direct_detection, dict)
            and now - self._last_positive_direct_detection_at <= sticky_seconds
        ):
            cached_positive = self._last_positive_direct_detection

        tracked_detection = None
        if cached_positive is not None:
            tracked_detection = self._track_detection_with_predictor(frame, cached_positive, predictor)
            if tracked_detection is not None:
                self._last_direct_detection = self._clone_detection(tracked_detection)
                self._last_direct_detection_at = now
                if now - self._last_yolo_direct_detection_at < hit_interval:
                    return self._clone_detection(tracked_detection)
        elif self._last_direct_detection is not None and now - self._last_direct_detection_at < miss_interval:
            return self._clone_detection(self._last_direct_detection)
        elif self._last_yolo_direct_detection_at > 0 and now - self._last_yolo_direct_detection_at < miss_interval:
            return None

        detect_frame = frame
        x_scale = 1.0
        y_scale = 1.0
        try:
            import cv2

            max_side = max(256, int(os.environ.get('YDB_DIRECT_DETECTION_MAX_SIDE', '512')))
            h, w = frame.shape[:2]
            long_side = max(h, w)
            if long_side > max_side:
                scale = max_side / float(long_side)
                detect_w = max(1, int(round(w * scale)))
                detect_h = max(1, int(round(h * scale)))
                detect_frame = cv2.resize(frame, (detect_w, detect_h), interpolation=cv2.INTER_AREA)
                x_scale = w / float(detect_w)
                y_scale = h / float(detect_h)
        except Exception:
            detect_frame = frame
            x_scale = 1.0
            y_scale = 1.0

        try:
            result = detector(detect_frame, verbose=False)
            boxes = result[0].boxes if result else None
            self._last_yolo_direct_detection_at = now
        except Exception:
            boxes = None

        if boxes is None or len(boxes) == 0:
            self._direct_detection_miss_count += 1
            fallback_detection = tracked_detection or cached_positive
            if fallback_detection is not None:
                self._last_direct_detection = self._clone_detection(fallback_detection)
                self._last_direct_detection_at = now
                if (
                    _DEBUG_TRACE_CAMERA
                    and (
                        self._direct_detection_miss_count <= 5
                        or self._direct_detection_miss_count % 20 == 0
                    )
                ):
                    log(
                        'Direct detection missed face; reusing last stable detection '
                        f'(count={self._direct_detection_miss_count})'
                    )
                return self._clone_detection(fallback_detection)

            self._last_direct_detection = None
            self._last_direct_detection_at = now
            if self._direct_detection_miss_count == 1:
                log('Direct detection has not found a face yet')
            return None

        try:
            box = boxes.xyxy[0].cpu().numpy().astype(np.float32)
            box = np.array(
                [
                    box[0] * x_scale,
                    box[1] * y_scale,
                    box[2] * x_scale,
                    box[3] * y_scale,
                ],
                dtype=np.int32,
            )
        except Exception:
            return self._clone_detection(cached_positive or self._last_direct_detection)

        box = self._clamp_detection_box(box, frame.shape)
        if box is None:
            return self._clone_detection(tracked_detection or cached_positive or self._last_direct_detection)

        try:
            frame_area = float(frame.shape[0] * frame.shape[1])
            box_area = float(max(1, box[2] - box[0]) * max(1, box[3] - box[1]))
            max_face_ratio = min(0.95, max(0.10, float(os.environ.get('YDB_DIRECT_DETECTION_MAX_FACE_RATIO', '0.60'))))
            if frame_area > 0 and box_area / frame_area > max_face_ratio:
                if _DEBUG_TRACE_CAMERA:
                    log(
                        'Direct detection rejected oversized face box '
                        f'(ratio={box_area / frame_area:.2f}, bbox={box.tolist()})'
                    )
                return self._clone_detection(tracked_detection or cached_positive or self._last_direct_detection)
        except Exception:
            pass

        detection = None
        if predictor is not None:
            detection = self._track_detection_with_predictor(
                frame,
                {'bbox': box, 'landmarks': None, 'is_no_face': False},
                predictor,
            )
        if detection is None:
            landmarks = None
            if tracked_detection is not None:
                cached_landmarks = tracked_detection.get('landmarks')
                if isinstance(cached_landmarks, np.ndarray) and cached_landmarks.size > 0:
                    landmarks = cached_landmarks.copy()
            elif cached_positive is not None:
                cached_landmarks = cached_positive.get('landmarks')
                if isinstance(cached_landmarks, np.ndarray) and cached_landmarks.size > 0:
                    landmarks = cached_landmarks.copy()
            detection = {
                'bbox': box,
                'landmarks': landmarks,
                'is_no_face': False,
            }

        self._last_direct_detection = self._clone_detection(detection)
        self._last_direct_detection_at = now
        self._last_positive_direct_detection = self._clone_detection(detection)
        self._last_positive_direct_detection_at = now
        box = detection.get('bbox')
        landmarks = detection.get('landmarks')
        self._direct_detection_hit_count += 1
        if self._direct_detection_hit_count == 1:
            log(
                'Direct detection found first face '
                f'(bbox={box.tolist()}, landmarks={"yes" if landmarks is not None else "no"})'
            )
        if (
            _DEBUG_TRACE_CAMERA
            and (
                self._direct_detection_hit_count <= 5
                or self._direct_detection_hit_count % 20 == 0
            )
        ):
            log(
                'Direct detection found face '
                f'(count={self._direct_detection_hit_count}, '
                f'bbox={box.tolist()}, landmarks={"yes" if landmarks is not None else "no"})'
            )
        try:
            face_reader.last_stable_detection = self._clone_detection(detection)
        except Exception:
            pass
        return self._clone_detection(detection)

    def _direct_preview_next_result(self, face_reader=None):
        if self._use_proxy_native_camera:
            proxy_timeout = max(0.03, float(os.environ.get('YDB_PROXY_CAMERA_READ_TIMEOUT', '0.09')))
            return self._take_proxy_camera_batch(timeout_s=proxy_timeout)

        frame = self._get_direct_preview_frame()
        if frame is None:
            return None

        detection = self._estimate_detection_from_frame(frame, face_reader)
        if detection is None:
            return [frame], [[]]

        normalized_detection = self._stabilize_detection(detection, frame.shape)
        if normalized_detection is None:
            return [frame], [[]]
        refined_frame = self._refine_mouth_roi(frame, normalized_detection, source_tag='camera-batch')
        return [refined_frame], [[normalized_detection]]

    def _pump_direct_camera_preview_upload(self):
        if not self._direct_preview_started or self.manager_input_mode != 'camera' or self.manager is None:
            return
        if self.manager_started:
            return

        frame = self._get_direct_preview_frame()
        preview_interval = max(0.05, float(os.environ.get('YDB_DIRECT_PREVIEW_UPLOAD_INTERVAL', '0.10')))
        now = time.time()
        if frame is None or now - self._last_preview_player_upload_at < preview_interval:
            return

        player = getattr(self.manager, 'player', None)
        if player is None:
            return

        try:
            player.upload_frame({
                'frame': frame,
                'audio': self._build_preview_audio_stub(player),
                'index': self._direct_preview_upload_count,
                '_xiyiji_preview_fallback': True,
            })
            self._last_preview_player_upload_at = now
            self._direct_preview_upload_count += 1
            if (
                self._direct_preview_upload_count <= 3
                or self._direct_preview_upload_count % 100 == 0
            ):
                log(
                    'Direct camera preview fallback uploaded frame '
                    f'(count={self._direct_preview_upload_count})'
                )
        except Exception as e:
            if self._direct_preview_upload_count < 3:
                log(f'Direct camera preview upload failed: {e}')
        if not self._use_proxy_native_camera:
            self._warm_direct_detection_from_preview(frame)

    def _warm_direct_detection_from_preview(self, frame):
        if (
            frame is None
            or self.manager is None
            or self.manager_input_mode != 'camera'
            or self.manager_started
            or not self._prefer_direct_camera
            or self._use_proxy_native_camera
        ):
            return

        now = time.time()
        warmup_interval = max(0.15, float(os.environ.get('YDB_PREVIEW_DETECTION_WARMUP_INTERVAL', '0.35')))
        if now - self._last_preview_detection_warmup_at < warmup_interval:
            return

        face_reader = self._get_face_reader()
        if face_reader is None:
            return

        try:
            self._estimate_detection_from_frame(frame, face_reader)
            self._last_preview_detection_warmup_at = now
        except Exception as e:
            if self._direct_detection_hit_count == 0 and self._direct_detection_miss_count == 0:
                log(f'Preview detection warmup failed: {e}')

    def _handoff_preview_to_native_camera(self):
        if self._prefer_direct_camera or self._use_proxy_native_camera or not self._direct_preview_started:
            return

        last_frame = self._get_direct_preview_frame()
        if last_frame is not None:
            self._last_good_camera_frame = last_frame.copy()

        log('Handing off preview camera to native RealtimeFaceReader')
        self._stop_direct_camera_preview()
        self._reset_direct_detection_state()
        time.sleep(max(0.05, float(os.environ.get('YDB_NATIVE_CAMERA_HANDOFF_DELAY', '0.25'))))

    def _drain_queue_like(self, value):
        cleared = 0
        if value is None or not hasattr(value, 'get_nowait'):
            return cleared
        while True:
            try:
                value.get_nowait()
                cleared += 1
            except qmod.Empty:
                break
            except Exception:
                break
        return cleared

    def _clear_player_preview_backlog(self):
        player = getattr(self.manager, 'player', None) if self.manager is not None else None
        if player is None:
            return

        cleared_parts = []
        if hasattr(player, 'clear_queues'):
            try:
                player.clear_queues()
                cleared_parts.append('clear_queues')
            except Exception as e:
                log(f'player.clear_queues failed before playback start: {e}')

        if not cleared_parts:
            for attr_name in dir(player):
                if 'queue' not in attr_name.lower():
                    continue
                try:
                    value = getattr(player, attr_name)
                except Exception:
                    continue
                cleared = self._drain_queue_like(value)
                if cleared > 0:
                    cleared_parts.append(f'{attr_name}={cleared}')

        self._last_preview_player_upload_at = time.time()
        if cleared_parts:
            log(f'Cleared preview backlog before playback start: {", ".join(cleared_parts)}')
        else:
            log('Preview backlog clear before playback start: no queue-like buffers drained')

    def _prepare_file_mode_playback_start(self):
        if self.manager is None or self.manager_input_mode != 'file':
            return

        backend = str(self.manager_file_mode_backend or 'unknown')
        clear_audio_queues = getattr(self.manager, 'clear_audio_queues', None)
        if callable(clear_audio_queues):
            try:
                clear_audio_queues()
                log(f'Cleared file-mode audio queues before playback start (backend={backend})')
            except Exception as exc:
                log(f'Failed to clear file-mode audio queues before playback start (backend={backend}): {exc}')

        if backend == 'video_stream':
            self._clear_player_preview_backlog()

    def _install_debug_patches(self):
        if self._debug_patches_installed or os.environ.get('YDB_DEBUG_STACKS') != '1':
            return

        try:
            from bin.image_infer_v2.infer_api import VideoStreamManager
            from bin.image_infer_v2.tools.realtime_face_reader.realtime_face_reader import RealtimeFaceReader
        except Exception as e:
            log(f'Failed to install debug patches: {e}')
            return

        orig_stop_playing = VideoStreamManager.stop_playing
        orig_stop_capture = RealtimeFaceReader.stop_capture
        orig_process_and_manage_audio = getattr(VideoStreamManager, 'process_and_manage_audio', None)
        orig_get_camera_frame_batch = getattr(VideoStreamManager, '_get_camera_frame_batch', None)
        orig_next = getattr(RealtimeFaceReader, '__next__', None)

        def debug_stop_playing(inst, *args, **kwargs):
            log('DEBUG stop_playing called')
            log(''.join(traceback.format_stack(limit=12)).rstrip())
            return orig_stop_playing(inst, *args, **kwargs)

        def debug_stop_capture(inst, *args, **kwargs):
            log('DEBUG stop_capture called')
            log(''.join(traceback.format_stack(limit=12)).rstrip())
            if not hasattr(inst, 'stop_event'):
                log('DEBUG stop_capture skipped: stop_event missing')
                return None
            return orig_stop_capture(inst, *args, **kwargs)

        def _describe_value(value):
            try:
                if value is None:
                    return 'None'
                if isinstance(value, tuple):
                    return 'tuple[' + ', '.join(_describe_value(v) for v in value[:4]) + (', ...' if len(value) > 4 else '') + ']'
                if isinstance(value, list):
                    return f'list(len={len(value)})'
                if isinstance(value, dict):
                    keys = list(value.keys())[:6]
                    return f'dict(keys={keys})'
                shape = getattr(value, 'shape', None)
                if shape is not None:
                    return f'{type(value).__name__}(shape={shape})'
                return f'{type(value).__name__}({value!r})'
            except Exception as exc:
                return f'<describe_error {exc}>'

        if orig_process_and_manage_audio is not None:
            def debug_process_and_manage_audio(inst, *args, **kwargs):
                log(f'DEBUG process_and_manage_audio enter thread={threading.current_thread().name}')
                try:
                    return orig_process_and_manage_audio(inst, *args, **kwargs)
                except Exception:
                    log(f'DEBUG process_and_manage_audio error:\n{traceback.format_exc()}')
                    raise
                finally:
                    log(f'DEBUG process_and_manage_audio exit thread={threading.current_thread().name}')
            VideoStreamManager.process_and_manage_audio = debug_process_and_manage_audio

        if _DEBUG_TRACE_CAMERA and orig_get_camera_frame_batch is not None:
            def debug_get_camera_frame_batch(inst, *args, **kwargs):
                try:
                    result = orig_get_camera_frame_batch(inst, *args, **kwargs)
                    log(f'DEBUG _get_camera_frame_batch -> {_describe_value(result)}')
                    return result
                except Exception:
                    log(f'DEBUG _get_camera_frame_batch error:\n{traceback.format_exc()}')
                    raise
            VideoStreamManager._get_camera_frame_batch = debug_get_camera_frame_batch

        if _DEBUG_TRACE_CAMERA and orig_next is not None:
            def debug_next(inst, *args, **kwargs):
                try:
                    result = orig_next(inst, *args, **kwargs)
                    log(f'DEBUG RealtimeFaceReader.__next__ -> {_describe_value(result)}')
                    return result
                except Exception:
                    log(f'DEBUG RealtimeFaceReader.__next__ error:\n{traceback.format_exc()}')
                    raise
            RealtimeFaceReader.__next__ = debug_next

        VideoStreamManager.stop_playing = debug_stop_playing
        RealtimeFaceReader.stop_capture = debug_stop_capture
        self._debug_patches_installed = True
        log('Debug stack patches installed')

    def _destroy_manager(self):
        """Tear down existing V2Manager (needed when switching input_mode)."""
        self._tearing_down_manager = True
        try:
            self._reset_file_mode_driving()
            self._direct_face_readers.clear()
            self._stop_direct_camera_preview()
            with self._file_drive_serial_lock:
                if self.manager:
                    try:
                        clear_audio_queues = getattr(self.manager, 'clear_audio_queues', None)
                        if callable(clear_audio_queues):
                            clear_audio_queues()
                        self.manager.stop_playing()
                    except Exception as e:
                        log(f'Manager teardown error: {e}')
                    self.manager = None
                    self.manager_data_dir = None
                    self.manager_input_mode = None
                    self.manager_file_mode_backend = None
                    self.manager_driving_video_path = None
                    self._file_mode_reference_video_path = ''
                    self._file_mode_reference_video_info = {}
                    self.manager_started = False
                    self._last_good_camera_frame = None
                    self._last_good_file_mode_frame = None
                    self._direct_face_readers.clear()
                    self._last_direct_detection = None
                    self._last_positive_direct_detection = None
                    self._last_direct_detection_at = 0.0
                    self._last_positive_direct_detection_at = 0.0
                    log('Manager destroyed')
                if self._origin_frame_v2_audio_extractor is not None:
                    try:
                        self._origin_frame_v2_audio_extractor.stop_playing()
                    except Exception:
                        pass
                    self._origin_frame_v2_audio_extractor = None
                    self._origin_frame_v2_audio_extractor_data_dir = None
                with self._origin_frame_audio_feature_override_lock:
                    self._origin_frame_audio_feature_overrides.clear()
        finally:
            self._tearing_down_manager = False

    def _camera_frame_is_placeholder(self, frame) -> bool:
        if frame is None or not isinstance(frame, np.ndarray) or frame.size == 0:
            return False
        if frame.ndim != 3 or frame.shape[2] < 3:
            return False

        try:
            frame_u8 = frame if frame.dtype == np.uint8 else np.clip(frame, 0, 255).astype(np.uint8)
            mean_value = float(frame_u8.mean())
            max_channel = frame_u8.max(axis=2)
            dark_ratio = float(np.mean(max_channel < 24))
            h, w = frame_u8.shape[:2]
            center = frame_u8[h // 4:(h * 3) // 4, w // 4:(w * 3) // 4]
            center_mean = float(center.mean()) if center.size else mean_value
            return mean_value < 28.0 or (dark_ratio > 0.58 and center_mean < 72.0)
        except Exception:
            return False

    def _latest_raw_camera_frame(self):
        if not self.manager:
            return None

        try:
            buffer = getattr(self.manager, 'camera_frame_buffer', None)
            if isinstance(buffer, list):
                for item in reversed(buffer):
                    image = getattr(item, 'image', None)
                    if isinstance(image, np.ndarray) and image.size > 0:
                        return image.copy()
        except Exception:
            pass

        return self._last_good_camera_frame.copy() if isinstance(self._last_good_camera_frame, np.ndarray) else None

    def _latest_origin_frame_frame(self):
        if isinstance(self._last_good_file_mode_frame, np.ndarray) and self._last_good_file_mode_frame.size > 0:
            return self._last_good_file_mode_frame.copy()
        return None

    def _install_player_patches(self):
        if not self.manager:
            return

        player = getattr(self.manager, 'player', None)
        if player is None:
            return

        if self.manager_input_mode == 'file':
            if getattr(player, '_xiyiji_file_mode_patch', False):
                return

            orig_upload_frame = player.upload_frame

            def patched_file_mode_upload(frame_info):
                payload = frame_info
                try:
                    if isinstance(frame_info, dict):
                        current = frame_info.get('frame')
                        if isinstance(current, np.ndarray) and current.size > 0:
                            adjusted = self._fit_file_mode_frame_to_window(current)
                            if adjusted is not current:
                                payload = dict(frame_info)
                                payload['frame'] = adjusted
                                current = adjusted
                            self._last_good_file_mode_frame = current.copy()
                except Exception:
                    log(f'File-mode upload_frame patch error:\n{traceback.format_exc()}')
                return orig_upload_frame(payload)

            player.upload_frame = patched_file_mode_upload
            player._xiyiji_file_mode_patch = True
            log('Installed file-mode upload window patch')
            return

        if self.manager_input_mode != 'camera' or getattr(player, '_xiyiji_camera_patch', False):
            return

        orig_upload_frame = player.upload_frame

        def patched_upload_frame(frame_info):
            payload = frame_info
            try:
                if isinstance(frame_info, dict):
                    if not frame_info.get('_xiyiji_preview_fallback'):
                        self._last_native_player_upload_at = time.time()
                        self._native_camera_upload_count += 1
                        if _DEBUG_TRACE_CAMERA and (
                            self._native_camera_upload_count <= 5
                            or self._native_camera_upload_count % 50 == 0
                        ):
                            log(
                                'Native player uploaded frame '
                                f'(count={self._native_camera_upload_count})'
                            )
                    frame = frame_info.get('frame')
                    if self._camera_frame_is_placeholder(frame):
                        replacement = self._latest_raw_camera_frame()
                        if replacement is not None:
                            payload = dict(frame_info)
                            payload['frame'] = replacement
                            self._camera_placeholder_replacements += 1
                            if (
                                self._camera_placeholder_replacements <= 5
                                or self._camera_placeholder_replacements % 50 == 0
                            ):
                                log(
                                    'Camera placeholder frame replaced with latest raw frame '
                                    f'(count={self._camera_placeholder_replacements})'
                                )
                    current = payload.get('frame')
                    if isinstance(current, np.ndarray) and not self._camera_frame_is_placeholder(current):
                        refined_frame = self._refine_live_mouth_frame(current)
                        if refined_frame is not current:
                            payload = dict(payload)
                            payload['frame'] = refined_frame
                            current = refined_frame
                        self._last_good_camera_frame = current.copy()
            except Exception:
                log(f'Player upload_frame patch error:\n{traceback.format_exc()}')
            return orig_upload_frame(payload)

        player.upload_frame = patched_upload_frame
        player._xiyiji_camera_patch = True
        log('Installed camera upload fallback patch')


    def _install_pygame_window_patch(self):
        if self._pygame_window_patch_installed:
            return

        try:
            import pygame
        except Exception as exc:
            log(f'Failed to import pygame for window patch: {exc}')
            return

        display = getattr(pygame, 'display', None)
        set_mode = getattr(display, 'set_mode', None)
        if display is None or not callable(set_mode):
            log('Failed to install pygame window patch: display.set_mode unavailable')
            return

        if getattr(display, '_xiyiji_set_mode_patch', False):
            self._pygame_window_patch_installed = True
            return

        def patched_set_mode(size, flags=0, depth=0, display_index=0, vsync=0):
            mode = self.manager_input_mode or self._player_window_mode
            allow_resizable = (
                mode == 'file'
                and str(os.environ.get('YDB_FILE_MODE_RESIZABLE_WINDOW', '1')).strip().lower()
                not in ('0', 'false', 'no', 'off')
            )
            if allow_resizable:
                try:
                    flags = int(flags or 0) | int(getattr(pygame, 'RESIZABLE', 0))
                except Exception:
                    pass
            try:
                return set_mode(size, flags, depth, display_index, vsync)
            except TypeError:
                try:
                    return set_mode(size, flags, depth, display_index)
                except TypeError:
                    return set_mode(size, flags, depth)

        display.set_mode = patched_set_mode
        display._xiyiji_set_mode_patch = True
        self._pygame_window_patch_installed = True
        log('Installed pygame set_mode patch (file-mode windows are resizable)')

    def _fit_file_mode_frame_to_window(self, frame_bgr):
        if (
            self.manager_input_mode != 'file'
            or not isinstance(frame_bgr, np.ndarray)
            or frame_bgr.size == 0
            or frame_bgr.ndim < 2
        ):
            return frame_bgr

        try:
            import pygame
        except Exception:
            return frame_bgr
        try:
            import cv2
        except Exception:
            return frame_bgr

        try:
            surface = pygame.display.get_surface()
        except Exception:
            surface = None
        if surface is None:
            return frame_bgr

        self._ensure_file_mode_window_runtime_state()

        try:
            window_w, window_h = surface.get_size()
        except Exception:
            return frame_bgr

        src_h, src_w = frame_bgr.shape[:2]
        if window_w <= 0 or window_h <= 0 or (window_w == src_w and window_h == src_h):
            return frame_bgr

        scale = min(window_w / float(src_w), window_h / float(src_h))
        target_w = max(1, int(round(src_w * scale)))
        target_h = max(1, int(round(src_h * scale)))
        interpolation = cv2.INTER_AREA if target_w < src_w or target_h < src_h else cv2.INTER_LINEAR
        resized = cv2.resize(frame_bgr, (target_w, target_h), interpolation=interpolation)

        if frame_bgr.ndim == 3:
            canvas = np.zeros((window_h, window_w, frame_bgr.shape[2]), dtype=frame_bgr.dtype)
        else:
            canvas = np.zeros((window_h, window_w), dtype=frame_bgr.dtype)

        offset_x = max(0, (window_w - target_w) // 2)
        offset_y = max(0, (window_h - target_h) // 2)
        canvas[offset_y:offset_y + target_h, offset_x:offset_x + target_w] = resized

        layout_key = (src_w, src_h, window_w, window_h, target_w, target_h, offset_x, offset_y)
        if self._file_window_layout_last != layout_key:
            self._file_window_layout_last = layout_key
            log(
                'File-mode window letterbox layout '
                f'(frame={src_w}x{src_h}, window={window_w}x{window_h}, '
                f'content={target_w}x{target_h}@{offset_x},{offset_y})'
            )

        return canvas

    def _ensure_file_mode_window_runtime_state(self):
        if self.manager_input_mode != 'file':
            return

        try:
            import pygame._sdl2.video as sdl2_video
        except Exception:
            return

        try:
            window = sdl2_video.Window.from_display_module()
        except Exception:
            return

        try:
            if getattr(window, 'resizable', None) is not True:
                window.resizable = True
        except Exception:
            pass

        try:
            if getattr(window, 'borderless', False):
                window.borderless = False
        except Exception:
            pass

        try:
            size = tuple(window.size)
        except Exception:
            size = ()
        try:
            resizable = bool(window.resizable)
        except Exception:
            resizable = None
        try:
            borderless = bool(window.borderless)
        except Exception:
            borderless = None

        state_key = (size, resizable, borderless)
        if self._file_window_runtime_state_last != state_key:
            self._file_window_runtime_state_last = state_key
            log(
                'File-mode SDL window state '
                f'(size={size}, resizable={resizable}, borderless={borderless})'
            )

    def _camera_pipeline_running(self) -> bool:
        if not self.manager or self.manager_input_mode != 'camera':
            return self.manager_started

        face_reader = self._get_face_reader()
        if face_reader is None:
            return False

        if self._camera_uses_direct_preview(face_reader):
            stop_event = getattr(face_reader, 'stop_event', None)
            if isinstance(stop_event, threading.Event) and stop_event.is_set():
                return False
            if self._use_proxy_native_camera:
                if self._proxy_camera_thread is None or not self._proxy_camera_thread.is_alive():
                    return False
            return self._get_direct_preview_frame() is not None

        stop_event = getattr(face_reader, 'stop_event', None)
        if stop_event is not None:
            try:
                if stop_event.is_set():
                    return False
            except Exception:
                return False

        capture_thread = getattr(face_reader, 'capture_thread', None)
        preprocess_thread = getattr(face_reader, 'preprocess_thread', None)
        if capture_thread is None or preprocess_thread is None:
            return False

        try:
            if not capture_thread.is_alive() or not preprocess_thread.is_alive():
                return False
        except Exception:
            return False

        return True

    def _get_face_reader(self):
        if not self.manager:
            return None
        face_reader = getattr(self.manager, 'face_reader_iterator', None)
        if face_reader is None:
            face_reader = getattr(self.manager, 'face_reader', None)
        return face_reader

    def _camera_queue_sizes(self):
        face_reader = self._get_face_reader()
        if face_reader is None:
            return {
                'raw': 0,
                'processed': 0,
                'buffer': 0,
                'direct': 1 if self._get_direct_preview_frame() is not None else 0,
            }

        def _qsize(value):
            if value is None:
                return 0
            try:
                return max(0, int(value.qsize()))
            except Exception:
                return 0

        raw_queue = getattr(face_reader, 'raw_frames_queue', None)
        processed_queue = getattr(face_reader, 'processed_frames_queue', None)
        camera_buffer = getattr(self.manager, 'camera_frame_buffer', None)
        buffer_len = len(camera_buffer) if isinstance(camera_buffer, list) else 0
        if self._use_proxy_native_camera:
            try:
                direct_len = max(
                    self._proxy_camera_batch_queue.qsize(),
                    1 if self._get_direct_preview_frame() is not None else 0,
                )
            except Exception:
                direct_len = 1 if self._get_direct_preview_frame() is not None else 0
        else:
            direct_len = 1 if self._get_direct_preview_frame() is not None else 0
        return {
            'raw': _qsize(raw_queue),
            'processed': _qsize(processed_queue),
            'buffer': buffer_len,
            'direct': direct_len,
        }

    def _camera_has_frames(self) -> bool:
        sizes = self._camera_queue_sizes()
        return (
            sizes['raw'] > 0
            or sizes['processed'] > 0
            or sizes['buffer'] > 0
            or sizes.get('direct', 0) > 0
        )

    def _wait_for_camera_frames(
        self,
        timeout_s: float = 4.0,
        label: str = 'camera-warmup',
        enable_fallback: bool = True,
    ) -> bool:
        if not self.manager or self.manager_input_mode != 'camera':
            return False

        deadline = time.time() + max(0.1, timeout_s)
        last_sizes = self._camera_queue_sizes()
        while time.time() < deadline:
            if self._camera_has_frames():
                if last_sizes['raw'] == 0 and last_sizes['processed'] == 0 and last_sizes['buffer'] == 0:
                    last_sizes = self._camera_queue_sizes()
                log(f'{label}: camera frames ready ({self._camera_log_sizes(last_sizes)})')
                return True

            face_reader = self._get_face_reader()
            if face_reader is None:
                break

            stop_event = getattr(face_reader, 'stop_event', None)
            if stop_event is not None:
                try:
                    if stop_event.is_set():
                        sizes = self._camera_queue_sizes()
                        log(f'{label}: camera stop_event set before first frame ({self._camera_log_sizes(sizes)})')
                        return False
                except Exception:
                    pass

            time.sleep(0.05)
            last_sizes = self._camera_queue_sizes()

        sizes = self._camera_queue_sizes()
        log(f'{label}: camera warmup timed out ({self._camera_log_sizes(sizes)})')
        if enable_fallback:
            self._ensure_direct_camera_preview()
            fallback_deadline = time.time() + 2.0
            while time.time() < fallback_deadline:
                if self._get_direct_preview_frame() is not None:
                    log(f'{label}: direct camera preview fallback has live frames')
                    return True
                time.sleep(0.05)
        return self._camera_has_frames()

    def _restart_camera_capture(self) -> bool:
        if not self.manager or self.manager_input_mode != 'camera':
            return False

        face_reader = self._get_face_reader()
        if face_reader is None:
            return False

        camera_index = getattr(self.manager, 'camera_index', -1)
        try:
            camera_index = int(camera_index)
        except Exception:
            camera_index = -1
        if camera_index < 0:
            return False

        try:
            log(f'Restarting camera capture directly (camera_index={camera_index})')
            face_reader.start_capture(camera_index)
            return True
        except Exception as e:
            log(f'Failed to restart camera capture directly: {e}')
            return False

    def _ensure_manager_playing(self) -> bool:
        if not self.manager:
            raise RuntimeError('No manager initialized')

        if self.manager_started:
            return False

        if self.manager_input_mode == 'file' and self.manager_file_mode_backend == 'origin_frame':
            log('Origin-frame file mode: starting playback lazily for queued audio')
            self.manager.start_playing()
            self.manager_started = True
            return True

        if self.manager_input_mode == 'camera':
            face_reader = self._get_face_reader()
            if (
                self._camera_uses_direct_preview(face_reader)
                or (self._direct_preview_started and self._get_direct_preview_frame() is not None)
            ):
                self._wait_for_camera_frames(label='before-start_playing', enable_fallback=False)
                self._clear_player_preview_backlog()
                if self._use_proxy_native_camera:
                    self._clear_proxy_camera_queue()
                    log('Camera proxy-native preview active; starting playback lazily')
                else:
                    self._handoff_preview_to_native_camera()
                if self._prefer_direct_camera and not self._use_proxy_native_camera:
                    log('Camera direct preview active; starting playback lazily')
                elif not self._prefer_direct_camera:
                    log('Camera preview ready; switching to native camera capture for playback')
            else:
                if not self._camera_pipeline_running():
                    self._restart_camera_capture()
                self._wait_for_camera_frames(label='before-start_playing', enable_fallback=True)
                log('Camera pipeline inactive; starting playback lazily')
            self.manager.start_playing()
            self.manager_started = True
            if not self._prefer_direct_camera:
                self._wait_for_camera_frames(
                    timeout_s=float(os.environ.get('YDB_NATIVE_CAMERA_START_WARMUP', '1.8')),
                    label='after-start_playing',
                    enable_fallback=False,
                )
            return True

        log('Playback thread inactive; starting now')
        if self.manager_input_mode == 'file':
            self._prepare_file_mode_playback_start()
        self.manager.start_playing()
        self.manager_started = True
        return True

    def _stop_origin_frame_idle_playback(self, reason: str = '') -> bool:
        if (
            self.manager is None
            or self.manager_input_mode != 'file'
            or self.manager_file_mode_backend != 'origin_frame'
            or not self.manager_started
        ):
            return False

        if self._pending_audio:
            return False

        queue_len = self._get_total_queue_length()
        if queue_len > 0:
            return False

        try:
            self.manager.stop_playing()
            self.manager_started = False
            log(
                'Origin-frame file mode: playback stopped while idle '
                f'(reason={reason or "unspecified"})'
            )
            return True
        except Exception as exc:
            log(
                'Origin-frame idle stop failed: '
                f'{exc} (reason={reason or "unspecified"})'
            )
            return False

    def _resolve_file_mode_backend(self, reference_video_info: dict | None = None,
                                   driving_video_path: str = '', driving_video_info: dict | None = None):
        if _truthy_env('YDB_FORCE_V2_FILE_MODE', '0'):
            return 'v2', 'forced by YDB_FORCE_V2_FILE_MODE'
        if _truthy_env('YDB_FORCE_ORIGIN_FRAME_FILE_MODE', '0'):
            return 'origin_frame', 'forced by YDB_FORCE_ORIGIN_FRAME_FILE_MODE'
        if _truthy_env('YDB_FORCE_VIDEO_STREAM_FILE_MODE', '0'):
            return 'video_stream', 'forced by YDB_FORCE_VIDEO_STREAM_FILE_MODE'

        reference_info = dict(reference_video_info or self._file_mode_reference_video_info or {})
        driving_info = dict(driving_video_info or {})
        reference_duration = float(reference_info.get('duration') or 0.0)
        driving_duration = float(driving_info.get('duration') or 0.0)
        reference_frames = int(reference_info.get('n_frames') or 0)
        driving_frames = int(driving_info.get('n_frames') or 0)
        disable_video_stream = _truthy_env('YDB_DISABLE_VIDEO_STREAM_FILE_MODE', '0')
        long_video_reason = ''

        if (
            driving_video_path
            and reference_duration > 0.0
            and driving_duration > reference_duration + 5.0
        ):
            long_video_reason = (
                f'driving duration {driving_duration:.2f}s is much longer than reference {reference_duration:.2f}s'
            )

        if (
            not long_video_reason
            and driving_video_path
            and reference_frames > 0
            and driving_frames > max(reference_frames + 300, int(reference_frames * 1.5))
        ):
            long_video_reason = f'driving frames {driving_frames} exceed reference {reference_frames}'

        if long_video_reason:
            if not disable_video_stream:
                return 'video_stream', f'{long_video_reason}; using special-drive streaming'
            return 'origin_frame', f'{long_video_reason}; video-stream fallback disabled'

        return 'v2', 'reference/driving lengths are compatible'

    def _resolve_file_mode_runtime_driving(
        self,
        backend: str,
        driving_video_path: str,
        driving_video_info: dict | None = None,
        reference_frame_source_path: str = '',
        reference_frame_source_info: dict | None = None,
    ) -> tuple[str, dict, dict]:
        return (
            driving_video_path,
            dict(driving_video_info or {}),
            {},
        )

    def _warmup_origin_frame_file_mode(self):
        if (
            self.manager is None
            or self.manager_input_mode != 'file'
            or self.manager_file_mode_backend != 'origin_frame'
        ):
            return False

        return self._ensure_origin_frame_file_mode_reader(reason='init-warmup')

    def _ensure_origin_frame_file_mode_reader(self, reason: str = ''):
        if (
            self.manager is None
            or self.manager_input_mode != 'file'
            or self.manager_file_mode_backend != 'origin_frame'
        ):
            return False

        reader = getattr(self.manager, 'face_reader', None)
        if reader is None:
            log('Origin-frame file-mode reader unavailable')
            return False

        video_path = self._file_drive_video_path or self.manager_driving_video_path or ''
        if not video_path:
            log('Origin-frame file-mode reader skipped: driving video path is empty')
            return False

        try:
            setattr(reader, '_xiyiji_last_video_path', video_path)
        except Exception:
            pass
        normalized_video_path = os.path.normcase(os.path.normpath(video_path))
        current_video_path = str(getattr(reader, 'video_path', '') or '')
        normalized_current_video_path = os.path.normcase(os.path.normpath(current_video_path)) if current_video_path else ''
        capture_thread = getattr(reader, 'capture_thread', None)
        preprocess_thread = getattr(reader, 'preprocess_thread', None)
        stop_event = getattr(reader, 'stop_event', None)
        restart_required = normalized_current_video_path != normalized_video_path

        if capture_thread is None or not getattr(capture_thread, 'is_alive', lambda: False)():
            restart_required = True
        if preprocess_thread is not None and hasattr(preprocess_thread, 'is_alive') and not preprocess_thread.is_alive():
            restart_required = True
        if stop_event is not None and hasattr(stop_event, 'is_set') and stop_event.is_set():
            restart_required = True

        try:
            import cv2
        except Exception:
            cv2 = None

        if restart_required:
            stop_capture = getattr(reader, 'stop_capture', None)
            if callable(stop_capture):
                try:
                    stop_capture()
                except Exception as exc:
                    log(f'Origin-frame file-mode reader stop before restart failed: {exc}')

            start_capture = getattr(reader, 'start_capture', None)
            if not callable(start_capture):
                log('Origin-frame file-mode reader start_capture unavailable')
                return False

            start_capture(video_path)
            log(
                'Origin-frame file-mode reader restarted: '
                f'{video_path} (reason={reason or "unspecified"})'
            )

        try:
            setattr(reader, 'video_path', video_path)
        except Exception:
            pass
        try:
            setattr(reader, 'playlist_path', None)
        except Exception:
            pass
        try:
            setattr(self.manager, 'face_reader_iterator', iter(reader))
        except Exception as exc:
            log(f'Failed to refresh origin-frame file-mode iterator: {exc}')
            return False

        deadline = time.time() + max(
            0.2,
            float(os.environ.get('YDB_ORIGIN_FRAME_WARMUP', '2.0')),
        )
        while time.time() < deadline:
            iterator = getattr(self.manager, 'face_reader_iterator', None)
            if iterator is not None:
                frame_queue = getattr(getattr(self.manager, 'player', None), 'frame_queue', None)
                queue_desc = ''
                if hasattr(frame_queue, 'qsize'):
                    try:
                        queue_desc = f', player_queue={frame_queue.qsize()}'
                    except Exception:
                        queue_desc = ''
                log(
                    'Origin-frame file-mode reader ready'
                    f'{queue_desc} (reason={reason or "unspecified"})'
                )
                return True

            if cv2 is not None:
                try:
                    cv2.waitKey(10)
                except Exception:
                    pass
            time.sleep(0.05)

        log(
            'Origin-frame file-mode reader warmup timed out; proceeding anyway '
            f'(reason={reason or "unspecified"})'
        )
        return False

    def _create_manager(self, data_dir: str, window_info: dict,
                        camera_mode: bool, camera_index: int, video_path: str,
                        driving_video_info: dict | None = None, file_mode_backend: str = 'v2'):
        """Create fresh manager for the requested input mode."""
        data_dir = self._normalize_character_dir(data_dir)
        video_path = _remap_to_runtime_alias(video_path)
        input_mode = 'camera' if camera_mode else 'file'
        if input_mode != 'file':
            file_mode_backend = 'v2'
        self._install_pygame_window_patch()
        self._player_window_mode = input_mode
        self._file_window_layout_last = None
        self._file_window_runtime_state_last = None
        window_width = int(window_info.get('width') or 720)
        window_height = int(window_info.get('height') or 1280)
        log(
            f'Creating manager: data_dir={data_dir}, input_mode={input_mode}, '
            f'camera_index={camera_index}, driving_video={video_path}, '
            f'window={window_width}x{window_height}, backend={file_mode_backend}'
        )

        if input_mode == 'file' and file_mode_backend == 'origin_frame':
            log('Origin-frame create_manager stage: before runtime patches')
            self._install_origin_frame_runtime_patches()
            log('Origin-frame create_manager stage: after runtime patches')
            log('Origin-frame create_manager stage: before audio bypass patch install')
            self._install_origin_frame_audio_bypass_patch()
            log('Origin-frame create_manager stage: after audio bypass patch install')
            self._arm_origin_frame_audio_bypass(video_path)
            log('Origin-frame create_manager stage: after audio bypass arm')
            from bin.image_infer_origin_frame.infer_api import VideoStreamManager as OriginFrameManager
            log('Origin-frame create_manager stage: imported VideoStreamManager')

            log('Origin-frame create_manager stage: constructing VideoStreamManager')
            self.manager = OriginFrameManager(
                wenet_conf_path=WENET_CONF,
                wenet_model_path=WENET_MODEL,
                model_path=UNET_MODEL,
                video_path_for_driving=video_path,
                silence_feature_path=SILENCE_NPY,
                window_width=window_width,
                window_height=window_height,
                buffer_threshold=50,
                device='cuda:0',
                batch_size=int(os.environ.get('YDB_BATCH_SIZE', '8')),
                synthesis_window_seconds=1.0,
                output_sample_rate=24000,
                image_output_mode='window',
                is_interrupt=True,
                detect_max_faces=1,
            )
            log('Origin-frame create_manager stage: VideoStreamManager constructed')
        else:
            self._install_runtime_patches()
            self._install_debug_patches()
            from digital_human_live_manager import V2Manager

            self._creating_camera_mode = camera_mode
            try:
                self.manager = V2Manager(
                    data_dir=data_dir,
                    wenet_conf_path=WENET_CONF,
                    wenet_model_path=WENET_MODEL,
                    model_path=UNET_MODEL,
                    silence_feature_path=SILENCE_NPY,
                    window_width=window_width,
                    window_height=window_height,
                    buffer_threshold=50,
                    device='cuda:0',
                    batch_size=int(os.environ.get('YDB_BATCH_SIZE', '8')),
                    synthesis_window_seconds=1.0,
                    output_sample_rate=24000,
                    image_output_mode='window',
                    is_interrupt=True,
                    input_mode=input_mode,
                    camera_index=camera_index if camera_mode else -1,
                    video_path_for_driving='' if camera_mode else video_path,
                    yolo_model_path=YOLO_MODEL,
                    enable_action_generalization=camera_mode,
                )
            finally:
                self._creating_camera_mode = False

        self.manager_data_dir = data_dir
        self.manager_input_mode = input_mode
        self.manager_file_mode_backend = file_mode_backend if input_mode == 'file' else None
        self.manager_driving_video_path = '' if camera_mode else video_path
        self.manager_started = False
        self.manager.init_player()
        self._ensure_file_mode_window_runtime_state()
        if not camera_mode and file_mode_backend in ('v2', 'video_stream'):
            self._configure_file_mode_frame_sequence()
        self._install_player_patches()
        self._reset_direct_detection_state()
        if camera_mode:
            if self._prefer_direct_camera:
                self._ensure_direct_camera_preview(camera_index=camera_index)
            init_warmup = '6.5' if self._use_proxy_native_camera else '4'
            self._wait_for_camera_frames(
                timeout_s=float(os.environ.get('YDB_CAMERA_INIT_WARMUP', init_warmup)),
                label='after-init'
            )
            log('Camera mode initialized; deferring playback start until audio is queued')
        else:
            if file_mode_backend == 'origin_frame':
                self._warmup_origin_frame_file_mode()
                log('Origin-frame file mode initialized; deferring playback start until audio is queued')
            elif file_mode_backend == 'video_stream':
                log('Video-stream file mode initialized; deferring playback start until audio is queued')
            else:
                self.manager.start_playing()
                self.manager_started = True
        if _DEBUG_INSPECT_MANAGER:
            try:
                attrs = list(dir(self.manager))
                interesting = [
                    name for name in attrs
                    if 'reader' in name.lower()
                    or 'queue' in name.lower()
                    or 'camera' in name.lower()
                    or 'player' in name.lower()
                    or 'video' in name.lower()
                    or 'drive' in name.lower()
                    or 'special' in name.lower()
                    or 'task' in name.lower()
                    or 'orig' in name.lower()
                    or 'silent' in name.lower()
                    or 'audio' in name.lower()
                ]
                for candidate in (
                    'current_interaction_audio_path',
                    'has_queued_audio',
                    'cached_interaction_frames',
                    'cached_interaction_metas',
                    'interaction_cursor',
                    'picked_count',
                    'is_interacting',
                    'current_audio_path',
                    'batch_frame_data',
                    '_create_dummy_frame_batch',
                    '_create_silence_batch',
                ):
                    if candidate not in interesting:
                        interesting.append(candidate)
                log(f'DEBUG manager attrs: {interesting}')
                for name in interesting:
                    try:
                        value = getattr(self.manager, name)
                        log(f'DEBUG manager.{name}={type(value).__name__}')
                    except Exception as exc:
                        log(f'DEBUG manager.{name} access failed: {exc}')
                for nested_name in ('player', 'special_video_face_reader', 'face_reader'):
                    try:
                        nested = getattr(self.manager, nested_name, None)
                    except Exception as exc:
                        log(f'DEBUG manager.{nested_name} access failed: {exc}')
                        continue
                    if nested is None:
                        log(f'DEBUG manager.{nested_name}=None')
                        continue
                    try:
                        nested_attrs = list(dir(nested))
                        nested_interesting = [
                            name for name in nested_attrs
                            if 'queue' in name.lower()
                            or 'frame' in name.lower()
                            or 'video' in name.lower()
                            or 'special' in name.lower()
                            or 'task' in name.lower()
                            or 'reader' in name.lower()
                            or 'play' in name.lower()
                            or 'stop' in name.lower()
                            or 'thread' in name.lower()
                            or 'capture' in name.lower()
                            or 'process' in name.lower()
                            or 'prepare' in name.lower()
                            or 'load' in name.lower()
                            or 'set_' in name.lower()
                        ]
                        log(f'DEBUG manager.{nested_name} attrs: {nested_interesting}')
                        for attr_name in nested_interesting[:40]:
                            try:
                                value = getattr(nested, attr_name)
                                if hasattr(value, 'qsize'):
                                    try:
                                        desc = f'{type(value).__name__}(qsize={value.qsize()})'
                                    except Exception:
                                        desc = type(value).__name__
                                elif callable(value):
                                    try:
                                        import inspect
                                        desc = f'callable{inspect.signature(value)}'
                                    except Exception:
                                        desc = 'callable'
                                else:
                                    desc = type(value).__name__
                                log(f'DEBUG manager.{nested_name}.{attr_name}={desc}')
                            except Exception as exc:
                                log(f'DEBUG manager.{nested_name}.{attr_name} access failed: {exc}')
                    except Exception as exc:
                        log(f'DEBUG inspect manager.{nested_name} failed: {exc}')
            except Exception as exc:
                log(f'DEBUG inspect manager failed: {exc}')
        log(
            f'Manager created: input_mode={input_mode}, started={self.manager_started}, '
            f'backend={self.manager_file_mode_backend or "v2"}'
        )

    def _configure_file_mode_frame_sequence(self):
        if self.manager is None:
            return
        backend = self.manager_file_mode_backend or 'unknown'
        if backend not in ('v2', 'video_stream'):
            log(
                'File-mode sequential frame override skipped: '
                f'backend={backend}'
            )
            return

        try:
            setattr(self.manager, 'enable_action_generalization', False)
            log(f'File-mode action generalization disabled (backend={backend})')
        except Exception as exc:
            log(f'Failed to disable file-mode action generalization: {exc}')

        if not self._force_sequential_file_frames:
            log('File-mode action generalization disabled; sequential override not requested')
            return

        sequential_fn = getattr(self.manager, '_generate_sequential_frame_sequence', None)
        if not callable(sequential_fn):
            log('Sequential frame generator unavailable; keeping default file-mode generator')
            return

        try:
            setattr(self.manager, '_generate_frame_sequence', sequential_fn)
            setattr(self.manager, '_xiyiji_force_sequential_file_frames', True)
            log(f'Locked file-mode frame generation to sequential order (backend={backend})')
        except Exception as exc:
            log(f'Failed to force sequential file-mode frame generation: {exc}')

    def _reset_file_mode_driving(self, video_path: str = '', video_info: dict | None = None):
        remapped_video_path = _remap_to_runtime_alias(video_path) if video_path else ''
        normalized_info = dict(video_info or {})
        stale_req_ids = []

        while True:
            try:
                pending = self._file_drive_queue.get_nowait()
            except qmod.Empty:
                break
            req_id = str((pending or {}).get('req_id') or '')
            if req_id:
                stale_req_ids.append(req_id)

        with self._file_drive_state_lock:
            self._file_drive_session_id += 1
            self._file_drive_video_path = remapped_video_path
            self._file_drive_video_info = normalized_info
            self._file_drive_cursor_sec = 0.0
            self._file_drive_cursor_frame = 0

        for req_id in stale_req_ids:
            if req_id in self._pending_audio:
                self._pending_audio.pop(req_id, None)
                emit({'id': req_id, 'type': 'error', 'error': 'file-mode driving reset'})

        self._stop_file_mode_special_reader()
        backend = self.manager_file_mode_backend or 'v2'

        if remapped_video_path:
            fps = float(normalized_info.get('fps') or 25.0)
            duration = float(normalized_info.get('duration') or 0.0)
            n_frames = int(normalized_info.get('n_frames') or 0)
            log(
                'Configured file-mode driving video: '
                f'{remapped_video_path} (fps={fps:.2f}, duration={duration:.2f}s, frames={n_frames})'
            )
            if self.manager_input_mode == 'file' and backend == 'origin_frame':
                log(
                    'File-mode driving source policy: '
                    'backend=origin_frame, visible frames follow the full driving video directly'
                )
                self._log_file_mode_binding_summary('reset-driving')
                return
            if self.manager_input_mode == 'file' and backend == 'video_stream':
                if self._video_stream_direct_drive_enabled:
                    log(
                        'File-mode driving source policy: '
                        'backend=video_stream, direct playback from the runtime-bound driving video '
                        '(special-drive disabled)'
                    )
                else:
                    log(
                        'File-mode driving source policy: '
                        'backend=video_stream, visible frames follow sequential special-drive segments '
                        'from the full driving video'
                    )
                self._log_file_mode_binding_summary('reset-driving')
                return

            auto_special_reader = self._auto_start_file_mode_special_reader_enabled()
            log(
                'File-mode driving source policy: '
                f'auto_special_reader={auto_special_reader}, '
                f'native_reference_frames={int((self._file_mode_reference_video_info or {}).get("n_frames") or 0)}, '
                f'driving_frames={n_frames}'
            )
            if auto_special_reader:
                self._start_file_mode_special_reader(remapped_video_path)
            else:
                log('File-mode special reader auto-start disabled; keeping native frame source')
            self._log_file_mode_binding_summary('reset-driving')
        else:
            log('Cleared file-mode driving video state')

    def _get_special_video_face_reader(self):
        if self.manager is None:
            return None
        return getattr(self.manager, 'special_video_face_reader', None)

    def _stop_file_mode_special_reader(self):
        reader = self._get_special_video_face_reader()
        if reader is None:
            return

        stop_capture = getattr(reader, 'stop_capture', None)
        if not callable(stop_capture):
            return

        try:
            stop_capture()
        except Exception as exc:
            log(f'Failed to stop special video face reader: {exc}')

    def _start_file_mode_special_reader(self, video_path: str):
        if not video_path or self.manager is None or self.manager_input_mode != 'file':
            return False

        reader = self._get_special_video_face_reader()
        if reader is None:
            log('Special video face reader unavailable; keeping default file-mode source')
            return False

        start_capture = getattr(reader, 'start_capture', None)
        if not callable(start_capture):
            log('Special video face reader start_capture unavailable; keeping default file-mode source')
            return False

        try:
            start_capture(video_path)
            log(f'Started special video face reader: {video_path}')
            if _DEBUG_INSPECT_MANAGER:
                for attr_name in ('video_path', 'playlist_path', 'raw_frames_queue', 'processed_frames_queue'):
                    try:
                        value = getattr(reader, attr_name, None)
                        if hasattr(value, 'qsize'):
                            try:
                                desc = f'{type(value).__name__}(qsize={value.qsize()})'
                            except Exception:
                                desc = type(value).__name__
                        else:
                            desc = repr(value)
                        log(f'DEBUG special_video_face_reader.{attr_name}={desc}')
                    except Exception as exc:
                        log(f'DEBUG special_video_face_reader.{attr_name} access failed: {exc}')
            return True
        except Exception as exc:
            log(f'Failed to start special video face reader: {exc}')
            return False

    def _auto_start_file_mode_special_reader_enabled(self) -> bool:
        return _truthy_env('YDB_ENABLE_AUTO_SPECIAL_READER', '0')

    def _file_mode_special_drive_enabled(self) -> bool:
        if self.manager_input_mode == 'file' and self.manager_file_mode_backend == 'video_stream':
            return not self._video_stream_direct_drive_enabled
        return str(os.environ.get('YDB_ENABLE_BLOCKING_SPECIAL_DRIVE', '0')).strip() == '1'

    def _can_use_file_mode_special_drive(self) -> bool:
        if self.manager_file_mode_backend not in ('v2', 'video_stream'):
            return False
        if not self._file_mode_special_drive_enabled():
            return False
        if self.manager is None or self.manager_input_mode != 'file':
            return False
        if not self._file_drive_video_path or not os.path.isfile(self._file_drive_video_path):
            return False
        if float(self._file_drive_video_info.get('duration') or 0.0) <= 0.05:
            return False
        return callable(getattr(self.manager, 'drive_with_special_video', None))

    def _can_track_file_mode_direct_playback(self) -> bool:
        if self.manager is None or self.manager_input_mode != 'file':
            return False
        if self.manager_file_mode_backend != 'video_stream':
            return False
        if not self._video_stream_direct_drive_enabled:
            return False
        if not self._file_drive_video_path or not os.path.isfile(self._file_drive_video_path):
            return False
        return float(self._file_drive_video_info.get('duration') or 0.0) > 0.05

    def _reserve_file_mode_drive_request(self, req_id: str, audio_path: str, duration: float) -> dict:
        with self._file_drive_state_lock:
            source_video = self._file_drive_video_path
            source_info = dict(self._file_drive_video_info or {})
            session_id = int(self._file_drive_session_id)

            if not source_video:
                raise RuntimeError('file-mode driving video is not configured')

            fps = float(source_info.get('fps') or 25.0)
            if fps <= 0:
                fps = 25.0
            total_duration = max(0.0, float(source_info.get('duration') or 0.0))
            total_frames = int(source_info.get('n_frames') or 0)
            if total_frames <= 0 and total_duration > 0.0:
                total_frames = max(1, int(round(total_duration * fps)))

            requested_duration = max(0.10, float(duration or 0.0))
            start_sec = 0.0
            start_frame = 0
            num_frames = max(1, int(round(requested_duration * fps)))
            if total_frames > 0:
                start_frame = int(self._file_drive_cursor_frame or 0) % total_frames
                start_sec = start_frame / fps
                self._file_drive_cursor_frame = (start_frame + num_frames) % total_frames
                self._file_drive_cursor_sec = self._file_drive_cursor_frame / fps
            elif total_duration > 0.05:
                start_sec = self._file_drive_cursor_sec % total_duration
                self._file_drive_cursor_sec = (start_sec + requested_duration) % total_duration
                start_frame = int(round(start_sec * fps))
            else:
                self._file_drive_cursor_sec = 0.0
                self._file_drive_cursor_frame = 0
            end_frame = (start_frame + num_frames - 1) % total_frames if total_frames > 0 else None

            return {
                'req_id': req_id,
                'audio_path': audio_path,
                'source_video': source_video,
                'source_duration': total_duration,
                'duration': requested_duration,
                'fps': fps,
                'total_frames': total_frames,
                'start_sec': start_sec,
                'start_frame': start_frame,
                'num_frames': num_frames,
                'end_frame': end_frame,
                'session_id': session_id,
            }

    def _build_file_mode_segment_output_path(self, source_video: str, start_sec: float, duration_sec: float) -> str:
        segment_dir = os.path.join(DATA_DIR, 'yundingyunbo_driving_segments')
        os.makedirs(segment_dir, exist_ok=True)
        source_name = Path(source_video).stem or 'driving'
        safe_name = re.sub(r'[^a-zA-Z0-9._-]+', '_', source_name).strip('._') or 'driving'
        unique_key = (
            f'{source_video}|{start_sec:.3f}|{duration_sec:.3f}|'
            f'{threading.get_ident()}|{time.time_ns()}'
        )
        digest = hashlib.md5(unique_key.encode('utf-8')).hexdigest()[:12]
        return os.path.join(segment_dir, f'{safe_name}_{digest}.mp4')

    def _build_file_mode_encoder_args(self) -> list[str]:
        # Keep segment preparation on CPU. Running NVENC in parallel with YDB's
        # TensorRT/GPU inference caused real-world stalls during preview.
        return [
            '-c:v',
            'libx264',
            '-preset',
            'ultrafast',
            '-crf',
            '18',
        ]

    def _encode_file_mode_segment_clip(self, input_path: str, start_sec: float,
                                       duration_sec: float, output_path: str,
                                       target_fps: float | None = None,
                                       target_frame_count: int | None = None,
                                       target_width: int | None = None,
                                       target_height: int | None = None):
        ffmpeg_binary = _resolve_runtime_binary('ffmpeg')
        tmp_output = output_path + f'.tmp_{os.getpid()}_{threading.get_ident()}_{time.time_ns()}.mp4'

        try:
            if os.path.exists(tmp_output):
                try:
                    os.remove(tmp_output)
                except Exception:
                    pass

            command = [
                ffmpeg_binary,
                '-hide_banner',
                '-loglevel',
                'error',
                '-y',
                '-ss',
                f'{max(0.0, start_sec):.3f}',
                '-i',
                input_path,
                '-t',
                f'{max(0.05, duration_sec):.3f}',
                '-an',
            ]

            filter_chain: list[str] = []
            normalized_target_width = max(0, int(target_width or 0))
            normalized_target_height = max(0, int(target_height or 0))
            if normalized_target_width > 0 and normalized_target_height > 0:
                metadata = _probe_video_metadata(input_path)
                if normalized_target_height > normalized_target_width:
                    spatial_filter, _, _ = _build_portrait_crop_scale_filter(
                        metadata,
                        normalized_target_width,
                        normalized_target_height,
                    )
                else:
                    normalized_width, normalized_height = _compute_normalized_dimensions(
                        metadata,
                        normalized_target_width,
                        normalized_target_height,
                    )
                    spatial_filter = f'scale={normalized_width}:{normalized_height}'
                filter_chain.append(spatial_filter)
                filter_chain.append('setsar=1')
            if target_fps is not None and float(target_fps) > 0.0:
                filter_chain.append(f'fps={float(target_fps):.6f}')
            if filter_chain:
                command.extend(['-vf', ','.join(filter_chain)])

            command.extend([
                *self._build_file_mode_encoder_args(),
                '-pix_fmt',
                'yuv420p',
                '-movflags',
                '+faststart',
            ])
            if target_fps is not None and float(target_fps) > 0.0:
                command.extend(['-r', f'{float(target_fps):.6f}'])
            if target_frame_count is not None and int(target_frame_count) > 0:
                command.extend(['-frames:v', str(int(target_frame_count))])
            command.append(tmp_output)

            completed = subprocess.run(command, **_hidden_subprocess_kwargs())
            if completed.returncode == 0 and _is_valid_video_file(tmp_output):
                os.replace(tmp_output, output_path)
                return

            stderr = (completed.stderr or '').strip()
            raise RuntimeError(stderr or f'ffmpeg failed to encode driving segment ({completed.returncode})')
        finally:
            if os.path.exists(tmp_output):
                try:
                    os.remove(tmp_output)
                except Exception:
                    pass

    def _concat_file_mode_segment_clips(self, input_paths: list[str], output_path: str):
        if len(input_paths) == 1:
            os.replace(input_paths[0], output_path)
            return

        ffmpeg_binary = _resolve_runtime_binary('ffmpeg')
        tmp_output = output_path + f'.tmp_{os.getpid()}_{threading.get_ident()}_{time.time_ns()}.mp4'
        list_path = output_path + f'.concat_{os.getpid()}_{threading.get_ident()}_{time.time_ns()}.txt'

        try:
            with open(list_path, 'w', encoding='utf-8') as f:
                for path in input_paths:
                    normalized = path.replace('\\', '/').replace("'", "'\\''")
                    f.write(f"file '{normalized}'\n")

            if os.path.exists(tmp_output):
                try:
                    os.remove(tmp_output)
                except Exception:
                    pass

            command = [
                ffmpeg_binary,
                '-hide_banner',
                '-loglevel',
                'error',
                '-y',
                '-f',
                'concat',
                '-safe',
                '0',
                '-i',
                list_path,
                '-an',
                *self._build_file_mode_encoder_args(),
                '-pix_fmt',
                'yuv420p',
                '-movflags',
                '+faststart',
                tmp_output,
            ]
            completed = subprocess.run(command, **_hidden_subprocess_kwargs())
            if completed.returncode == 0 and _is_valid_video_file(tmp_output):
                os.replace(tmp_output, output_path)
                return

            stderr = (completed.stderr or '').strip()
            raise RuntimeError(stderr or f'ffmpeg failed to concat driving segments ({completed.returncode})')
        finally:
            for temp_path in (tmp_output, list_path):
                if os.path.exists(temp_path):
                    try:
                        os.remove(temp_path)
                    except Exception:
                        pass

    def _get_file_mode_segment_target_dimensions(self) -> tuple[int | None, int | None, str]:
        reference_info = dict(self._file_mode_reference_video_info or {})
        width = int(reference_info.get('effective_width') or reference_info.get('width') or 0)
        height = int(reference_info.get('effective_height') or reference_info.get('height') or 0)
        if width > 0 and height > 0:
            return _make_even(width), _make_even(height), 'reference_info'

        candidate_paths = []
        if self.manager_data_dir:
            candidate_paths.append(('normalized_video', os.path.join(self.manager_data_dir, 'normalized_video.mp4')))
        if self._file_mode_reference_video_path:
            candidate_paths.append(('reference_video', self._file_mode_reference_video_path))

        for label, candidate in candidate_paths:
            if not candidate or not os.path.isfile(candidate):
                continue
            try:
                metadata = _probe_video_metadata(candidate)
            except Exception:
                continue
            width = int(metadata.get('effective_width') or metadata.get('width') or 0)
            height = int(metadata.get('effective_height') or metadata.get('height') or 0)
            if width > 0 and height > 0:
                return _make_even(width), _make_even(height), label

        return None, None, ''

    def _prepare_file_mode_driving_segment(self, request: dict) -> tuple[str, list[str]]:
        source_video = request.get('source_video', '')
        source_duration = max(0.0, float(request.get('source_duration') or 0.0))
        start_sec = max(0.0, float(request.get('start_sec') or 0.0))
        duration_sec = max(0.10, float(request.get('duration') or 0.0))
        request_fps = max(1.0, float(request.get('fps') or 25.0))
        request_total_frames = max(0, int(request.get('total_frames') or 0))
        request_start_frame = max(0, int(request.get('start_frame') or 0))
        request_num_frames = max(1, int(request.get('num_frames') or round(duration_sec * request_fps)))

        if not source_video or not os.path.isfile(source_video):
            raise RuntimeError(f'driving video missing: {source_video}')
        if source_duration <= 0.05:
            raise RuntimeError('driving video duration metadata unavailable')

        target_width, target_height, target_source = self._get_file_mode_segment_target_dimensions()

        # When the request covers the whole source from the start, reuse the source
        # directly instead of paying an extra transcode penalty.
        if (
            start_sec <= 0.05
            and duration_sec >= source_duration - 0.05
            and not target_width
            and not target_height
        ):
            return source_video, []

        cleanup_paths: list[str] = []
        output_path = self._build_file_mode_segment_output_path(source_video, start_sec, duration_sec)
        remaining_frames = request_num_frames
        cursor_frame = request_start_frame % request_total_frames if request_total_frames > 0 else 0
        part_paths: list[str] = []
        part_index = 0
        log(
            'Preparing file-mode driving segment: '
            f'source={os.path.basename(source_video)}, start={start_sec:.3f}s, '
            f'duration={duration_sec:.3f}s, fps={request_fps:.3f}, '
            f'frames={request_num_frames}, target={target_width or 0}x{target_height or 0}, '
            f'targetSource={target_source or "none"}'
        )
        try:
            while remaining_frames > 0:
                if request_total_frames > 0:
                    available_frames = request_total_frames - cursor_frame
                    if available_frames <= 0:
                        cursor_frame = 0
                        continue
                    part_frames = min(remaining_frames, available_frames)
                    cursor_sec = cursor_frame / request_fps
                else:
                    part_frames = remaining_frames
                    cursor_sec = start_sec

                if part_frames <= 0:
                    continue

                part_duration = max(0.05, float(part_frames) / request_fps)
                part_path = output_path if remaining_frames == part_frames and not part_paths else output_path.replace(
                    '.mp4',
                    f'.part{part_index}.mp4',
                )
                self._encode_file_mode_segment_clip(
                    source_video,
                    cursor_sec,
                    part_duration,
                    part_path,
                    target_fps=request_fps,
                    target_frame_count=part_frames,
                    target_width=target_width,
                    target_height=target_height,
                )
                part_paths.append(part_path)
                remaining_frames -= part_frames
                cursor_frame = 0
                part_index += 1

                if part_index > 64:
                    raise RuntimeError('driving segment wrap count exceeded safety limit')

            if not part_paths:
                raise RuntimeError('failed to prepare driving segment')

            if len(part_paths) == 1:
                cleanup_paths.append(part_paths[0])
                return part_paths[0], cleanup_paths

            self._concat_file_mode_segment_clips(part_paths, output_path)
            cleanup_paths.extend(part_paths)
            cleanup_paths.append(output_path)
            return output_path, cleanup_paths
        except Exception:
            for path in [*part_paths, output_path]:
                if not path or path == source_video:
                    continue
                if os.path.exists(path):
                    try:
                        os.remove(path)
                    except Exception:
                        pass
            raise

    def _run_file_mode_special_drive(self, request: dict):
        req_id = str(request.get('req_id') or '')
        session_id = int(request.get('session_id') or 0)
        cleanup_paths: list[str] = []

        try:
            with self._file_drive_serial_lock:
                if session_id != self._file_drive_session_id or not self.running:
                    return
                if self.manager is None or self.manager_input_mode != 'file':
                    raise RuntimeError('file-mode manager is unavailable')

                special_driver = getattr(self.manager, 'drive_with_special_video', None)
                if not callable(special_driver):
                    raise RuntimeError('drive_with_special_video is unavailable')

                segment_path, cleanup_paths = self._prepare_file_mode_driving_segment(request)
                if session_id != self._file_drive_session_id or not self.running:
                    return

                self._ensure_manager_playing()
                log(
                    'Driving file-mode special video: '
                    f'audio={os.path.basename(request.get("audio_path", ""))}, '
                    f'video={segment_path}, start={float(request.get("start_sec") or 0.0):.2f}s, '
                    f'duration={float(request.get("duration") or 0.0):.2f}s, '
                    f'startFrame={int(request.get("start_frame") or 0)}, '
                    f'endFrame={request.get("end_frame")}'
                )
                special_driver(segment_path, request.get('audio_path', ''), False)

            if session_id != self._file_drive_session_id or not self.running:
                return

            pending_info = self._pending_audio.pop(req_id, None)
            if pending_info is None:
                log(
                    'File-mode special drive finished after request was already settled: '
                    f'{req_id[:8]}'
                )
                return
            emit({
                'id': req_id,
                'type': 'done',
                'total_chunks': 1,
                'total_frames': int(request.get('num_frames') or 0),
                'end_frame': request.get('end_frame'),
            })
        except Exception as exc:
            if session_id != self._file_drive_session_id or not self.running:
                return
            pending_info = self._pending_audio.pop(req_id, None)
            if pending_info is None:
                log(
                    'File-mode special drive errored after request was already settled: '
                    f'{req_id[:8]}'
                )
                return
            log(f'File-mode special drive error: {traceback.format_exc()}')
            emit({'id': req_id, 'type': 'error', 'error': str(exc)})
        finally:
            for path in cleanup_paths:
                if not path or path == request.get('source_video', ''):
                    continue
                if os.path.exists(path):
                    try:
                        os.remove(path)
                    except Exception as exc:
                        log(f'Failed to remove file-mode driving segment {path}: {exc}')

    def _file_drive_worker_loop(self):
        log('File-mode special drive worker started')
        while self.running:
            try:
                request = self._file_drive_queue.get(timeout=0.1)
            except qmod.Empty:
                continue

            if request is None or not self.running:
                break

            try:
                self._run_file_mode_special_drive(request)
            except Exception:
                log(f'Unhandled file-mode drive worker error: {traceback.format_exc()}')

    def _process_file_mode_driving_queue(self):
        return

    def _log_face_reader_state(self, label: str):
        if not _DEBUG_INSPECT_MANAGER or not self.manager:
            return
        try:
            for name in (
                'current_interaction_audio_path',
                'has_queued_audio',
                'cached_interaction_frames',
                'cached_interaction_metas',
                'interaction_cursor',
                'picked_count',
                'is_interacting',
                'current_audio_path',
                'batch_frame_data',
                '_create_dummy_frame_batch',
                '_create_silence_batch',
            ):
                try:
                    value = getattr(self.manager, name)
                    if hasattr(value, 'qsize'):
                        try:
                            desc = f'{type(value).__name__}(qsize={value.qsize()})'
                        except Exception:
                            desc = type(value).__name__
                    elif isinstance(value, (list, tuple)):
                        desc = f'{type(value).__name__}(len={len(value)})'
                    elif isinstance(value, dict):
                        desc = f'dict(keys={list(value.keys())[:8]})'
                    elif isinstance(value, (str, int, float, bool)) or value is None:
                        desc = repr(value)
                    else:
                        desc = type(value).__name__
                    log(f'DEBUG {label}: manager.{name}={desc}')
                except Exception as exc:
                    log(f'DEBUG {label}: manager.{name} access failed: {exc}')
            try:
                camera_frame_buffer = getattr(self.manager, 'camera_frame_buffer', None)
                if isinstance(camera_frame_buffer, (list, tuple)):
                    log(f'DEBUG {label}: manager.camera_frame_buffer len={len(camera_frame_buffer)}')
                else:
                    log(f'DEBUG {label}: manager.camera_frame_buffer type={type(camera_frame_buffer).__name__}')
            except Exception as exc:
                log(f'DEBUG {label}: manager.camera_frame_buffer access failed: {exc}')
            face_reader = getattr(self.manager, 'face_reader', None)
            iterator = getattr(self.manager, 'face_reader_iterator', None)
            for prefix, obj in [('face_reader', face_reader), ('face_reader_iterator', iterator)]:
                if obj is None:
                    log(f'DEBUG {label}: {prefix}=None')
                    continue
                attrs = [name for name in dir(obj) if not name.startswith('_')]
                interesting = [
                    name for name in attrs
                    if 'queue' in name.lower() or 'thread' in name.lower() or 'frame' in name.lower()
                    or 'stop' in name.lower() or 'capture' in name.lower()
                    or 'model' in name.lower() or 'det' in name.lower()
                    or 'yolo' in name.lower() or 'dlib' in name.lower()
                    or 'landmark' in name.lower()
                ]
                log(f'DEBUG {label}: {prefix} attrs={interesting}')
                for name in interesting[:20]:
                    try:
                        value = getattr(obj, name)
                        if hasattr(value, 'qsize'):
                            try:
                                desc = f'{type(value).__name__}(qsize={value.qsize()})'
                            except Exception:
                                desc = type(value).__name__
                        elif isinstance(value, threading.Thread):
                            desc = f'Thread(is_alive={value.is_alive()}, name={value.name})'
                        elif isinstance(value, threading.Event):
                            desc = f'Event(is_set={value.is_set()})'
                        elif isinstance(value, (str, int, float, bool)) or value is None:
                            desc = repr(value)
                        else:
                            desc = type(value).__name__
                        log(f'DEBUG {label}: {prefix}.{name}={desc}')
                    except Exception as exc:
                        log(f'DEBUG {label}: {prefix}.{name} access failed: {exc}')
        except Exception as exc:
            log(f'DEBUG {label}: inspect face_reader failed: {exc}')

    # ── Utilities ──────────────────────────────────────────────────────

    def _get_video_info(self, video_path: str) -> dict:
        try:
            metadata = _probe_video_metadata(video_path)
        except Exception:
            metadata = {}

        try:
            import cv2
            cap = cv2.VideoCapture(video_path)
            fps = float(metadata.get('fps') or cap.get(cv2.CAP_PROP_FPS) or 25)
            width = int(
                metadata.get('effective_width')
                or metadata.get('width')
                or cap.get(cv2.CAP_PROP_FRAME_WIDTH)
                or 720
            )
            height = int(
                metadata.get('effective_height')
                or metadata.get('height')
                or cap.get(cv2.CAP_PROP_FRAME_HEIGHT)
                or 1280
            )
            n_frames = int(
                metadata.get('n_frames')
                or cap.get(cv2.CAP_PROP_FRAME_COUNT)
                or 0
            )
            cap.release()
            duration = float(metadata.get('duration') or 0.0)
            if n_frames <= 0 and duration > 0.0 and fps > 0.0:
                n_frames = max(1, int(round(duration * fps)))
            return {
                'fps': fps,
                'width': width,
                'height': height,
                'n_frames': n_frames,
                'duration': duration,
            }
        except Exception:
            fps = float(metadata.get('fps') or 25)
            width = int(metadata.get('effective_width') or metadata.get('width') or 720)
            height = int(metadata.get('effective_height') or metadata.get('height') or 1280)
            duration = float(metadata.get('duration') or 0.0)
            n_frames = int(metadata.get('n_frames') or 0)
            if n_frames <= 0 and duration > 0.0 and fps > 0.0:
                n_frames = max(1, int(round(duration * fps)))
            return {
                'fps': fps,
                'width': width,
                'height': height,
                'n_frames': n_frames,
                'duration': duration,
            }

    def _format_video_info(self, info: dict | None) -> str:
        info = dict(info or {})
        fps = float(info.get('fps') or 0.0)
        width = int(info.get('width') or 0)
        height = int(info.get('height') or 0)
        n_frames = int(info.get('n_frames') or 0)
        duration = float(info.get('duration') or 0.0)
        return (
            f'fps={fps:.2f}, size={width}x{height}, '
            f'duration={duration:.2f}s, frames={n_frames}'
        )

    def _log_video_info(self, label: str, video_path: str, info: dict | None):
        path = video_path or '(empty)'
        log(f'{label}: {path} ({self._format_video_info(info)})')

    def _log_file_mode_binding_summary(self, stage: str):
        if self.manager_input_mode != 'file':
            return

        ref_path = self._file_mode_reference_video_path or '(unknown)'
        drive_path = self._file_drive_video_path or self.manager_driving_video_path or '(unknown)'
        ref_info = dict(self._file_mode_reference_video_info or {})
        drive_info = dict(self._file_drive_video_info or {})
        backend = self.manager_file_mode_backend or 'v2'
        auto_special_reader = backend == 'v2' and self._auto_start_file_mode_special_reader_enabled()
        ref_frames = int(ref_info.get('n_frames') or 0)
        drive_frames = int(drive_info.get('n_frames') or 0)

        log(
            f'File-mode binding[{stage}]: '
            f'reference={ref_path} ({self._format_video_info(ref_info)}), '
            f'driving={drive_path} ({self._format_video_info(drive_info)}), '
            f'backend={backend}, auto_special_reader={auto_special_reader}'
        )

        if backend == 'origin_frame':
            log('File-mode binding note: origin-frame backend plays visible frames from the full driving video')
            return
        if backend == 'video_stream':
            if self._video_stream_direct_drive_enabled:
                log('File-mode binding note: video-stream backend plays the runtime-bound full video directly')
            else:
                log('File-mode binding note: video-stream backend drives the full video sequentially via special-drive segments')
            return

        if not auto_special_reader and ref_frames > 0 and drive_frames > 0 and ref_frames != drive_frames:
            log(
                'File-mode binding warning: native frame source may still follow the '
                f'reference stream while timing follows the driving video '
                f'(reference_frames={ref_frames}, driving_frames={drive_frames})'
            )

    def _queue_like_length(self, queue_obj) -> int:
        if queue_obj is None:
            return 0

        qsize = getattr(queue_obj, 'qsize', None)
        if callable(qsize):
            try:
                return max(0, int(qsize()))
            except Exception:
                pass

        try:
            return max(0, int(len(queue_obj)))
        except Exception:
            return 0

    def _get_queue_lengths_snapshot(self) -> dict:
        if not self.manager:
            return {}

        if self.manager_input_mode == 'file' and self.manager_file_mode_backend == 'origin_frame':
            try:
                audio_queues = getattr(self.manager, 'audio_queues', None)
                if isinstance(audio_queues, dict):
                    derived = {}
                    for queue_name, queue_obj in audio_queues.items():
                        derived[str(queue_name)] = self._queue_like_length(queue_obj)
                    if derived:
                        return derived
            except Exception:
                pass

        try:
            ql = self.manager.get_queue_lengths()
            if isinstance(ql, dict):
                return {
                    str(name): max(0, int(length or 0))
                    for name, length in ql.items()
                }
            if isinstance(ql, (list, tuple)):
                return {
                    f'queue_{idx}': max(0, int(length or 0))
                    for idx, length in enumerate(ql)
                }
            if ql:
                return {'default': max(0, int(ql))}
        except Exception:
            pass

        return {}

    def _get_total_queue_length(self) -> int:
        return sum(self._get_queue_lengths_snapshot().values())

    # ── Command handlers ───────────────────────────────────────────────

    def _get_origin_frame_v2_audio_extractor(self):
        data_dir = str(self.manager_data_dir or '').strip()
        if not data_dir:
            raise RuntimeError('origin-frame V2 audio extractor requires manager_data_dir')

        existing = self._origin_frame_v2_audio_extractor
        if existing is not None and self._origin_frame_v2_audio_extractor_data_dir == data_dir:
            return existing

        if existing is not None:
            try:
                existing.stop_playing()
            except Exception:
                pass
            self._origin_frame_v2_audio_extractor = None
            self._origin_frame_v2_audio_extractor_data_dir = None

        reference_video = os.path.join(data_dir, 'normalized_video.mp4')
        if not os.path.isfile(reference_video):
            reference_video = self._file_mode_reference_video_path or self.manager_driving_video_path or ''
        if not reference_video or not os.path.isfile(reference_video):
            raise RuntimeError('origin-frame V2 audio extractor could not find a reference video')
        reference_video = self._prepare_origin_frame_v2_audio_reference_video(data_dir, reference_video)

        self._install_runtime_patches()
        from digital_human_live_manager import V2Manager

        log(
            'Creating origin-frame auxiliary V2 audio extractor: '
            f'data_dir={data_dir}, reference_video={reference_video}'
        )
        extractor = V2Manager(
            data_dir=data_dir,
            wenet_conf_path=WENET_CONF,
            wenet_model_path=WENET_MODEL,
            model_path=UNET_MODEL,
            silence_feature_path=SILENCE_NPY,
            window_width=64,
            window_height=64,
            buffer_threshold=1,
            device='cuda:0',
            batch_size=max(1, int(os.environ.get('YDB_BATCH_SIZE', '8'))),
            synthesis_window_seconds=1.0,
            output_sample_rate=24000,
            image_output_mode='window',
            is_interrupt=True,
            input_mode='file',
            camera_index=-1,
            video_path_for_driving=reference_video,
            yolo_model_path=YOLO_MODEL,
            enable_action_generalization=False,
        )

        self._origin_frame_v2_audio_extractor = extractor
        self._origin_frame_v2_audio_extractor_data_dir = data_dir
        return extractor

    def _get_origin_frame_audio_batch_source(self) -> str:
        if _truthy_env('YDB_ORIGIN_FRAME_FORCE_SILENCE_BATCHES', '0'):
            return 'silence'

        source = str(os.environ.get('YDB_ORIGIN_FRAME_AUDIO_BATCH_SOURCE', 'auto')).strip().lower()
        if source not in ('auto', 'native', 'v2', 'silence'):
            log(
                'Unknown YDB_ORIGIN_FRAME_AUDIO_BATCH_SOURCE '
                f'"{source}", falling back to auto'
            )
            return 'auto'
        return source

    def _get_origin_frame_audio_timeout(self, env_name: str, default_seconds: float) -> float:
        try:
            return max(0.0, float(os.environ.get(env_name, str(default_seconds))))
        except Exception:
            return max(0.0, float(default_seconds))

    def _run_origin_frame_audio_call_with_timeout(
        self,
        label: str,
        fn,
        *args,
        timeout_seconds: float = 0.0,
        **kwargs,
    ):
        if timeout_seconds <= 0.0:
            return fn(*args, **kwargs)

        result_holder = {}
        error_holder = {}

        def _runner():
            try:
                result_holder['value'] = fn(*args, **kwargs)
            except BaseException as exc:
                error_holder['error'] = exc

        worker = threading.Thread(
            target=_runner,
            daemon=True,
            name=f'ydb-audio-{label[:24]}',
        )
        worker.start()
        worker.join(timeout_seconds)
        if worker.is_alive():
            raise TimeoutError(f'{label} timed out after {timeout_seconds:.1f}s')
        if 'error' in error_holder:
            raise error_holder['error']
        return result_holder.get('value')

    def _prepare_origin_frame_v2_audio_reference_video(self, data_dir: str, reference_video: str) -> str:
        clip_seconds = max(
            0.0,
            float(os.environ.get('YDB_ORIGIN_FRAME_V2_REFERENCE_SECONDS', '6.0')),
        )
        if clip_seconds <= 0.0 or not reference_video or not os.path.isfile(reference_video):
            return reference_video

        try:
            duration = float(_probe_video_metadata(reference_video).get('duration') or 0.0)
        except Exception:
            duration = 0.0
        if 0.0 < duration <= clip_seconds + 0.25:
            return reference_video

        clip_tag = int(round(clip_seconds * 1000.0))
        output_path = os.path.join(data_dir, f'_xiyiji_v2_audio_ref_{clip_tag}ms.mp4')
        required_duration = max(0.5, min(clip_seconds, duration or clip_seconds) - 0.25)
        try:
            if os.path.isfile(output_path):
                clip_info = _probe_video_metadata(output_path)
                clip_duration = float(clip_info.get('duration') or 0.0)
                if clip_duration >= required_duration:
                    return output_path
        except Exception:
            pass

        try:
            self._encode_file_mode_segment_clip(reference_video, 0.0, clip_seconds, output_path)
            log(
                'Prepared origin-frame auxiliary V2 reference clip: '
                f'{output_path} ({clip_seconds:.2f}s from {reference_video})'
            )
            return output_path
        except Exception as exc:
            log(
                'Failed to prepare origin-frame auxiliary V2 reference clip: '
                f'{exc}; using {reference_video}'
            )
            return reference_video

    def _load_origin_frame_audio_waveform(self, audio_path: str):
        import wave

        with wave.open(audio_path, 'rb') as wav_reader:
            channels = wav_reader.getnchannels()
            sample_width = wav_reader.getsampwidth()
            sample_rate = wav_reader.getframerate()
            frame_count = wav_reader.getnframes()
            raw_frames = wav_reader.readframes(frame_count)

        if sample_width != 2:
            raise RuntimeError(f'unsupported wav sample width: {sample_width}')
        if channels <= 0:
            raise RuntimeError(f'unsupported wav channel count: {channels}')
        if sample_rate <= 0:
            raise RuntimeError(f'unsupported wav sample rate: {sample_rate}')

        waveform = np.frombuffer(raw_frames, dtype=np.int16).astype(np.float32) / 32768.0
        if channels > 1:
            waveform = waveform.reshape(-1, channels).mean(axis=1)

        return waveform, int(sample_rate)

    def _build_origin_frame_audio_chunks(self, audio_path: str, num_frames: int):
        waveform, sample_rate = self._load_origin_frame_audio_waveform(audio_path)
        samples_per_frame = max(1, int(round(float(sample_rate) / 25.0)))

        if waveform.size == 0:
            waveform = np.zeros(samples_per_frame, dtype=np.float32)

        target_frames = max(1, int(num_frames or 0))
        padded = np.zeros(target_frames * samples_per_frame, dtype=np.float32)
        copy_len = min(waveform.size, padded.size)
        if copy_len > 0:
            padded[:copy_len] = waveform[:copy_len]

        if waveform.size > padded.size:
            log(
                'Origin-frame audio chunk builder truncated waveform tail: '
                f'audio={audio_path}, samples={waveform.size}, target_frames={target_frames}, '
                f'samples_per_frame={samples_per_frame}'
            )

        chunks = []
        for frame_idx in range(target_frames):
            start = frame_idx * samples_per_frame
            end = start + samples_per_frame
            chunks.append(np.array(padded[start:end], dtype=np.float32, copy=True))

        approx_frames = max(1, int(np.ceil(waveform.size / float(samples_per_frame))))
        if approx_frames != target_frames:
            log(
                'Origin-frame audio chunk builder frame alignment note: '
                f'audio={audio_path}, waveform_frames={approx_frames}, feature_frames={target_frames}, '
                f'sample_rate={sample_rate}, samples_per_frame={samples_per_frame}'
            )

        return chunks, sample_rate

    def _coerce_origin_frame_batches(self, audio_path: str, raw_batches, batch_cls, source_tag: str):
        if raw_batches is None:
            raise RuntimeError(f'{source_tag} audio extractor returned None')
        if not isinstance(raw_batches, list):
            raw_batches = list(raw_batches)
        if not raw_batches:
            raise RuntimeError(f'{source_tag} audio extractor returned no batches')
        if isinstance(raw_batches[0], batch_cls):
            return raw_batches

        audio_chunks, sample_rate = self._build_origin_frame_audio_chunks(audio_path, len(raw_batches))
        converted = []
        ndarray_count = 0

        for idx, batch in enumerate(raw_batches):
            fallback_chunk = audio_chunks[min(idx, len(audio_chunks) - 1)]
            item_audio_path = audio_path

            if isinstance(batch, np.ndarray):
                ndarray_count += 1
                wenet_feature = batch
                audio_chunk = fallback_chunk
                original_audio_chunk = fallback_chunk
            elif hasattr(batch, 'wenet_feature'):
                wenet_feature = getattr(batch, 'wenet_feature')
                audio_chunk = getattr(batch, 'audio_chunk', fallback_chunk)
                original_audio_chunk = getattr(batch, 'original_audio_chunk', audio_chunk)
                item_audio_path = str(getattr(batch, 'audio_path', audio_path) or audio_path)
            else:
                raise RuntimeError(
                    f'{source_tag} audio extractor returned unexpected batch item type: '
                    f'{type(batch).__name__}'
                )

            feature_array = np.asarray(wenet_feature, dtype=np.float32)
            feature_array = np.squeeze(feature_array)
            if feature_array.ndim == 1 and feature_array.size == 20 * 256:
                feature_array = feature_array.reshape(20, 256)
            if feature_array.ndim != 2:
                raise RuntimeError(
                    f'{source_tag} audio extractor returned unsupported wenet feature shape: '
                    f'{tuple(feature_array.shape)}'
                )

            audio_array = np.asarray(audio_chunk, dtype=np.float32).reshape(-1)
            original_audio_array = np.asarray(original_audio_chunk, dtype=np.float32).reshape(-1)
            converted.append(
                batch_cls(
                    wenet_feature=np.array(feature_array, copy=True),
                    audio_chunk=np.array(audio_array, copy=True),
                    original_audio_chunk=np.array(original_audio_array, copy=True),
                    audio_path=item_audio_path,
                )
            )

        if ndarray_count > 0:
            log(
                'Origin-frame audio batch ndarray compatibility applied: '
                f'audio={audio_path}, source={source_tag}, batches={len(converted)}, '
                f'ndarray_batches={ndarray_count}, sample_rate={sample_rate}'
            )

        return converted

    def _build_origin_frame_batches_from_v2(self, audio_path: str, batch_cls):
        if batch_cls is None:
            raise RuntimeError('origin-frame AudioBatch class is unavailable')

        extractor = self._get_origin_frame_v2_audio_extractor()
        started_at = time.time()
        v2_batches = self._run_origin_frame_audio_call_with_timeout(
            'origin-frame-v2-extract',
            extractor.extract_audio_features,
            audio_path,
            timeout_seconds=self._get_origin_frame_audio_timeout(
                'YDB_ORIGIN_FRAME_V2_EXTRACT_TIMEOUT_SECONDS',
                20.0,
            ),
        )
        converted = self._coerce_origin_frame_batches(
            audio_path,
            v2_batches,
            batch_cls,
            'v2',
        )

        elapsed = time.time() - started_at
        log(
            'Origin-frame V2 audio extractor complete: '
            f'audio={audio_path}, batches={len(converted)}, elapsed={elapsed:.2f}s'
        )
        return converted

    def _build_origin_frame_batches_from_native(self, audio_path: str, batch_cls):
        if batch_cls is None:
            raise RuntimeError('origin-frame AudioBatch class is unavailable')
        if self.manager is None:
            raise RuntimeError('origin-frame manager is not active')

        extract_audio_features = getattr(self.manager, 'extract_audio_features', None)
        if not callable(extract_audio_features):
            raise RuntimeError('origin-frame extract_audio_features is unavailable')

        started_at = time.time()
        native_batches = self._run_origin_frame_audio_call_with_timeout(
            'origin-frame-native-extract',
            extract_audio_features,
            audio_path,
            timeout_seconds=self._get_origin_frame_audio_timeout(
                'YDB_ORIGIN_FRAME_NATIVE_EXTRACT_TIMEOUT_SECONDS',
                18.0,
            ),
        )
        native_batches = self._coerce_origin_frame_batches(
            audio_path,
            native_batches,
            batch_cls,
            'native',
        )

        elapsed = time.time() - started_at
        log(
            'Origin-frame native audio extractor complete: '
            f'audio={audio_path}, batches={len(native_batches)}, elapsed={elapsed:.2f}s'
        )
        return native_batches

    def _add_origin_frame_audio_natively(self, audio_path: str):
        if self.manager is None:
            raise RuntimeError('origin-frame manager is not active')

        add_audio_to_queue = getattr(self.manager, 'add_audio_to_queue', None)
        if not callable(add_audio_to_queue):
            raise RuntimeError('origin-frame add_audio_to_queue is unavailable')

        started_at = time.time()
        self._run_origin_frame_audio_call_with_timeout(
            'origin-frame-native-add-audio',
            add_audio_to_queue,
            audio_path,
            queue_name='normal',
            timeout_seconds=self._get_origin_frame_audio_timeout(
                'YDB_ORIGIN_FRAME_NATIVE_ADD_TIMEOUT_SECONDS',
                20.0,
            ),
        )
        elapsed = time.time() - started_at
        log(
            'Origin-frame native add_audio_to_queue complete: '
            f'audio={audio_path}, elapsed={elapsed:.2f}s, '
            f'after={self._get_queue_lengths_snapshot()}'
        )

    def _build_origin_frame_prepared_audio_batches(self, audio_path: str):
        if (
            self.manager is None
            or self.manager_input_mode != 'file'
            or self.manager_file_mode_backend != 'origin_frame'
        ):
            raise RuntimeError('origin-frame manager is not active')

        try:
            from bin.image_infer_origin_frame.infer_api import AudioBatch as OriginFrameAudioBatch
        except Exception:
            OriginFrameAudioBatch = None

        started_at = time.time()
        batch_source = self._get_origin_frame_audio_batch_source()
        build_plan = {
            'silence': [('silence', self._build_origin_frame_silence_batches)],
            'native': [('native', self._build_origin_frame_batches_from_native)],
            'v2': [('v2', self._build_origin_frame_batches_from_v2)],
            'auto': [
                ('native', self._build_origin_frame_batches_from_native),
                ('v2', self._build_origin_frame_batches_from_v2),
            ],
        }[batch_source]
        batches = None
        build_errors = []
        used_source = batch_source
        for candidate_source, builder in build_plan:
            try:
                batches = builder(audio_path, OriginFrameAudioBatch)
                used_source = candidate_source
                break
            except Exception as exc:
                build_errors.append(f'{candidate_source}: {exc}')
                log(f'Origin-frame {candidate_source} audio batch build failed: {exc}')
        if batches is None:
            raise RuntimeError(
                'origin-frame audio batch build failed: '
                + ' | '.join(build_errors or ['unknown error'])
            )
        if batches is None:
            raise RuntimeError('origin-frame extract_audio_features returned None')
        if not isinstance(batches, list):
            batches = list(batches)
        if not batches:
            raise RuntimeError('origin-frame extract_audio_features returned no batches')

        if OriginFrameAudioBatch is not None and not isinstance(batches[0], OriginFrameAudioBatch):
            raise RuntimeError(
                'origin-frame extract_audio_features returned unexpected batch type: '
                f'{type(batches[0]).__name__}'
            )

        elapsed = time.time() - started_at
        log(
            'Origin-frame prepared audio batches ready: '
            f'audio={audio_path}, source={used_source}, batches={len(batches)}, '
            f'elapsed={elapsed:.2f}s'
        )
        return list(batches), used_source

    def _prime_origin_frame_interaction_cache(self, audio_path: str, batch_count: int):
        if (
            self.manager is None
            or self.manager_input_mode != 'file'
            or self.manager_file_mode_backend != 'origin_frame'
        ):
            raise RuntimeError('origin-frame manager is not active')

        manager = self.manager
        cached_frames = getattr(manager, 'cached_interaction_frames', None)
        cached_metas = getattr(manager, 'cached_interaction_metas', None)
        create_dummy_frame_batch = getattr(manager, '_create_dummy_frame_batch', None)
        if not isinstance(cached_frames, list):
            raise RuntimeError(
                'origin-frame cached_interaction_frames is invalid: '
                f'{type(cached_frames).__name__}'
            )
        if not isinstance(cached_metas, list):
            raise RuntimeError(
                'origin-frame cached_interaction_metas is invalid: '
                f'{type(cached_metas).__name__}'
            )
        if not callable(create_dummy_frame_batch):
            raise RuntimeError('origin-frame _create_dummy_frame_batch is unavailable')

        try:
            start_index = int(getattr(manager, 'last_frame_index', -1)) + 1
        except Exception:
            start_index = 0

        cached_frames.clear()
        cached_metas.clear()
        next_physical_index = start_index
        for _ in range(max(1, int(batch_count or 0))):
            frame_batch = create_dummy_frame_batch()
            try:
                frame_batch_len = max(1, int(len(frame_batch)))
            except Exception:
                frame_batch_len = 1

            meta_batch = []
            for _meta_idx in range(frame_batch_len):
                physical_index = next_physical_index
                next_physical_index += 1
                meta_batch.append(
                    {
                        'physical_index': physical_index,
                        'frame_index': physical_index,
                        'index': physical_index,
                        'source': 'xiyiji_dummy_origin_frame_batch',
                    }
                )

            cached_frames.append(frame_batch)
            cached_metas.append(meta_batch)

        setattr(manager, 'current_interaction_audio_path', audio_path)
        setattr(manager, 'interaction_cursor', 0)

        audio_duration_cache = getattr(manager, 'audio_duration_cache', None)
        if isinstance(audio_duration_cache, dict):
            audio_duration_cache[str(audio_path)] = max(0.0, float(batch_count or 0) / 25.0)

        log(
            'Origin-frame interaction cache primed: '
            f'audio={audio_path}, frames={len(cached_frames)}, metas={len(cached_metas)}, '
            f'cursor={getattr(manager, "interaction_cursor", "unknown")}, '
            f'startIndex={start_index}, frameType='
            f'{type(cached_frames[0]).__name__ if cached_frames else "none"}, '
            f'frameInnerLen='
            f'{len(cached_frames[0]) if cached_frames and hasattr(cached_frames[0], "__len__") else "na"}, '
            f'metaInnerLen='
            f'{len(cached_metas[0]) if cached_metas and hasattr(cached_metas[0], "__len__") else "na"}'
        )

    def _enqueue_origin_frame_audio_with_manual_state(self, audio_path: str) -> int:
        if (
            self.manager is None
            or self.manager_input_mode != 'file'
            or self.manager_file_mode_backend != 'origin_frame'
        ):
            raise RuntimeError('origin-frame manager is not active')

        audio_queues = getattr(self.manager, 'audio_queues', None)
        if not isinstance(audio_queues, dict):
            raise RuntimeError(f'origin-frame audio_queues is invalid: {type(audio_queues).__name__}')

        normal_queue = audio_queues.get('normal')
        if normal_queue is None:
            raise RuntimeError('origin-frame normal audio queue is missing')

        before_lengths = self._get_queue_lengths_snapshot()
        batches, used_source = self._build_origin_frame_prepared_audio_batches(audio_path)
        self._prime_origin_frame_interaction_cache(audio_path, len(batches))
        started_at = time.time()

        if hasattr(normal_queue, 'put'):
            for batch in batches:
                normal_queue.put(batch)
        elif hasattr(normal_queue, 'append'):
            for batch in batches:
                normal_queue.append(batch)
        else:
            raise RuntimeError(
                'origin-frame normal audio queue does not support put/append: '
                f'{type(normal_queue).__name__}'
            )

        after_lengths = self._get_queue_lengths_snapshot()
        elapsed = time.time() - started_at
        log(
            'Origin-frame manual-state audio enqueue complete: '
            f'audio={audio_path}, source={used_source}, batches={len(batches)}, '
            f'elapsed={elapsed:.2f}s, before={before_lengths}, after={after_lengths}'
        )
        return len(batches)

    def _build_origin_frame_silence_batches(self, audio_path: str, batch_cls):
        if batch_cls is None:
            raise RuntimeError('origin-frame AudioBatch class is unavailable')

        import wave

        silence_features = np.load(SILENCE_NPY)
        if silence_features.ndim != 3 or silence_features.shape[1:] != (20, 256):
            raise RuntimeError(f'unexpected silence feature shape: {silence_features.shape}')

        log(f'Origin-frame silence-batch builder begin: audio={audio_path}')
        with wave.open(audio_path, 'rb') as wav_reader:
            channels = wav_reader.getnchannels()
            sample_width = wav_reader.getsampwidth()
            sample_rate = wav_reader.getframerate()
            frame_count = wav_reader.getnframes()
            raw_frames = wav_reader.readframes(frame_count)

        if sample_width != 2:
            raise RuntimeError(f'unsupported wav sample width: {sample_width}')
        if channels <= 0:
            raise RuntimeError(f'unsupported wav channel count: {channels}')

        waveform = np.frombuffer(raw_frames, dtype=np.int16).astype(np.float32) / 32768.0
        if channels > 1:
            waveform = waveform.reshape(-1, channels).mean(axis=1)
        if sample_rate != 24000:
            raise RuntimeError(f'unsupported wav sample rate: {sample_rate}')
        samples_per_frame = 960
        if waveform.size == 0:
            waveform = np.zeros(samples_per_frame, dtype=np.float32)

        num_frames = max(1, int(np.ceil(waveform.size / float(samples_per_frame))))
        padded = np.zeros(num_frames * samples_per_frame, dtype=np.float32)
        padded[:waveform.size] = waveform

        batches = []
        for frame_idx in range(num_frames):
            start = frame_idx * samples_per_frame
            end = start + samples_per_frame
            audio_chunk = padded[start:end]
            wenet_feature = silence_features[frame_idx % len(silence_features)].astype(np.float32, copy=False)
            batches.append(
                batch_cls(
                    wenet_feature=np.array(wenet_feature, copy=True),
                    audio_chunk=np.array(audio_chunk, copy=True),
                    original_audio_chunk=np.array(audio_chunk, copy=True),
                    audio_path=audio_path,
                )
            )

        log(
            'Origin-frame silence-batch builder: '
            f'audio={audio_path}, frames={num_frames}, samples={waveform.size}, sample_rate={sample_rate}'
        )
        return batches

    def _register_init_request(self, req_id: str, init_generation: int) -> int | None:
        req_id = str(req_id or '')
        try:
            init_generation = int(init_generation or 0)
        except Exception:
            init_generation = 0

        with self._init_lock:
            if init_generation <= 0:
                init_generation = self._latest_init_generation + 1
            if init_generation < self._latest_init_generation:
                return None
            self._latest_init_generation = init_generation
            self._latest_init_req_id = req_id
            self._init_busy = True
            return init_generation

    def _is_current_init_request(self, init_generation: int, req_id: str = '') -> bool:
        req_id = str(req_id or '')
        try:
            init_generation = int(init_generation or 0)
        except Exception:
            init_generation = 0

        with self._init_lock:
            if init_generation != self._latest_init_generation:
                return False
            if req_id and self._latest_init_req_id and req_id != self._latest_init_req_id:
                return False
            return True

    def _finish_init_request_if_current(self, init_generation: int, req_id: str = '') -> None:
        req_id = str(req_id or '')
        try:
            init_generation = int(init_generation or 0)
        except Exception:
            init_generation = 0

        with self._init_lock:
            if init_generation != self._latest_init_generation:
                return
            if req_id and self._latest_init_req_id and req_id != self._latest_init_req_id:
                return
            self._init_busy = False

    def handle_ping(self, msg: dict):
        emit({'id': msg.get('id', ''), 'type': 'pong'})

    def handle_init_avatar(self, msg: dict):
        """Split init: clone_video_local in bg thread, V2Manager creation in main thread.
        OpenCV windows MUST be created in the main thread on Windows."""
        req_id = msg.get('id', '')
        video_path = msg.get('video', '')
        driving_video_path = msg.get('driving_video', '') or video_path
        camera_mode = msg.get('camera_mode', False)
        camera_index = msg.get('camera_index', -1)
        init_generation = self._register_init_request(req_id, msg.get('init_generation', 0))

        if not video_path:
            emit({'id': req_id, 'type': 'error', 'error': 'Missing video path'})
            return
        if init_generation is None:
            emit({'id': req_id, 'type': 'error', 'error': 'init_avatar superseded before dispatch'})
            return

        # Phase 1: Resolve data_dir (may need clone_video_local — slow).
        # This always resolves the selected avatar video to its own character
        # data, matching yundingyunbo's native clone -> model flow.
        def _resolve_data():
            try:
                def _emit_init_status(stage: str, detail: str = '', elapsed: float = 0.0):
                    if not self._is_current_init_request(init_generation, req_id):
                        return
                    payload = {'id': req_id, 'type': 'status', 'stage': stage}
                    if detail:
                        payload['detail'] = detail
                    if elapsed > 0:
                        payload['elapsed'] = float(elapsed)
                    emit(payload)

                if not self._is_current_init_request(init_generation, req_id):
                    log(
                        f'Dropping stale init before preprocess: req_id={req_id[:8]}, '
                        f'generation={init_generation}'
                    )
                    return
                _emit_init_status('resolve_data', video_path, 0.0)
                data_dir = self._ensure_character(video_path, progress_cb=_emit_init_status)
                resolved_driving_video_path = (
                    _remap_to_runtime_alias(driving_video_path) if driving_video_path else video_path
                )

                # Determine portrait window size from the normalized reference,
                # but keep playback timing/length from the real driving video.
                normalized = os.path.join(data_dir, 'normalized_video.mp4')
                if os.path.exists(normalized):
                    reference_frame_source_path = normalized
                    reference_frame_source_info = self._get_video_info(normalized)
                else:
                    reference_frame_source_path = video_path
                    reference_frame_source_info = self._get_video_info(video_path)
                window_info = dict(reference_frame_source_info)

                if camera_mode:
                    driving_video_info = dict(reference_frame_source_info)
                else:
                    driving_video_info = self._get_video_info(resolved_driving_video_path)
                    if driving_video_info.get('n_frames', 0) <= 0 and os.path.exists(normalized):
                        driving_video_info = self._get_video_info(normalized)
                        log(
                            'Driving video metadata unavailable; falling back to normalized reference '
                            f'video info from {normalized}'
                        )

                if camera_mode:
                    self._log_video_info(
                        'Camera reference video info',
                        reference_frame_source_path,
                        reference_frame_source_info,
                    )
                else:
                    self._log_video_info(
                        'File-mode reference frame source info',
                        reference_frame_source_path,
                        reference_frame_source_info,
                    )
                    self._log_video_info('File-mode driving video info', resolved_driving_video_path, driving_video_info)

                    reference_frames = int(reference_frame_source_info.get('n_frames') or 0)
                    driving_frames = int(driving_video_info.get('n_frames') or 0)
                    if reference_frames > 0 and driving_frames > 0 and reference_frames != driving_frames:
                        log(
                            'File-mode source mismatch detected before manager create: '
                            f'reference_frames={reference_frames}, driving_frames={driving_frames}, '
                            f'auto_special_reader={self._auto_start_file_mode_special_reader_enabled()}'
                        )

                if not camera_mode:
                    window_info = {
                        **window_info,
                        'width': 720,
                        'height': 1280,
                    }
                    log('File-mode base window set to portrait 9:16: 720x1280 (resizable)')

                if not self._is_current_init_request(init_generation, req_id):
                    log(
                        f'Dropping stale init after resolve: req_id={req_id[:8]}, '
                        f'generation={init_generation}'
                    )
                    return

                # Queue the result for main thread to finish (create V2Manager)
                _emit_init_status(
                    'creating_manager',
                    f'input_mode={"camera" if camera_mode else "file"}, data_dir={data_dir}',
                    0.0,
                )
                self._deferred_init_queue.put({
                    'req_id': req_id,
                    'init_generation': init_generation,
                    'data_dir': data_dir,
                    'window_info': window_info,
                    'driving_video_info': driving_video_info,
                    'reference_frame_source_path': reference_frame_source_path,
                    'reference_frame_source_info': dict(reference_frame_source_info),
                    'camera_mode': camera_mode,
                    'camera_index': camera_index,
                    'video_path': video_path,
                    'driving_video_path': resolved_driving_video_path,
                })
            except Exception as e:
                if not self._is_current_init_request(init_generation, req_id):
                    log(
                        f'Ignoring stale init resolve error: req_id={req_id[:8]}, '
                        f'generation={init_generation}, error={e}'
                    )
                    return
                log(f'init_avatar resolve error: {traceback.format_exc()}')
                self._finish_init_request_if_current(init_generation, req_id)
                emit({'id': req_id, 'type': 'error', 'error': str(e)})

        resolve_thread = threading.Thread(target=_resolve_data, daemon=True, name='ydb-resolve')
        resolve_thread.start()

    def _process_deferred_inits(self):
        """Called from main thread to finish V2Manager creation.
        V2Manager + OpenCV window MUST be created in main thread."""
        try:
            while True:
                item = self._deferred_init_queue.get_nowait()
                req_id = item['req_id']
                init_generation = item.get('init_generation', 0)
                data_dir = item['data_dir']
                window_info = item.get('window_info') or {}
                driving_video_info = item.get('driving_video_info') or {}
                reference_frame_source_path = item.get('reference_frame_source_path', '')
                reference_frame_source_info = item.get('reference_frame_source_info') or {}
                camera_mode = item['camera_mode']
                camera_index = item['camera_index']
                video_path = item['video_path']
                driving_video_path = item.get('driving_video_path', video_path)
                remapped_driving_video_path = (
                    _remap_to_runtime_alias(driving_video_path) if driving_video_path else ''
                )

                if not self._is_current_init_request(init_generation, req_id):
                    log(
                        f'Dropping superseded deferred init: req_id={req_id[:8]}, '
                        f'generation={init_generation}'
                    )
                    continue

                try:
                    target_input_mode = 'camera' if camera_mode else 'file'
                    target_file_mode_backend = 'v2'
                    effective_driving_video_path = remapped_driving_video_path
                    effective_driving_video_info = dict(driving_video_info or {})
                    if target_input_mode == 'file':
                        target_file_mode_backend, backend_reason = self._resolve_file_mode_backend(
                            reference_frame_source_info,
                            remapped_driving_video_path,
                            driving_video_info,
                        )
                        log(
                            f'File-mode backend selected: {target_file_mode_backend} '
                            f'({backend_reason})'
                        )
                        (
                            effective_driving_video_path,
                            effective_driving_video_info,
                            runtime_driving_meta,
                        ) = self._resolve_file_mode_runtime_driving(
                            target_file_mode_backend,
                            remapped_driving_video_path,
                            driving_video_info,
                            reference_frame_source_path,
                            reference_frame_source_info,
                        )
                        self._video_stream_direct_drive_enabled = bool(
                            runtime_driving_meta.get('direct_playback')
                        )
                        if effective_driving_video_path != remapped_driving_video_path:
                            runtime_reason = str(runtime_driving_meta.get('reason') or 'runtime override')
                            log(
                                'File-mode runtime driving binding applied: '
                                f'raw={remapped_driving_video_path}, '
                                f'effective={effective_driving_video_path}, '
                                f'backend={target_file_mode_backend}, reason={runtime_reason}'
                            )
                    else:
                        self._video_stream_direct_drive_enabled = False

                    need_recreate = (
                        self.manager is None or
                        self.manager_input_mode != target_input_mode
                    )
                    if (
                        not need_recreate
                        and target_input_mode == 'file'
                        and (self.manager_file_mode_backend or 'v2') != target_file_mode_backend
                    ):
                        need_recreate = True
                        log(
                            'File-mode backend changed, recreating manager: '
                            f'{self.manager_file_mode_backend or "v2"} -> {target_file_mode_backend}'
                        )
                    if (
                        not need_recreate
                        and target_input_mode == 'file'
                        and effective_driving_video_path != (self.manager_driving_video_path or '')
                    ):
                        need_recreate = True
                        log(
                            'Driving video changed in file mode, recreating manager: '
                            f'{self.manager_driving_video_path or "(none)"} -> {effective_driving_video_path}'
                        )

                    if need_recreate:
                        if self.manager is not None:
                            log(
                                'Recreating manager: '
                                f'input_mode={self.manager_input_mode} -> {target_input_mode}, '
                                f'backend={self.manager_file_mode_backend or "v2"} -> {target_file_mode_backend}'
                            )
                            self._destroy_manager()
                        if target_input_mode == 'file':
                            self._file_mode_reference_video_path = reference_frame_source_path
                            self._file_mode_reference_video_info = dict(reference_frame_source_info)
                        self._create_manager(
                            data_dir,
                            window_info,
                            camera_mode,
                            camera_index,
                            effective_driving_video_path if not camera_mode else video_path,
                            driving_video_info=effective_driving_video_info,
                            file_mode_backend=target_file_mode_backend,
                        )
                    elif data_dir != self.manager_data_dir:
                        switch_image_model = getattr(self.manager, 'switch_image_model', None)
                        if callable(switch_image_model):
                            log(f'Switching model: {self.manager_data_dir} -> {data_dir}')
                            switch_image_model(data_dir)
                        else:
                            log(
                                'Current manager backend does not support switch_image_model; '
                                f'updating manager_data_dir only ({self.manager_data_dir} -> {data_dir})'
                            )
                        self.manager_data_dir = data_dir
                        if target_input_mode == 'file':
                            self._file_mode_reference_video_path = reference_frame_source_path
                            self._file_mode_reference_video_info = dict(reference_frame_source_info)
                    else:
                        log(
                            'Manager already initialized, reusing '
                            f'(backend={self.manager_file_mode_backend or "v2"})'
                        )
                        if target_input_mode == 'file':
                            self._file_mode_reference_video_path = reference_frame_source_path
                            self._file_mode_reference_video_info = dict(reference_frame_source_info)

                    if target_input_mode == 'file':
                        self._log_file_mode_binding_summary('manager-ready')

                    if target_input_mode == 'file':
                        self._reset_file_mode_driving(
                            effective_driving_video_path,
                            effective_driving_video_info,
                        )
                    else:
                        self._reset_file_mode_driving()

                    if not self._is_current_init_request(init_generation, req_id):
                        log(
                            f'Init superseded after manager update; skipping result emit: '
                            f'req_id={req_id[:8]}, generation={init_generation}'
                        )
                        continue

                    emit({
                        'id': req_id,
                        'type': 'result',
                        'fps': effective_driving_video_info.get('fps') or window_info.get('fps') or 25,
                        'width': window_info.get('width') or 720,
                        'height': window_info.get('height') or 1280,
                        'n_frames': effective_driving_video_info.get('n_frames') or window_info.get('n_frames') or 0,
                    })
                except Exception as e:
                    if not self._is_current_init_request(init_generation, req_id):
                        log(
                            f'Ignoring stale init create error: req_id={req_id[:8]}, '
                            f'generation={init_generation}, error={e}'
                        )
                        continue
                    log(f'init_avatar create error: {traceback.format_exc()}')
                    emit({'id': req_id, 'type': 'error', 'error': str(e)})
                finally:
                    self._finish_init_request_if_current(init_generation, req_id)
        except qmod.Empty:
            pass

    def handle_process_audio(self, msg: dict):
        req_id = msg.get('id', '')
        audio_path = msg.get('audio', '')

        if not audio_path:
            emit({'id': req_id, 'type': 'error', 'error': 'Missing audio path'})
            return
        if not self.manager:
            emit({'id': req_id, 'type': 'error', 'error': 'No manager initialized'})
            return

        try:
            self._log_face_reader_state('before_audio')
            try:
                from main import get_audio_duration
                duration = get_audio_duration(audio_path)
            except Exception:
                duration = 3.0
            direct_playback_request = None

            if self.manager_input_mode == 'file' and self.manager_file_mode_backend == 'origin_frame':
                if not self._ensure_origin_frame_file_mode_reader(reason=f'process_audio:{req_id[:8]}'):
                    raise RuntimeError('origin-frame reader is not ready for file-mode playback')

            if self._can_use_file_mode_special_drive():
                request = self._reserve_file_mode_drive_request(req_id, audio_path, duration)
                done_padding = max(
                    0.2,
                    float(os.environ.get('YDB_FILE_MODE_SPECIAL_DRIVE_DONE_PADDING_SECONDS', '1.2')),
                )
                done_after_seconds = max(0.2, float(duration or 0.0) + done_padding)
                self._pending_audio[req_id] = {
                    'duration': duration,
                    'num_frames': int(request['num_frames']),
                    'queued_at': time.time(),
                    'saw_nonempty': True,
                    'pickup_timeout_seconds': 0.0,
                    'done_after_seconds': done_after_seconds,
                    'min_play_ratio': 1.0,
                    'mode': 'special_drive',
                    'end_frame': request.get('end_frame'),
                }
                log(
                    'Queued file-mode driving request: '
                    f'audio={os.path.basename(audio_path)}, start={request["start_sec"]:.2f}s, '
                    f'duration={request["duration"]:.2f}s, frames={request["num_frames"]}, '
                    f'startFrame={int(request.get("start_frame") or 0)}, '
                    f'endFrame={request.get("end_frame")}, '
                    f'doneAfter={done_after_seconds:.2f}s'
                )
                self._file_drive_queue.put(request)

                emit({
                    'id': req_id,
                    'type': 'ack',
                    'num_frames': int(request['num_frames']),
                    'total_chunks': 1,
                    'audio_duration': duration,
                })
                return

            if self._can_track_file_mode_direct_playback():
                direct_playback_request = self._reserve_file_mode_drive_request(req_id, audio_path, duration)
                num_frames = max(1, int(direct_playback_request.get('num_frames') or 0))
                log(
                    'Queued file-mode direct playback request: '
                    f'audio={os.path.basename(audio_path)}, start={float(direct_playback_request.get("start_sec") or 0.0):.2f}s, '
                    f'duration={float(direct_playback_request.get("duration") or 0.0):.2f}s, '
                    f'frames={num_frames}, '
                    f'startFrame={int(direct_playback_request.get("start_frame") or 0)}, '
                    f'endFrame={direct_playback_request.get("end_frame")}'
                )
            else:
                num_frames = int(duration * 25)
            # Queue audio before start_playing in camera mode. In bridge mode
            # the native camera reader can self-stop while idling, but it stays
            # stable when audio is already waiting in the queue at startup.
            if self.manager_input_mode == 'file' and self.manager_file_mode_backend == 'origin_frame':
                try:
                    batch_count = self._enqueue_origin_frame_audio_with_manual_state(audio_path)
                    log(
                        'Origin-frame manual-state audio queue accepted: '
                        f'audio={os.path.basename(audio_path)}, batches={batch_count}'
                    )
                except Exception as manual_exc:
                    allow_native_add_fallback = _truthy_env(
                        'YDB_ORIGIN_FRAME_ALLOW_NATIVE_ADD_FALLBACK',
                        '0',
                    )
                    if not allow_native_add_fallback:
                        raise
                    log(
                        'Origin-frame prepared native-state enqueue failed; '
                        'using raw native add_audio_to_queue fallback: '
                        f'{manual_exc}'
                    )
                    self._add_origin_frame_audio_natively(audio_path)
            else:
                self.manager.add_audio_to_queue(audio_path, queue_name='normal')
            started_now = self._ensure_manager_playing()
            if started_now:
                log(f'Playback started for request {req_id[:8]}')
            log(f'Queued audio: {os.path.basename(audio_path)} ({duration:.1f}s, {num_frames} frames)')

            emit({
                'id': req_id,
                'type': 'ack',
                'num_frames': num_frames,
                'total_chunks': 1,
                'audio_duration': duration,
            })

            # Track for done detection
            self._pending_audio[req_id] = {
                'duration': duration,
                'num_frames': num_frames,
                'queued_at': time.time(),
                'saw_nonempty': bool(direct_playback_request),
                'pickup_timeout_seconds': 0.0 if direct_playback_request else 3.0,
                'done_after_seconds': max(0.2, float(duration or 0.0) + 0.15) if direct_playback_request else 0.0,
                'min_play_ratio': 1.0 if direct_playback_request else 0.7,
                'mode': 'direct_playback' if direct_playback_request else '',
                'start_frame': direct_playback_request.get('start_frame') if direct_playback_request else None,
                'end_frame': direct_playback_request.get('end_frame') if direct_playback_request else None,
            }

        except Exception as e:
            log(f'process_audio error: {traceback.format_exc()}')
            emit({'id': req_id, 'type': 'error', 'error': str(e)})

    def handle_shutdown(self, msg: dict):
        log('Shutdown requested')
        self.running = False
        with self._init_lock:
            self._init_busy = False
            self._latest_init_req_id = ''
        self._destroy_manager()
        emit({'id': msg.get('id', ''), 'type': 'ack'})

    # ── Pending audio done detection ───────────────────────────────────

    def _check_pending_audio(self):
        if not self._pending_audio:
            return

        queue_lengths = self._get_queue_lengths_snapshot()
        queue_len = sum(queue_lengths.values())
        now = time.time()
        done_ids = []

        for req_id, info in self._pending_audio.items():
            elapsed = now - info['queued_at']
            pickup_timeout = max(0.0, float(info.get('pickup_timeout_seconds') or 3.0))
            mode = str(info.get('mode') or '')

            # Phase 1: wait for V2Manager to pick up the audio
            if not info['saw_nonempty']:
                if queue_len > 0:
                    info['saw_nonempty'] = True
                    log(
                        f'Audio {req_id[:8]}: picked up '
                        f'(queue={queue_len}, detail={queue_lengths})'
                    )
                elif pickup_timeout <= 0.0 or elapsed > pickup_timeout:
                    info['saw_nonempty'] = True
                    log(
                        f'Audio {req_id[:8]}: forced pick-up after {elapsed:.1f}s '
                        f'(queue={queue_len}, detail={queue_lengths})'
                    )
                    continue

            if mode == 'special_drive':
                # Special-drive requests report completion from the worker
                # thread so the main process receives the exact end_frame.
                # Keep the watchdog only as a last-resort timeout guard.
                if elapsed > info['duration'] + 30:
                    log(
                        f'Audio {req_id[:8]}: special-drive timeout after {elapsed:.1f}s '
                        f'(queue={queue_len}, detail={queue_lengths})'
                    )
                    done_ids.append(req_id)
                continue

            # Phase 2: wait for queue to drain + enough playback time elapsed
            done_after_seconds = max(0.0, float(info.get('done_after_seconds') or 0.0))
            min_play_ratio = max(0.0, float(info.get('min_play_ratio') or 0.7))
            min_play = info['duration'] * min_play_ratio
            if done_after_seconds > 0.0 and elapsed >= done_after_seconds:
                done_ids.append(req_id)
            elif queue_len == 0 and elapsed >= min_play:
                done_ids.append(req_id)
            elif elapsed > info['duration'] + 30:
                log(
                    f'Audio {req_id[:8]}: timeout after {elapsed:.1f}s '
                    f'(queue={queue_len}, detail={queue_lengths})'
                )
                done_ids.append(req_id)

        for req_id in done_ids:
            info = self._pending_audio.pop(req_id)
            elapsed = time.time() - info['queued_at']
            log(
                f'Audio {req_id[:8]}: done ({elapsed:.1f}s, '
                f'queue={queue_len}, detail={queue_lengths})'
            )
            emit({
                'id': req_id,
                'type': 'done',
                'total_chunks': 1,
                'total_frames': info['num_frames'],
                'end_frame': info.get('end_frame'),
            })
            self._stop_origin_frame_idle_playback(reason=f'audio-done:{req_id[:8]}')

    # ── Stdin reader (background thread) ───────────────────────────────

    def _stdin_reader(self):
        try:
            for line in sys.stdin:
                line = line.strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                    self.cmd_queue.put(msg)
                except json.JSONDecodeError as e:
                    log(f'Invalid JSON: {e}')
        except Exception as e:
            log(f'Stdin reader error: {e}')
        finally:
            log('Stdin closed')
            self.running = False

    # ── Main loop (main thread — required for OpenCV window) ───────────

    def run(self):
        log(f'Bridge starting, yundingyunbo_base={YUNDINGYUNBO_BASE}')
        log(f'Camera capture mode: {self._camera_capture_mode}')

        try:
            os.chdir(YUNDINGYUNBO_BASE)
            from main import initialize_environment
            initialize_environment()
            log('Environment initialized')
        except Exception as e:
            log(f'Warning: initialize_environment failed: {e}')

        emit({'type': 'ready'})

        handlers = {
            'ping': self.handle_ping,
            'init_avatar': self.handle_init_avatar,
            'process_audio': self.handle_process_audio,
            'shutdown': self.handle_shutdown,
        }

        stdin_thread = threading.Thread(target=self._stdin_reader, daemon=True, name='ydb-stdin')
        stdin_thread.start()

        import cv2
        while self.running:
            # Drain command queue
            try:
                while True:
                    msg = self.cmd_queue.get_nowait()
                    cmd = msg.get('cmd', '')
                    handler = handlers.get(cmd)
                    if handler:
                        try:
                            handler(msg)
                        except Exception as e:
                            log(f'Handler error [{cmd}]: {traceback.format_exc()}')
                            emit({'id': msg.get('id', ''), 'type': 'error', 'error': str(e)})
                    else:
                        emit({'id': msg.get('id', ''), 'type': 'error', 'error': f'Unknown command: {cmd}'})
            except qmod.Empty:
                pass

            # Process deferred V2Manager creation (MUST be in main thread for OpenCV)
            self._process_deferred_inits()
            self._process_file_mode_driving_queue()

            if not _SKIP_QUEUE_POLL:
                self._check_pending_audio()

            self._pump_direct_camera_preview_upload()

            # Allow experiments that disable the manual waitKey pump to match
            # the direct V2Manager test path more closely.
            if _SKIP_WAITKEY:
                time.sleep(0.01)
            else:
                cv2.waitKey(10)

        log('Bridge exiting')


def _parse_preprocess_worker_args(argv):
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument('--preprocess-worker', action='store_true')
    parser.add_argument('--video', required=True)
    parser.add_argument('--base-character-path', required=True)
    parser.add_argument('--name', required=True)
    parser.add_argument('--model-id', required=True)
    parser.add_argument('--clone-source', default='auto')
    parser.add_argument('--force-cpu', action='store_true')
    return parser.parse_args(argv)


def _run_preprocess_worker(argv) -> int:
    args = _parse_preprocess_worker_args(argv)
    reporter = _PreprocessReporter(
        video_path=str(args.video),
        model_id=str(args.model_id),
        force_cpu=bool(args.force_cpu),
        clone_source=str(args.clone_source or 'auto'),
    )
    global _ACTIVE_PREPROCESS_REPORTER
    _ACTIVE_PREPROCESS_REPORTER = reporter
    reporter.start()

    if args.force_cpu:
        os.environ['YDB_PREPROCESS_FORCE_CPU'] = '1'
    else:
        os.environ.pop('YDB_PREPROCESS_FORCE_CPU', None)

    try:
        os.makedirs(args.base_character_path, exist_ok=True)
        clone_video_local, clone_impl_name = resolve_clone_video_local(args.clone_source)
        reporter.log(f'Using {clone_impl_name} for isolated character preprocessing')

        try:
            import importlib

            main_module = importlib.import_module('main')
            initialize_environment = getattr(main_module, 'initialize_environment', None)
        except Exception:
            initialize_environment = None

        if callable(initialize_environment):
            with _preprocess_stage('main.initialize_environment', f'base={YUNDINGYUNBO_BASE}'):
                initialize_environment()

        with _preprocess_stage(
            clone_impl_name,
            f'video={args.video}, output={args.base_character_path}, model_id={args.model_id}',
        ):
            returned_model_id = clone_video_local(
                video_path=str(args.video),
                base_character_path=str(args.base_character_path),
                name=str(args.name),
                model_id=str(args.model_id),
            )

        data_dir = os.path.join(str(args.base_character_path), str(returned_model_id))
        valid, reason = _validate_character_dir_tree(data_dir, str(args.base_character_path))
        if not valid:
            emit(
                {
                    'type': 'error',
                    'stage': 'validate_character_output',
                    'error': f'Character preprocessing produced incomplete output: {reason}',
                    'data_dir': data_dir,
                }
            )
            return 2

        emit(
            {
                'type': 'result',
                'model_id': str(returned_model_id),
                'data_dir': data_dir,
                'reason': '',
            }
        )
        return 0
    except Exception as exc:
        stage = 'unknown'
        detail = ''
        if reporter is not None:
            stage, detail, _elapsed = reporter.current_stage_snapshot()
        emit(
            {
                'type': 'error',
                'stage': stage,
                'detail': detail,
                'error': str(exc),
                'traceback': traceback.format_exc(),
            }
        )
        return 1
    finally:
        reporter.stop()
        _ACTIVE_PREPROCESS_REPORTER = None


def main():
    if len(sys.argv) > 1 and sys.argv[1] == '--preprocess-worker':
        return _run_preprocess_worker(sys.argv[1:])
    bridge = YundingyunboBridge()
    bridge.run()


if __name__ == '__main__':
    main()
