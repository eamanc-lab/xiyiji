#!/usr/bin/env python3
import argparse
import json
import os
import queue
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Smoke-test packaged yundingyunbo init_avatar flow.")
    parser.add_argument("--ydb-base", required=True)
    parser.add_argument("--bridge-script", required=True)
    parser.add_argument("--data-dir", required=True)
    parser.add_argument("--video", required=True)
    parser.add_argument("--audio")
    parser.add_argument("--expected-backend", choices=["v2", "origin_frame"], default="v2")
    parser.add_argument("--ack-timeout-seconds", type=float, default=120.0)
    parser.add_argument("--done-timeout-seconds", type=float, default=180.0)
    parser.add_argument("--timeout-seconds", type=float, default=180.0)
    parser.add_argument("--post-init-sleep", type=float, default=2.0)
    parser.add_argument("--force-origin-frame", action="store_true")
    parser.add_argument("--force-silence-batches", action="store_true")
    parser.add_argument("--log-file")
    return parser.parse_args()


class BridgeSmokeClient:
    def __init__(self, python_exe: Path, bridge_script: Path, env: dict[str, str]) -> None:
        self.python_exe = python_exe
        self.bridge_script = bridge_script
        self.env = env
        self.proc: subprocess.Popen[str] | None = None
        self.msg_queue: "queue.Queue[dict]" = queue.Queue()
        self.stdout_lines: list[str] = []
        self.stderr_lines: list[str] = []

    def start(self) -> None:
        self.proc = subprocess.Popen(
            [str(self.python_exe), "-u", str(self.bridge_script)],
            cwd=str(self.python_exe.parent.parent),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            env=self.env,
        )
        assert self.proc.stdin is not None
        assert self.proc.stdout is not None
        assert self.proc.stderr is not None

        def read_stdout() -> None:
            for line in self.proc.stdout:
                text = line.rstrip("\r\n")
                if not text:
                    continue
                self.stdout_lines.append(text)
                if len(self.stdout_lines) > 2000:
                    self.stdout_lines = self.stdout_lines[-2000:]
                print(f"[ydb-smoke][stdout] {text}", flush=True)
                try:
                    self.msg_queue.put(json.loads(text))
                except Exception:
                    continue

        def read_stderr() -> None:
            for line in self.proc.stderr:
                text = line.rstrip("\r\n")
                if not text:
                    continue
                self.stderr_lines.append(text)
                if len(self.stderr_lines) > 4000:
                    self.stderr_lines = self.stderr_lines[-4000:]
                print(f"[ydb-smoke][stderr] {text}", flush=True)

        threading.Thread(target=read_stdout, daemon=True, name="ydb-smoke-stdout").start()
        threading.Thread(target=read_stderr, daemon=True, name="ydb-smoke-stderr").start()

    def send(self, payload: dict) -> None:
        if not self.proc or not self.proc.stdin:
            raise RuntimeError("bridge process is not running")
        line = json.dumps(payload, ensure_ascii=False)
        self.proc.stdin.write(line + "\n")
        self.proc.stdin.flush()

    def wait_for(self, types: set[str], timeout_seconds: float, request_id: str | None = None) -> dict:
        deadline = time.time() + timeout_seconds
        while time.time() < deadline:
            if self.proc and self.proc.poll() is not None:
                raise RuntimeError(f"bridge exited with code {self.proc.returncode}")
            try:
                message = self.msg_queue.get(timeout=0.2)
            except queue.Empty:
                continue
            if request_id is not None and message.get("id") != request_id:
                continue
            if message.get("type") in types:
                return message
        raise TimeoutError(f"timed out waiting for {sorted(types)}")

    def shutdown(self) -> None:
        if not self.proc:
            return
        try:
            self.send({"cmd": "shutdown", "id": f"shutdown-{uuid.uuid4().hex[:8]}"})
        except Exception:
            pass
        try:
            self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()


def build_env(
    ydb_base: Path,
    data_dir: Path,
    *,
    force_origin_frame: bool,
    force_silence_batches: bool,
) -> dict[str, str]:
    env = os.environ.copy()
    path_entries = [
        str(ydb_base / "node"),
        str(ydb_base / "env" / "ffmpeg" / "bin"),
        str(ydb_base / "env_50" / "ffmpeg" / "bin"),
    ]
    existing = [entry for entry in env.get("PATH", "").split(os.pathsep) if entry]
    env["PATH"] = os.pathsep.join(path_entries + existing)
    env["PYTHONIOENCODING"] = "utf-8"
    env["YUNDINGYUNBO_BASE"] = str(ydb_base)
    env["XIYIJI_DATA_DIR"] = str(data_dir)
    env["XIYIJI_NODE_DIR"] = str(ydb_base / "node")
    env["XIYIJI_FFMPEG_DIR"] = str(ydb_base / "env" / "ffmpeg" / "bin")
    ffmpeg_exe = ydb_base / "env" / "ffmpeg" / "bin" / "ffmpeg.exe"
    env["FFMPEG_BINARY"] = str(ffmpeg_exe)
    env["IMAGEIO_FFMPEG_EXE"] = str(ffmpeg_exe)
    env["PYDUB_FFMPEG_PATH"] = str(ffmpeg_exe)
    env.setdefault(
        "XIYIJI_RUNTIME_ALIAS_ROOT",
        str((Path(__file__).resolve().parent.parent / "tmp" / "ydb_runtime_aliases").resolve()),
    )
    if force_origin_frame:
        env["YDB_FORCE_ORIGIN_FRAME_FILE_MODE"] = "1"
    if force_silence_batches:
        env["YDB_ORIGIN_FRAME_FORCE_SILENCE_BATCHES"] = "1"
    return env


def main() -> int:
    args = parse_args()
    ydb_base = Path(args.ydb_base).resolve()
    bridge_script = Path(args.bridge_script).resolve()
    data_dir = Path(args.data_dir).resolve()
    video_path = Path(args.video).resolve()
    audio_path = Path(args.audio).resolve() if args.audio else None
    python_exe = ydb_base / "env" / "python.exe"

    required_paths = [python_exe, bridge_script, data_dir, video_path]
    if audio_path is not None:
        required_paths.append(audio_path)

    for required_path in required_paths:
        if not required_path.exists():
            raise FileNotFoundError(f"missing required path: {required_path}")

        client = BridgeSmokeClient(
        python_exe=python_exe,
        bridge_script=bridge_script,
        env=build_env(
            ydb_base,
            data_dir,
            force_origin_frame=args.force_origin_frame,
            force_silence_batches=args.force_silence_batches,
        ),
    )

    log_path = Path(args.log_file).resolve() if args.log_file else None

    try:
        client.start()
        client.wait_for({"ready"}, timeout_seconds=args.timeout_seconds)

        request_id = f"init-{uuid.uuid4().hex[:8]}"
        client.send(
            {
                "cmd": "init_avatar",
                "id": request_id,
                "video": str(video_path),
                "camera_mode": False,
                "camera_index": -1,
            }
        )
        result = client.wait_for({"result", "error"}, timeout_seconds=args.timeout_seconds, request_id=request_id)
        if result.get("type") == "error":
            raise RuntimeError(str(result.get("error") or "unknown init_avatar error"))

        time.sleep(max(0.0, args.post_init_sleep))
        combined_logs = "\n".join(client.stderr_lines)
        if args.expected_backend == "v2":
            if "Creating V2Manager" not in combined_logs or "V2Manager created" not in combined_logs:
                raise RuntimeError("bridge init succeeded without V2Manager lifecycle logs")
        else:
            has_backend_marker = (
                "backend=origin_frame" in combined_logs
                or "File-mode backend selected: origin_frame" in combined_logs
                or "Origin-frame create_manager stage: VideoStreamManager constructed" in combined_logs
            )
            if not has_backend_marker:
                raise RuntimeError("bridge init succeeded without origin_frame backend logs")

        ack = None
        done = None
        if audio_path is not None:
            audio_request_id = f"audio-{uuid.uuid4().hex[:8]}"
            client.send(
                {
                    "cmd": "process_audio",
                    "id": audio_request_id,
                    "audio": str(audio_path),
                }
            )
            ack = client.wait_for(
                {"ack", "error"},
                timeout_seconds=args.ack_timeout_seconds,
                request_id=audio_request_id,
            )
            if ack.get("type") == "error":
                raise RuntimeError(str(ack.get("error") or "unknown process_audio ack error"))
            done = client.wait_for(
                {"done", "error"},
                timeout_seconds=args.done_timeout_seconds,
                request_id=audio_request_id,
            )
            if done.get("type") == "error":
                raise RuntimeError(str(done.get("error") or "unknown process_audio done error"))

        if log_path is not None:
            log_path.parent.mkdir(parents=True, exist_ok=True)
            log_path.write_text(
                "\n".join(
                    [f"[STDOUT] {line}" for line in client.stdout_lines]
                    + [f"[STDERR] {line}" for line in client.stderr_lines]
                ),
                encoding="utf-8",
            )

        print(
            json.dumps(
                {
                    "ok": True,
                    "backend": args.expected_backend,
                    "video": str(video_path),
                    "fps": result.get("fps"),
                    "width": result.get("width"),
                    "height": result.get("height"),
                    "n_frames": result.get("n_frames"),
                    "ack": ack,
                    "done": done,
                },
                ensure_ascii=False,
            ),
            flush=True,
        )
        return 0
    finally:
        if log_path is not None:
            try:
                log_path.parent.mkdir(parents=True, exist_ok=True)
                log_path.write_text(
                    "\n".join(
                        [f"[STDOUT] {line}" for line in client.stdout_lines]
                        + [f"[STDERR] {line}" for line in client.stderr_lines]
                    ),
                    encoding="utf-8",
                )
            except Exception:
                pass
        client.shutdown()


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print(f"[ydb-smoke] ERROR: {exc}", file=sys.stderr, flush=True)
        sys.exit(1)
