#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from statistics import mean


TS_RE = re.compile(r"^\[(\d{2}):(\d{2}):(\d{2})\.(\d{3})\]")
FIRST_FRAME_RE = re.compile(r"\[FRAME-STREAM\] first_frame latency_ms=(\d+)")
FALLBACK_RE = re.compile(r"\[AUTO-JUNC\] fallback frame")
UNDERRUN_RE = re.compile(r"\[FRAME-STREAM\] underrun")
TRANSPORT_RE = re.compile(r"\[F2F\] Stream transport=([a-z_]+)")


@dataclass
class TimedEvent:
    at_ms: int
    line: str


def parse_ts_ms(line: str) -> int | None:
    m = TS_RE.match(line)
    if not m:
        return None
    h, mi, s, ms = map(int, m.groups())
    return ((h * 60 + mi) * 60 + s) * 1000 + ms


def latest_log_path(explicit: str | None) -> Path:
    if explicit:
        p = Path(explicit).expanduser().resolve()
        if not p.exists():
            raise FileNotFoundError(f"log not found: {p}")
        return p
    appdata = os.environ.get("APPDATA", "").strip()
    if not appdata:
        raise RuntimeError("APPDATA is empty")
    log_dir = Path(appdata) / "xiyiji" / "logs"
    if not log_dir.exists():
        raise FileNotFoundError(f"log dir not found: {log_dir}")
    logs = sorted(log_dir.glob("*.log"), key=lambda p: p.stat().st_mtime, reverse=True)
    if not logs:
        raise FileNotFoundError(f"no .log in: {log_dir}")
    return logs[0]


def calc_gaps(ends: list[int], next_starts: list[int]) -> list[int]:
    out: list[int] = []
    j = 0
    for e in ends:
        while j < len(next_starts) and next_starts[j] < e:
            j += 1
        if j < len(next_starts):
            out.append(next_starts[j] - e)
    return out


def summarize(values: list[int], unit: str = "ms") -> str:
    if not values:
        return "NA"
    return f"avg={mean(values):.1f}{unit} min={min(values)}{unit} max={max(values)}{unit} n={len(values)}"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--log", default="", help="explicit log path, default latest %APPDATA%/xiyiji/logs/*.log")
    args = ap.parse_args()

    log_path = latest_log_path(args.log or None)
    lines = log_path.read_text(encoding="utf-8", errors="ignore").splitlines()

    stream_audio_start: list[int] = []
    stream_audio_end: list[int] = []
    first_frame_latency_ms: list[int] = []
    first_frame_at: list[int] = []
    fallback_count = 0
    underrun_count = 0
    transports: list[str] = []

    has_timestamp = False
    for idx, ln in enumerate(lines):
        ts = parse_ts_ms(ln)
        if ts is not None:
            has_timestamp = True
            event_pos = ts
        else:
            event_pos = idx
        m_transport = TRANSPORT_RE.search(ln)
        if m_transport:
            transports.append(m_transport.group(1))

        if "[Player LOG]: [StreamAudio] start " in ln:
            stream_audio_start.append(event_pos)
        elif "[Player LOG]: [StreamAudio] ended" in ln:
            stream_audio_end.append(event_pos)

        m_ff = FIRST_FRAME_RE.search(ln)
        if m_ff:
            first_frame_latency_ms.append(int(m_ff.group(1)))
            first_frame_at.append(event_pos)

        if FALLBACK_RE.search(ln):
            fallback_count += 1
        if UNDERRUN_RE.search(ln):
            underrun_count += 1

    gap_end_to_next_audio = calc_gaps(stream_audio_end, stream_audio_start)
    gap_end_to_next_first_frame = calc_gaps(stream_audio_end, first_frame_at)
    gap_unit = "ms" if has_timestamp else "lines"

    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print("REALTIME_LOG_ANALYSIS")
    print(f"time={now}")
    print(f"log={log_path}")
    if transports:
        uniq = sorted(set(transports))
        print(f"transport_seen={','.join(uniq)}")
    else:
        print("transport_seen=NA")
    print(f"stream_audio_start={len(stream_audio_start)} stream_audio_end={len(stream_audio_end)}")
    if first_frame_latency_ms:
        print(
            "first_frame_latency="
            + summarize(first_frame_latency_ms, "ms")
        )
    else:
        print("first_frame_latency=NA")
    print("gap_end_to_next_audio_start=" + summarize(gap_end_to_next_audio, gap_unit))
    print("gap_end_to_next_first_frame=" + summarize(gap_end_to_next_first_frame, gap_unit))
    print(f"fallback_count={fallback_count}")
    print(f"underrun_count={underrun_count}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
