#!/usr/bin/env python3

import importlib.machinery
import importlib.util
import os
import sys
import types

os.environ['YDB_FORCE_V2_FILE_MODE'] = '0'
os.environ['YDB_FORCE_VIDEO_STREAM_FILE_MODE'] = '1'
os.environ.setdefault('YDB_ENABLE_BLOCKING_SPECIAL_DRIVE', '1')
os.environ.setdefault('YDB_FORCE_SEQUENTIAL_FILE_FRAMES', '1')
os.environ.setdefault('YDB_ENABLE_AUTO_SPECIAL_READER', '0')

import yundingyunbo_bridge as base


def _load_compiled_bridge():
    major_minor = f'{sys.version_info.major}{sys.version_info.minor}'
    candidates = [
        os.path.join(
            os.path.dirname(__file__),
            f'yundingyunbo_video_stream_bridge.compiled.cpython-{major_minor}.pyc',
        ),
        os.path.join(
            os.path.dirname(__file__),
            '__pycache__',
            f'yundingyunbo_video_stream_bridge.cpython-{major_minor}.pyc',
        ),
    ]
    pyc_path = next((candidate for candidate in candidates if os.path.isfile(candidate)), '')
    if not pyc_path:
        raise RuntimeError(f'compiled bridge missing: {candidates}')

    loader = importlib.machinery.SourcelessFileLoader('_ydb_vs_bridge_pyc', pyc_path)
    spec = importlib.util.spec_from_loader('_ydb_vs_bridge_pyc', loader)
    if spec is None:
        raise RuntimeError(f'failed to create spec for compiled bridge: {pyc_path}')

    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


_compiled_module = _load_compiled_bridge()
_CompiledVideoStreamBridge = _compiled_module.VideoStreamBridge


class VideoStreamBridge(_CompiledVideoStreamBridge):
    def _video_stream_no_loop_enabled(self) -> bool:
        raw = str(os.environ.get('YDB_VIDEO_STREAM_NO_LOOP', '1')).strip().lower()
        return raw not in ('0', 'false', 'off', 'no')

    def _maybe_install_video_stream_no_loop_patch(self) -> None:
        manager = getattr(self, 'manager', None)
        if manager is None:
            return

        enabled = (
            self._video_stream_no_loop_enabled()
            and getattr(self, 'manager_input_mode', None) == 'file'
            and str(getattr(self, 'manager_file_mode_backend', '') or '') == 'video_stream'
        )

        drive_info = dict(getattr(self, '_file_drive_video_info', {}) or {})
        total_frames = max(0, int(drive_info.get('n_frames') or 0))
        if total_frames <= 0:
            fps = max(1.0, float(drive_info.get('fps') or 25.0))
            duration = max(0.0, float(drive_info.get('duration') or 0.0))
            if duration > 0.0:
                total_frames = max(1, int(round(duration * fps)))

        try:
            setattr(manager, '_xiyiji_video_stream_no_loop_enabled', enabled)
            setattr(manager, '_xiyiji_video_stream_total_frames', total_frames)
        except Exception:
            pass

        if not enabled:
            return

        if not getattr(manager, '_xiyiji_video_stream_no_loop_patch', False):
            original = getattr(manager, '_generate_sequential_frame_sequence', None)
            if not callable(original):
                base.log('Video-stream no-loop patch skipped: sequential frame generator unavailable')
                return

            original_func = getattr(original, '__func__', original)

            def patched_generate_sequential_frame_sequence(inst, needed_frames, _orig=original_func):
                sequence = _orig(inst, needed_frames)
                if not getattr(inst, '_xiyiji_video_stream_no_loop_enabled', False):
                    return sequence

                total = max(0, int(getattr(inst, '_xiyiji_video_stream_total_frames', 0) or 0))
                if total <= 0 or not isinstance(sequence, list) or len(sequence) <= 1:
                    return sequence

                last_frame = max(0, total - 1)
                normalized = []
                previous = None
                wrapped = False

                for raw_index in sequence:
                    try:
                        index = int(raw_index)
                    except Exception:
                        index = 0

                    if index < 0:
                        index = 0
                    elif index > last_frame:
                        index = last_frame

                    if previous is not None:
                        if index < previous:
                            wrapped = True
                            index = previous
                        elif previous >= last_frame:
                            index = last_frame

                    normalized.append(index)
                    previous = index

                if wrapped and not getattr(inst, '_xiyiji_video_stream_wrap_logged', False):
                    base.log(
                        'Video-stream sequential frame generator reached EOF; '
                        f'clamping at frame {last_frame} instead of wrapping to 0'
                    )
                    try:
                        setattr(inst, '_xiyiji_video_stream_wrap_logged', True)
                    except Exception:
                        pass

                return normalized

            patched_method = types.MethodType(patched_generate_sequential_frame_sequence, manager)
            setattr(manager, '_generate_sequential_frame_sequence', patched_method)
            setattr(manager, '_xiyiji_video_stream_no_loop_patch', True)
            base.log('Installed video-stream no-loop sequential frame patch')

        if getattr(manager, '_xiyiji_force_sequential_file_frames', False):
            setattr(manager, '_generate_frame_sequence', getattr(manager, '_generate_sequential_frame_sequence'))

    def _configure_file_mode_frame_sequence(self):
        super()._configure_file_mode_frame_sequence()
        self._maybe_install_video_stream_no_loop_patch()

    def _reset_file_mode_driving(self, video_path: str = '', video_info: dict | None = None):
        super()._reset_file_mode_driving(video_path, video_info)
        self._maybe_install_video_stream_no_loop_patch()

    def _resolve_file_mode_runtime_driving(
        self,
        backend: str,
        driving_video_path: str,
        driving_video_info: dict | None = None,
        reference_frame_source_path: str = '',
        reference_frame_source_info: dict | None = None,
    ) -> tuple[str, dict, dict]:
        # Passthrough to parent — never force direct_playback. This keeps
        # special_drive mode enabled (per-segment processing of the full
        # driving video, similar to camera mode).
        resolved_path, resolved_info, meta = super()._resolve_file_mode_runtime_driving(
            backend,
            driving_video_path,
            driving_video_info,
            reference_frame_source_path,
            reference_frame_source_info,
        )

        if backend != 'video_stream':
            return resolved_path, resolved_info, meta

        # Override the driving video's logical fps with the reference fps.
        # frame_synthesizer.synthesize_batch in yundingyunbo expects segments
        # at the reference (normalized_video) fps — typically 25. If we leave
        # the driving fps as-is (e.g. 35 fps from the source video), each
        # generated segment has too many frames per audio second, the batch
        # boundaries don't align, and the synthesizer raises:
        #     ValueError: 输入批次大小(5)与要求的批次大小(4)不匹配
        #
        # The override only changes the logical fps used by the request
        # bookkeeping (cursor advancement, segment encoding via fps filter).
        # The physical driving video file is untouched. ffmpeg -ss seeks by
        # seconds (not frames), so segment seek positions stay correct.
        reference_info = dict(reference_frame_source_info or {})
        reference_fps = float(reference_info.get('fps') or 0.0)
        if reference_fps > 0:
            current_fps = float(resolved_info.get('fps') or 0.0)
            if abs(current_fps - reference_fps) > 0.5:
                duration = float(resolved_info.get('duration') or 0.0)
                new_info = dict(resolved_info)
                new_info['fps'] = reference_fps
                if duration > 0:
                    new_info['n_frames'] = max(1, int(round(duration * reference_fps)))
                base.log(
                    'Video-stream effective driving fps overridden for '
                    f'frame_synthesizer alignment: driving fps {current_fps:.3f} -> '
                    f'reference fps {reference_fps:.3f}, '
                    f'logical n_frames={new_info.get("n_frames")} '
                    f'(duration={duration:.3f}s)'
                )
                return resolved_path, new_info, meta

        return resolved_path, resolved_info, meta

    def _reserve_file_mode_drive_request(
        self,
        req_id: str,
        audio_path: str,
        duration: float,
        requested_start_frame: int | None = None,
    ) -> dict:
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
            num_frames = max(1, int(round(requested_duration * fps)))
            start_sec = 0.0
            start_frame = 0
            end_frame = None
            visible_end_frame = None
            no_loop = self._video_stream_no_loop_enabled()
            requested_start = None
            if requested_start_frame is not None:
                try:
                    requested_start = max(0, int(requested_start_frame))
                except Exception:
                    requested_start = 0

            if total_frames > 0:
                last_frame = max(0, total_frames - 1)
                if no_loop:
                    start_frame = min(
                        requested_start if requested_start is not None else max(0, int(self._file_drive_cursor_frame or 0)),
                        last_frame,
                    )
                    start_sec = start_frame / fps
                    visible_end_frame = min(last_frame, start_frame + num_frames - 1)
                    end_frame = visible_end_frame
                    next_frame = min(last_frame, start_frame + num_frames)
                    self._file_drive_cursor_frame = next_frame
                    self._file_drive_cursor_sec = (
                        min(total_duration, next_frame / fps)
                        if total_duration > 0.05 else next_frame / fps
                    )
                    if visible_end_frame >= last_frame and start_frame + num_frames > total_frames:
                        eof_log_key = (session_id, last_frame)
                        if getattr(self, '_xiyiji_video_stream_eof_log_key', None) != eof_log_key:
                            base.log(
                                'Video-stream drive request reached EOF; '
                                f'holding final frame {last_frame} '
                                f'(startFrame={start_frame}, requestedFrames={num_frames}, totalFrames={total_frames})'
                            )
                            setattr(self, '_xiyiji_video_stream_eof_log_key', eof_log_key)
                else:
                    start_frame = (
                        requested_start % total_frames
                        if requested_start is not None
                        else int(self._file_drive_cursor_frame or 0) % total_frames
                    )
                    start_sec = start_frame / fps
                    self._file_drive_cursor_frame = (start_frame + num_frames) % total_frames
                    self._file_drive_cursor_sec = self._file_drive_cursor_frame / fps
                    end_frame = (start_frame + num_frames - 1) % total_frames
            elif total_duration > 0.05:
                if no_loop:
                    if requested_start is not None:
                        start_sec = min(total_duration, max(0.0, float(requested_start) / fps))
                    else:
                        start_sec = min(max(0.0, float(self._file_drive_cursor_sec or 0.0)), total_duration)
                    next_sec = min(total_duration, start_sec + requested_duration)
                    self._file_drive_cursor_sec = next_sec
                    start_frame = int(round(start_sec * fps))
                    self._file_drive_cursor_frame = int(round(next_sec * fps))
                else:
                    if requested_start is not None:
                        start_sec = min(total_duration, max(0.0, float(requested_start) / fps))
                    else:
                        start_sec = self._file_drive_cursor_sec % total_duration
                    self._file_drive_cursor_sec = (start_sec + requested_duration) % total_duration
                    start_frame = int(round(start_sec * fps))
            else:
                self._file_drive_cursor_sec = 0.0
                self._file_drive_cursor_frame = 0

            request = {
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
            if visible_end_frame is not None:
                request['visible_end_frame'] = visible_end_frame
            return request


def main():
    if len(sys.argv) > 1 and sys.argv[1] == '--preprocess-worker':
        base._run_preprocess_worker(sys.argv[1:])
        return

    bridge = VideoStreamBridge()
    bridge.run()


if __name__ == '__main__':
    raise SystemExit(main())
