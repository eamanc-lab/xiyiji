#!/usr/bin/env python3
"""
Standalone camera proxy for yundingyunbo's native RealtimeFaceReader.

This runs in a separate Python process so the reader behaves like the
standalone test path instead of sharing V2Manager's in-process lifecycle.
It emits length-prefixed pickle messages on stdout and logs to stderr.
"""

import os
import pickle
import struct
import sys
import time
from pathlib import Path

import numpy as np


_BINARY_STDOUT = sys.stdout.buffer


class _StdoutToStderr:
    def write(self, data):
        if data:
            sys.stderr.write(data)
        return len(data)

    def flush(self):
        sys.stderr.flush()

    def isatty(self):
        return False


sys.stdout = _StdoutToStderr()


def log(msg: str) -> None:
    print(f'[YDB-CameraProxy] {msg}', file=sys.stderr, flush=True)


def send_message(payload: dict) -> None:
    data = pickle.dumps(payload, protocol=pickle.HIGHEST_PROTOCOL)
    _BINARY_STDOUT.write(struct.pack('<I', len(data)))
    _BINARY_STDOUT.write(data)
    _BINARY_STDOUT.flush()


def clone_detection(detection):
    if detection is None:
        return None
    cloned = {}
    for key, value in detection.items():
        if isinstance(value, np.ndarray):
            cloned[key] = value.copy()
        else:
            cloned[key] = value
    return cloned


def normalize_detection_batches(detections):
    normalized = []
    if detections is None:
        return normalized

    for detection in detections:
        if detection is None:
            normalized.append([])
        elif isinstance(detection, list):
            normalized_group = []
            for item in detection:
                if isinstance(item, dict):
                    if item.get('is_no_face'):
                        continue
                    normalized_group.append(
                        {key: value for key, value in item.items() if key != 'is_no_face'}
                    )
                else:
                    normalized_group.append(item)
            normalized.append(normalized_group)
        elif isinstance(detection, dict):
            if detection.get('is_no_face'):
                normalized.append([])
            else:
                normalized.append([
                    {key: value for key, value in detection.items() if key != 'is_no_face'}
                ])
        else:
            normalized.append(detection)
    return normalized


def clone_batch(frames, detections):
    cloned_frames = []
    if frames is not None:
        for frame in frames:
            if isinstance(frame, np.ndarray):
                cloned_frames.append(frame.copy())
            else:
                cloned_frames.append(frame)

    cloned_detections = []
    for group in normalize_detection_batches(detections):
        if isinstance(group, list):
            cloned_detections.append([
                clone_detection(item) if isinstance(item, dict) else item
                for item in group
            ])
        elif isinstance(group, dict):
            cloned_detections.append(clone_detection(group))
        else:
            cloned_detections.append(group)
    return cloned_frames, cloned_detections


def main() -> int:
    camera_index = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    base_dir = os.environ.get(
        'YUNDINGYUNBO_BASE',
        str(Path(__file__).resolve().parents[2]),
    )

    os.chdir(base_dir)
    sys.path.insert(0, base_dir)
    sys.path.insert(0, os.path.join(base_dir, 'live'))
    sys.path.insert(0, os.path.join(base_dir, 'bin', 'image_infer_v2'))

    from main import initialize_environment

    initialize_environment()

    from bin.image_infer_v2.tools.realtime_face_reader.realtime_face_reader import RealtimeFaceReader

    retry_delay = max(0.1, float(os.environ.get('YDB_PROXY_CAMERA_RETRY_DELAY', '0.35')))
    device = os.environ.get('YDB_CAMERA_DEVICE', 'cuda:0')
    target_batch_frames = max(1, int(os.environ.get('YDB_PROXY_CAMERA_TARGET_BATCH', '2')))
    max_batch_wait_s = max(0.01, float(os.environ.get('YDB_PROXY_CAMERA_MAX_BATCH_WAIT', '0.08')))
    attempt = 0

    while True:
        reader = None
        attempt += 1
        try:
            reader = RealtimeFaceReader(device=device)
            reader.start_capture(camera_index)
            send_message({
                'type': 'started',
                'camera_index': camera_index,
                'attempt': attempt,
                'device': device,
            })
            pending_frames = []
            pending_detections = []
            batch_started_at = None
            while True:
                frames, detections = next(reader)
                cloned_frames, cloned_detections = clone_batch(frames, detections)
                if not cloned_frames:
                    continue
                if batch_started_at is None:
                    batch_started_at = time.time()
                pending_frames.extend(cloned_frames)
                pending_detections.extend(cloned_detections)

                while len(pending_frames) >= target_batch_frames:
                    send_message({
                        'type': 'batch',
                        'frames': pending_frames[:target_batch_frames],
                        'detections': pending_detections[:target_batch_frames],
                    })
                    pending_frames = pending_frames[target_batch_frames:]
                    pending_detections = pending_detections[target_batch_frames:]
                    batch_started_at = time.time() if pending_frames else None

                if pending_frames and batch_started_at is not None:
                    if time.time() - batch_started_at >= max_batch_wait_s:
                        send_message({
                            'type': 'batch',
                            'frames': pending_frames,
                            'detections': pending_detections,
                        })
                        pending_frames = []
                        pending_detections = []
                        batch_started_at = None
        except KeyboardInterrupt:
            break
        except BrokenPipeError:
            break
        except StopIteration:
            send_message({'type': 'status', 'message': 'StopIteration; restarting camera reader'})
        except Exception as exc:
            send_message({'type': 'error', 'error': f'{type(exc).__name__}: {exc}'})
            log(f'Unhandled camera proxy error: {type(exc).__name__}: {exc}')
        finally:
            if reader is not None:
                try:
                    reader.stop_capture()
                except Exception as stop_exc:
                    log(f'stop_capture failed: {stop_exc}')

        time.sleep(retry_delay)

    return 0


if __name__ == '__main__':
    sys.exit(main())
