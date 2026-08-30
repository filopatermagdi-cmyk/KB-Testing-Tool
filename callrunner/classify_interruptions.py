#!/usr/bin/env python3
"""
Interruption / talk-over classifier.

Each recording is a stereo WAV where:
    - LEFT  channel (0) = HUMAN
    - RIGHT channel (1) = AI agent

A recording is flagged as a BUG when the human and the AI are *both*
speaking simultaneously for a continuous stretch of at least
`interruption_seconds` (see CONFIG below). That sustained talk-over is the
failure case we want to catch.

Approach
--------
1. Split the stereo file into the human (L) and AI (R) channels.
2. Run a simple energy-based voice-activity detector (VAD) on each channel
   independently, using a per-channel adaptive noise floor so it copes with
   different gain levels between recordings.
3. Mark frames where BOTH channels are active -> overlap.
4. Merge overlap frames into segments (bridging tiny gaps), then check the
   longest segment against `interruption_seconds`.
5. Report / optionally copy the flagged recordings.

Pure-Python + numpy only; no ML model needed.

Usage
-----
Interruption-quality scan over recent calls (downloads + analyzes):
    python classify_interruptions.py --days 7                 # last 7 days (UTC)
    python classify_interruptions.py --since 2026-07-01       # from a date to today
    python classify_interruptions.py --since 2026-07-01 --until 2026-07-05
    python classify_interruptions.py --date 2026-07-06        # one explicit day
    python classify_interruptions.py --days 7 -t 2.0          # fail threshold = 2.0s overlap
    python classify_interruptions.py --days 7 --max-fail-rate 5   # exit 1 if >5% fail
    python classify_interruptions.py --no-download -d tmp/recordings  # offline, local WAVs

Single call (CallRunner integration): --handoff / --call-id / --latest.
Everything else (overlap threshold, VAD sensitivity, channels, paths, API base,
agent, page size) is in config.json or env — see that file. Credentials come
from ZILLA_EMAIL / ZILLA_PASSWORD (or ZIILA_API_*); API base + agent from
VITE_API_BASE_URL / ZILLA_AGENT_ID (or ZIILA_API_*).
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import shutil
import sys
import time
import urllib.request
import wave
from datetime import datetime, timedelta, timezone
from dataclasses import dataclass, asdict, fields
from pathlib import Path

import numpy as np


# --------------------------------------------------------------------------- #
# CONFIG
# --------------------------------------------------------------------------- #
# All tunables live in config.json (next to this script). Edit that file --
# you never need to open this one. CLI flags, if given, override the JSON.
DEFAULT_CONFIG_PATH = Path(__file__).with_name("config.json")


@dataclass
class Config:
    # --- the headline knob ---------------------------------------------------
    # Minimum continuous overlap (both speaking) to call a recording buggy.
    interruption_seconds: float = 1.0

    # --- which channel is who ------------------------------------------------
    human_channel: int = 0   # left
    ai_channel: int = 1      # right

    # --- VAD framing ---------------------------------------------------------
    frame_ms: float = 20.0          # analysis window length

    # --- VAD sensitivity -----------------------------------------------------
    # A frame counts as real SPEECH only when it clears BOTH bars:
    #   1. it is at least `margin_db` above the channel's adaptive noise floor
    #      (handles recordings that have a steady hiss/hum baseline), AND
    #   2. it is louder than `min_speech_dbfs` in absolute terms.
    # Bar 2 is the "don't count faint sound" knob: low-volume bleed, static and
    # background hiss live well below it, so they are never mistaken for someone
    # actually speaking. (Measured: real speech here peaks at -5..-25 dBFS,
    # faint/static material sits around -45..-67 dBFS, so -42 splits them.)
    noise_floor_percentile: float = 20.0   # percentile of frame energies = noise
    margin_db: float = 8.0                  # dB above noise floor to count as speech
    min_speech_dbfs: float = -42.0          # quieter than this is never speech

    # --- smoothing -----------------------------------------------------------
    # Ignore speech runs shorter than this: rejects isolated clicks/pops and
    # faint one-off blips that momentarily poke above the threshold.
    min_speech_ms: float = 100.0
    # Bridge short silences inside one speaker's turn so natural pauses don't
    # chop a single utterance into many tiny pieces (hangover).
    speech_hangover_ms: float = 150.0
    # When stitching overlap frames into segments, allow gaps up to this long.
    overlap_merge_gap_ms: float = 120.0

    # --- speech vs. background-noise gate ------------------------------------
    # Loudness alone can't tell a person talking from a passing car, a horn,
    # wind or crowd noise -- all of those can be loud enough to clear the energy
    # threshold and get mistaken for "human speaking", inflating false bugs.
    # When require_voiced is on, a frame must ALSO look like voiced speech:
    #   1. Harmonicity: it has a clear pitch (is periodic), measured via
    #      normalized autocorrelation. Broadband / aperiodic noise (traffic,
    #      wind, crowd babble, clatter) has no strong pitch and is rejected.
    #   2. The pitch sits in the human range (pitch_min_hz..pitch_max_hz). Tonal
    #      noise that is periodic but pitched above a human voice -- a car horn
    #      typically rings around 400-500 Hz -- is therefore rejected too.
    #   3. Voice-band ratio: most of the frame's energy lies in the speech band
    #      (voice_band_hz). Low-frequency engine/road rumble and high-frequency
    #      hiss fall outside it and are rejected.
    # The test is applied per speech REGION, not per frame: the energy VAD first
    # finds candidate speech stretches (so a real utterance keeps its full
    # length -- consonants and inter-syllable gaps included), then any region
    # whose voiced share is below `min_voiced_ratio` is thrown out as noise.
    # Set require_voiced=false to fall back to the old pure-energy VAD.
    require_voiced: bool = True
    voicing_min: float = 0.45                # min normalized autocorrelation, 0..1
    pitch_min_hz: float = 80.0               # lowest fundamental treated as a voice
    pitch_max_hz: float = 300.0              # highest; above this = not a human voice
    voice_band_hz: tuple[float, float] = (200.0, 3800.0)   # speech energy band
    voice_band_min_ratio: float = 0.40       # min share of energy inside that band
    min_voiced_ratio: float = 0.35           # min voiced share of a region to keep it

    # --- output --------------------------------------------------------------
    recordings_dir: str = "Recordings"
    report_csv: str = "interruption_report.csv"
    copy_flagged_to: str | None = None   # e.g. "Flagged"; None = don't copy
    # Day-scan mode prints <failed_url_base>/<call id> for each flagged recording.
    # Single-call mode (what CallRunner uses) builds the URL from the handoff's
    # appUrl instead, so this only matters if you run the legacy day-scan; set it
    # in config.json for that. No environment hardcoded here.
    failed_url_base: str = ""

    # --- conversation API (drop web calls from the report) -------------------
    # Only an actual phone call carries a caller number (metadata.participant.ani);
    # web conversations don't. When filter_web_calls is on, each flagged recording
    # is looked up via the API and excluded from the report if it has no caller.
    # Credentials and endpoints come from the environment / CallRunner handoff —
    # never hardcoded here (this file is committed). See run_single_call + main:
    # email/password via ZILLA_EMAIL/ZILLA_PASSWORD (or ZIILA_API_*), base + agent
    # from tmp/last-call.json or ZILLA_AGENT_ID / VITE_API_BASE_URL.
    filter_web_calls: bool = True
    api_base_url: str = ""
    api_email: str = ""
    api_password: str = ""

    # --- auto-download today's recordings ------------------------------------
    # When download_today is on, the tool logs in, lists this agent's
    # conversations created today (UTC), skips web calls, and downloads each
    # phone-call recording into recordings_dir before analysis. Existing files
    # are kept (no re-download). Use --no-download / download_today=false to run
    # purely offline on whatever WAVs already sit in recordings_dir.
    download_today: bool = True
    agent_id: str = ""
    page_size: int = 50


def load_config(path: Path) -> Config:
    """Build a Config from a JSON file, falling back to dataclass defaults.

    Unknown keys are ignored (with a warning) so the JSON can carry comments
    or extra notes without breaking the run.
    """
    cfg = Config()
    if not path.is_file():
        print(f"note: config file {path} not found; using built-in defaults",
              file=sys.stderr)
        return cfg
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        print(f"error: could not parse {path}: {exc}", file=sys.stderr)
        raise SystemExit(2)

    known = {f.name for f in fields(Config)}
    for key, value in data.items():
        if key in known:
            setattr(cfg, key, value)
        else:
            print(f"warning: ignoring unknown config key '{key}' in {path}",
                  file=sys.stderr)
    return cfg


# --------------------------------------------------------------------------- #
# Core DSP helpers
# --------------------------------------------------------------------------- #
def read_stereo(path: Path) -> tuple[np.ndarray, int]:
    """Return (samples[n,2] float32 in [-1,1], sample_rate)."""
    with wave.open(str(path), "rb") as w:
        n_ch = w.getnchannels()
        sr = w.getframerate()
        sw = w.getsampwidth()
        n = w.getnframes()
        raw = w.readframes(n)

    if sw != 2:
        raise ValueError(f"{path.name}: expected 16-bit PCM, got sampwidth={sw}")
    data = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    if n_ch == 1:
        # mono: nothing to overlap, duplicate so downstream code is uniform
        data = np.stack([data, data], axis=1)
    else:
        data = data.reshape(-1, n_ch)[:, :2]
    return data, sr


def frame_signal(signal: np.ndarray, frame_len: int) -> np.ndarray:
    """Slice a 1-D signal into non-overlapping frames -> (n_frames, frame_len)."""
    n_frames = len(signal) // frame_len
    if n_frames == 0:
        return np.zeros((0, frame_len), dtype=np.float64)
    return signal[: n_frames * frame_len].reshape(n_frames, frame_len).astype(np.float64)


def frames_rms_dbfs(frames: np.ndarray) -> np.ndarray:
    """Per-frame RMS energy of a framed signal, in dBFS."""
    if frames.shape[0] == 0:
        return np.array([], dtype=np.float32)
    rms = np.sqrt(np.mean(frames ** 2, axis=1))
    return 20.0 * np.log10(rms + 1e-12)


def voiced_mask(frames: np.ndarray, sr: int, cfg: Config) -> np.ndarray:
    """Per-frame mask: True where a frame looks like voiced *human* speech.

    Combines a harmonicity + pitch test (rejects aperiodic noise like traffic /
    wind / crowd, and tonal noise pitched above a voice like a car horn) with a
    voice-band energy-ratio test (rejects low rumble and high hiss). This is
    what stops loud background noise from being counted as someone speaking.
    """
    n_frames, frame_len = frames.shape
    if n_frames == 0:
        return np.zeros(0, dtype=bool)

    # DC-remove each frame so any offset doesn't skew the spectrum / autocorr.
    f = frames - frames.mean(axis=1, keepdims=True)

    nfft = 1
    while nfft < 2 * frame_len:          # >= 2*frame_len avoids autocorr wraparound
        nfft *= 2
    spec = np.fft.rfft(f, n=nfft, axis=1)
    power = spec.real ** 2 + spec.imag ** 2          # |X(f)|^2 per bin

    # --- 1 & 2: harmonicity + pitch, via FFT-based autocorrelation ----------
    acf = np.fft.irfft(power, n=nfft, axis=1)[:, :frame_len]
    energy0 = acf[:, :1]                              # lag-0 == frame energy
    # Search a wide lag band: down to half the human-pitch period so tonal noise
    # *above* the voice range (e.g. a ~400-500 Hz horn) shows its true short
    # period here and gets rejected on pitch rather than sneaking in on a
    # harmonic that happens to land inside the human range.
    lag_lo = max(1, int(sr / (cfg.pitch_max_hz * 2.0)))
    lag_hi = min(frame_len - 1, int(sr / cfg.pitch_min_hz))
    if lag_hi <= lag_lo:
        # Frame too short to measure pitch -> don't suppress anything.
        return np.ones(n_frames, dtype=bool)
    band = acf[:, lag_lo:lag_hi + 1] / (energy0 + 1e-12)
    best = np.argmax(band, axis=1)
    harmonicity = band[np.arange(n_frames), best]
    pitch_hz = sr / (best + lag_lo)
    voiced = (harmonicity >= cfg.voicing_min) \
        & (pitch_hz >= cfg.pitch_min_hz) & (pitch_hz <= cfg.pitch_max_hz)

    # --- 3: voice-band energy ratio -----------------------------------------
    freqs = np.fft.rfftfreq(nfft, d=1.0 / sr)
    lo, hi = cfg.voice_band_hz
    in_band = (freqs >= lo) & (freqs <= hi)
    total = power.sum(axis=1) + 1e-12
    band_ratio = power[:, in_band].sum(axis=1) / total
    voiced &= band_ratio >= cfg.voice_band_min_ratio

    return voiced


def vad(energy_db: np.ndarray, cfg: Config, hangover_frames: int,
        min_speech_frames: int, voiced: np.ndarray | None = None) -> np.ndarray:
    """Boolean speech mask for one channel from its per-frame energy.

    A frame must be both `margin_db` above the adaptive noise floor and louder
    than `min_speech_dbfs`; runs shorter than `min_speech_frames` are dropped so
    faint blips / clicks don't count as speech. If `voiced` is given, each
    resulting speech region must additionally be mostly voiced speech (see
    `_drop_unvoiced_runs`) or it is discarded as background noise.
    """
    if energy_db.size == 0:
        return np.zeros(0, dtype=bool)
    noise = np.percentile(energy_db, cfg.noise_floor_percentile)
    threshold = max(noise + cfg.margin_db, cfg.min_speech_dbfs)
    active = energy_db > threshold
    active = _apply_hangover(active, hangover_frames)
    active = _drop_short_runs(active, min_speech_frames)
    if voiced is not None:
        active = _drop_unvoiced_runs(active, voiced, cfg.min_voiced_ratio)
    return active


def _drop_unvoiced_runs(active: np.ndarray, voiced: np.ndarray,
                        min_ratio: float) -> np.ndarray:
    """Zero out whole speech runs whose voiced-frame share is below `min_ratio`.

    Genuine speech is mostly voiced; a passing car, horn, wind or crowd noise is
    loud enough to trip the energy VAD but carries little/no voiced content, so
    its region falls below the ratio and is dropped entirely.
    """
    if active.size == 0:
        return active
    out = active.copy()
    start = None
    for i, a in enumerate(active):
        if a and start is None:
            start = i
        elif not a and start is not None:
            if voiced[start:i].mean() < min_ratio:
                out[start:i] = False
            start = None
    if start is not None and voiced[start:].mean() < min_ratio:
        out[start:] = False
    return out


def _drop_short_runs(active: np.ndarray, min_run: int) -> np.ndarray:
    """Zero out contiguous True runs shorter than `min_run` frames."""
    if min_run <= 1 or active.size == 0:
        return active
    out = active.copy()
    start = None
    for i, a in enumerate(active):
        if a and start is None:
            start = i
        elif not a and start is not None:
            if i - start < min_run:
                out[start:i] = False
            start = None
    if start is not None and len(active) - start < min_run:
        out[start:] = False
    return out


def _apply_hangover(active: np.ndarray, hangover: int) -> np.ndarray:
    """Fill silence gaps shorter than `hangover` frames between active runs."""
    if hangover <= 0 or active.size == 0:
        return active
    out = active.copy()
    gap = 0
    last_active = -1
    for i, a in enumerate(active):
        if a:
            if 0 <= last_active and gap <= hangover:
                out[last_active + 1 : i] = True
            last_active = i
            gap = 0
        else:
            gap += 1
    return out


def find_segments(mask: np.ndarray, merge_gap_frames: int) -> list[tuple[int, int]]:
    """Return [start_frame, end_frame) runs of True, merging small gaps."""
    if mask.size == 0:
        return []
    idx = np.flatnonzero(mask)
    if idx.size == 0:
        return []
    segments = []
    start = prev = idx[0]
    for i in idx[1:]:
        if i - prev - 1 > merge_gap_frames:
            segments.append((start, prev + 1))
            start = i
        prev = i
    segments.append((start, prev + 1))
    return segments


# --------------------------------------------------------------------------- #
# Per-file analysis
# --------------------------------------------------------------------------- #
@dataclass
class Result:
    file: str
    duration_s: float
    is_bug: bool
    # "high" = overlap survives the voiced-speech gate (both sides clearly
    # talking). "low" = energy VAD sees the overlap but the voiced gate doesn't
    # -- likely real but noisy enough to deserve a human listen. "" = not a bug.
    confidence: str
    longest_overlap_s: float
    total_overlap_s: float
    overlap_segment_count: int
    longest_overlap_start_s: float
    error: str = ""
    # Phone number from the conversation API; "" means web call or not looked up.
    phone_number: str = ""
    # Per-exchange breakdown (needs the transcript; 0 if unavailable). An
    # "exchange" is one customer turn + the agent's reply to it.
    exchange_count: int = 0
    failed_high: int = 0          # barge-in led to a confirmed (voiced) talk-over
    failed_low: int = 0           # barge-in led to an energy-only talk-over
    interruptions_handled: int = 0  # customer barged in, agent yielded (no talk-over)


@dataclass
class _OverlapStats:
    """Overlap geometry for one pair of speech masks."""
    longest_frames: int
    longest_s: float
    total_s: float
    count: int
    start_s: float
    segments_s: list  # [(start_s, end_s), ...] of each merged overlap segment


def _overlap_stats(human_active: np.ndarray, ai_active: np.ndarray,
                   merge_gap_frames: int, frame_s: float) -> _OverlapStats:
    overlap = human_active & ai_active
    segments = find_segments(overlap, merge_gap_frames)
    seg_lengths = [(e - s) for s, e in segments]
    longest_frames = max(seg_lengths, default=0)
    longest_idx = int(np.argmax(seg_lengths)) if seg_lengths else -1
    total_frames = int(sum(seg_lengths))
    start_s = segments[longest_idx][0] * frame_s if longest_idx >= 0 else 0.0
    return _OverlapStats(
        longest_frames=longest_frames,
        longest_s=round(longest_frames * frame_s, 2),
        total_s=round(total_frames * frame_s, 2),
        count=len(segments),
        start_s=round(start_s, 2),
        segments_s=[(s * frame_s, e * frame_s) for s, e in segments],
    )


def build_exchanges(transcript: list) -> list[tuple[float, float, bool]]:
    """Split a transcript into back-and-forths -> [(start_s, end_s, barged_in)].

    An exchange is one customer turn plus the agent reply that follows it; a new
    exchange begins each time the customer takes the floor. The agent's opening
    greeting (before the first customer turn) forms its own opening exchange.
    `barged_in` is True if any turn in the exchange is flagged is_interrupted --
    i.e. the customer cut in while the agent was still speaking.
    """
    turns = [t for t in (transcript or [])
             if t.get("start") is not None and t.get("end") is not None]
    turns.sort(key=lambda t: t["start"])
    exchanges: list[list] = []
    prev_speaker = None
    for t in turns:
        speaker = t.get("speaker")
        barged = bool(t.get("is_interrupted"))
        starts_new = (not exchanges) or (speaker == "customer" and prev_speaker != "customer")
        if starts_new:
            exchanges.append([float(t["start"]), float(t["end"]), barged])
        else:
            exchanges[-1][1] = max(exchanges[-1][1], float(t["end"]))
            exchanges[-1][2] = exchanges[-1][2] or barged
        prev_speaker = speaker
    return [(s, e, a) for s, e, a in exchanges]


def _assign_to_exchange(seg: tuple[float, float],
                        windows: list[tuple[float, float]]) -> int:
    """Index of the exchange a talk-over belongs to (max time overlap, else nearest)."""
    s, e = seg
    best, best_ov = -1, 0.0
    for i, (xs, xe) in enumerate(windows):
        ov = min(e, xe) - max(s, xs)
        if ov > best_ov:
            best, best_ov = i, ov
    if best >= 0:
        return best
    if not windows:
        return -1
    mid = (s + e) / 2.0
    return min(range(len(windows)),
               key=lambda i: abs((windows[i][0] + windows[i][1]) / 2.0 - mid))


def classify_exchanges(exchanges: list[tuple[float, float, bool]],
                       voiced_segments: list, energy_segments: list,
                       min_len_s: float) -> tuple[int, int, int]:
    """Classify each exchange -> (failed_high, failed_low, handled).

    A sustained (>= min_len_s) talk-over makes the exchange a FAILURE -- "high"
    if voiced-confirmed, "low" if energy-only. An exchange where the customer
    barged in (is_interrupted) but no sustained talk-over followed is a HANDLED
    interruption (the agent yielded). Everything else is clean turn-taking.
    Brief overlaps don't count as failures -- that's normal turn-taking.
    """
    if not exchanges:
        return 0, 0, 0
    windows = [(s, e) for s, e, _ in exchanges]
    status = ["clean"] * len(exchanges)
    for s, e in voiced_segments:
        if e - s >= min_len_s:
            i = _assign_to_exchange((s, e), windows)
            if i >= 0:
                status[i] = "high"
    for s, e in energy_segments:
        if e - s >= min_len_s:
            i = _assign_to_exchange((s, e), windows)
            if i >= 0 and status[i] == "clean":
                status[i] = "low"
    failed_high = status.count("high")
    failed_low = status.count("low")
    handled = sum(1 for (_, _, barged), st in zip(exchanges, status)
                  if barged and st == "clean")
    return failed_high, failed_low, handled


def analyze(path: Path, cfg: Config, transcript: list | None = None) -> Result:
    try:
        samples, sr = read_stereo(path)
    except Exception as exc:  # noqa: BLE001 - report, don't crash the batch
        return Result(path.name, 0.0, False, "", 0.0, 0.0, 0, 0.0, error=str(exc))

    frame_len = max(1, int(sr * cfg.frame_ms / 1000.0))
    frame_s = frame_len / sr
    duration_s = len(samples) / sr

    hangover_frames = int(cfg.speech_hangover_ms / cfg.frame_ms)
    merge_gap_frames = int(cfg.overlap_merge_gap_ms / cfg.frame_ms)
    min_speech_frames = int(cfg.min_speech_ms / cfg.frame_ms)
    min_overlap_frames = cfg.interruption_seconds / frame_s

    human_frames = frame_signal(samples[:, cfg.human_channel], frame_len)
    ai_frames = frame_signal(samples[:, cfg.ai_channel], frame_len)
    human = frames_rms_dbfs(human_frames)
    ai = frames_rms_dbfs(ai_frames)
    n = min(len(human), len(ai))

    # Energy-only overlap (loud-vs-loud). This is the broad net.
    energy_stats = _overlap_stats(
        vad(human[:n], cfg, hangover_frames, min_speech_frames),
        vad(ai[:n], cfg, hangover_frames, min_speech_frames),
        merge_gap_frames, frame_s)

    # Voiced-gated overlap (both sides clearly *speaking*). This is the strict net.
    if cfg.require_voiced:
        human_voiced = voiced_mask(human_frames, sr, cfg)[:n]
        ai_voiced = voiced_mask(ai_frames, sr, cfg)[:n]
        voiced_stats = _overlap_stats(
            vad(human[:n], cfg, hangover_frames, min_speech_frames, human_voiced),
            vad(ai[:n], cfg, hangover_frames, min_speech_frames, ai_voiced),
            merge_gap_frames, frame_s)
    else:
        voiced_stats = energy_stats  # no gate -> no high/low distinction

    high = voiced_stats.longest_frames >= min_overlap_frames
    low = (not high) and energy_stats.longest_frames >= min_overlap_frames

    # Report the stats from whichever net classified it (voiced for high,
    # energy for low) so the timestamp points at the relevant overlap.
    confidence = "high" if high else "low" if low else ""
    stats = voiced_stats if high else energy_stats

    # Per-exchange breakdown, if we have the transcript to define the turns.
    exchanges = build_exchanges(transcript) if transcript else []
    ex_high, ex_low, ex_handled = classify_exchanges(
        exchanges, voiced_stats.segments_s, energy_stats.segments_s,
        cfg.interruption_seconds)

    return Result(
        file=path.name,
        duration_s=round(duration_s, 2),
        is_bug=high or low,
        confidence=confidence,
        longest_overlap_s=stats.longest_s,
        total_overlap_s=stats.total_s,
        overlap_segment_count=stats.count,
        longest_overlap_start_s=stats.start_s,
        exchange_count=len(exchanges),
        failed_high=ex_high,
        failed_low=ex_low,
        interruptions_handled=ex_handled,
    )


# --------------------------------------------------------------------------- #
# Conversation API (to drop web calls from the report)
# --------------------------------------------------------------------------- #
def _post_json(url: str, payload: dict, headers: dict | None = None,
               timeout: float = 30.0) -> dict:
    data = json.dumps(payload).encode("utf-8")
    h = {"Content-Type": "application/json", "Accept": "application/json"}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, data=data, headers=h, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _get_json(url: str, headers: dict | None = None, timeout: float = 30.0) -> dict:
    h = {"Accept": "application/json"}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, headers=h, method="GET")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def fetch_token(cfg: Config) -> str:
    """Log in and return the bearer token."""
    url = cfg.api_base_url.rstrip("/") + "/api/auth/login"
    resp = _post_json(url, {"email": cfg.api_email, "password": cfg.api_password})
    return resp["token"]


def fetch_conversation(cfg: Config, token: str, call_id: str) -> dict:
    """Fetch the full conversation record (includes transcript and metadata)."""
    url = cfg.api_base_url.rstrip("/") + f"/api/conversations/{call_id}"
    return _get_json(url, headers={"Authorization": f"Bearer {token}"})


def fetch_latest_call(cfg: Config, token: str, agent_id: str) -> dict | None:
    """Newest conversation row for an agent (list is sorted newest-first)."""
    base = cfg.api_base_url.rstrip("/")
    url = (f"{base}/api/conversations?agentIds%5B%5D={agent_id}"
           f"&pageIndex=0&pageSize=1")
    resp = _get_json(url, headers={"Authorization": f"Bearer {token}"})
    rows = resp.get("data") or []
    return rows[0] if rows else None


def _parse_iso(ts: str | None) -> datetime | None:
    """ISO-8601 -> aware datetime (UTC assumed when no tz); None if unparseable."""
    try:
        parsed = datetime.fromisoformat((ts or "").replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def ani_phone(info: dict) -> str | None:
    """Caller's phone number from a conversation, or None for a web call.

    The top-level `phoneNumber` field is always null and can't be used. A real
    phone call instead carries the caller in `metadata.participant.ani` as a
    "tel:+966..." URI; web conversations have no `participant` block at all
    (they show `metadata.sessionMode`), so absence of `ani` means web.
    """
    participant = (info.get("metadata") or {}).get("participant") or {}
    ani = participant.get("ani")
    if not ani:
        return None
    return ani[len("tel:"):] if ani.startswith("tel:") else ani


def list_todays_conversations(cfg: Config, token: str, agent_id: str, day: str):
    """Yield conversation summaries created on `day` (YYYY-MM-DD, UTC).

    The list endpoint is sorted newest-first, so we page until a row's date
    falls before `day` (we've passed today) or there are no more pages.
    """
    base = cfg.api_base_url.rstrip("/")
    page = 0
    while True:
        url = (f"{base}/api/conversations?agentIds%5B%5D={agent_id}"
               f"&pageIndex={page}&pageSize={cfg.page_size}")
        resp = _get_json(url, headers={"Authorization": f"Bearer {token}"})
        rows = resp.get("data") or []
        if not rows:
            return
        for row in rows:
            created = (row.get("createdAt") or "")[:10]
            if created == day:
                yield row
            elif created < day:
                return  # newest-first: everything past here is older than today
        if not (resp.get("pageInfo") or {}).get("hasNextPage"):
            return
        page += 1


def download_recording(url: str, token: str, dest: Path, timeout: float = 120.0) -> None:
    """Stream a recording WAV to `dest` (Authorization: Bearer <token>)."""
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=timeout) as resp, dest.open("wb") as fh:
        shutil.copyfileobj(resp, fh)


def _meta_path(rec_dir: Path, call_id: str) -> Path:
    """Sidecar JSON path that caches a call's phone + transcript next to its WAV."""
    return rec_dir / f"{call_id}.json"


def _read_cached_meta(path: Path) -> dict | None:
    """Load a cached metadata sidecar, or None if missing/corrupt."""
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


def fetch_todays_calls(cfg: Config, token: str, day: str,
                       rec_dir: Path) -> tuple[list[tuple[Path, str, list]], int]:
    """Download `day`'s phone-call recordings into rec_dir (incrementally).

    Skips web calls (no caller `ani`). Returns (mobile, excluded_web) where
    `mobile` is [(path, phone_number, transcript), ...] ready for analysis --
    same shape select_mobile_calls returns, so no second API pass is needed.

    To save data across repeated runs, each looked-up call's phone + transcript
    is cached in a `<call id>.json` sidecar next to its WAV. On a later run a
    call that already has a cached sidecar needs ZERO network calls: no
    conversation lookup and no re-download. Only genuinely new calls hit the API.
    """
    rec_dir.mkdir(parents=True, exist_ok=True)
    mobile: list[tuple[Path, str, list]] = []
    excluded = 0
    reused = 0
    for row in list_todays_conversations(cfg, token, cfg.agent_id, day):
        call_id = row["id"]
        dest = rec_dir / f"{call_id}.wav"
        meta_path = _meta_path(rec_dir, call_id)

        # Fast path: we've already resolved this call on a previous run.
        cached = _read_cached_meta(meta_path)
        if cached is not None:
            phone = cached.get("phone")
            if not phone:
                excluded += 1          # known web call -- stays excluded, no API hit
                continue
            if dest.exists():
                reused += 1
                mobile.append((dest, str(phone), cached.get("transcript") or []))
                continue
            # Cached as a phone call but the WAV went missing -- fall through to
            # re-fetch so we can download it again.

        try:
            info = fetch_conversation(cfg, token, call_id)
        except Exception as exc:  # noqa: BLE001
            print(f"warning: lookup failed for {call_id} ({exc}); skipping",
                  file=sys.stderr)
            continue
        phone = ani_phone(info)
        transcript = info.get("transcription") or []
        # Cache the metadata so future runs skip this lookup entirely (web calls
        # are cached with phone=null so they stay excluded for free).
        try:
            meta_path.write_text(
                json.dumps({"phone": phone, "transcript": transcript}),
                encoding="utf-8")
        except OSError as exc:
            print(f"warning: could not cache metadata for {call_id} ({exc})",
                  file=sys.stderr)
        if not phone:
            excluded += 1
            continue
        if not dest.exists():
            rec_url = info.get("recording_url")
            if not rec_url:
                print(f"warning: no recording_url for {call_id}; skipping",
                      file=sys.stderr)
                continue
            try:
                download_recording(rec_url, token, dest)
            except Exception as exc:  # noqa: BLE001
                print(f"warning: download failed for {call_id} ({exc}); skipping",
                      file=sys.stderr)
                dest.unlink(missing_ok=True)
                continue
        mobile.append((dest, str(phone), transcript))
    if reused:
        print(f"  reused {reused} already-downloaded recording(s); "
              f"only new calls were fetched.")
    return mobile, excluded


def select_mobile_calls(files: list[Path],
                        cfg: Config) -> tuple[list[tuple[Path, str, list]], int]:
    """Look up every recording up front and keep only mobile (phone) calls.

    Returns (mobile, excluded_web) where `mobile` is a list of
    (path, phone_number, transcript) and `excluded_web` is how many web
    conversations were dropped. We do this before any audio analysis so web
    calls are never scored and don't enter the totals. On an auth failure the
    filter is skipped (every file is kept) so the tool still runs.
    """
    try:
        token = fetch_token(cfg)
    except Exception as exc:  # noqa: BLE001
        print(f"warning: could not authenticate to {cfg.api_base_url} ({exc}); "
              f"skipping web-call filter -- analyzing all recordings", file=sys.stderr)
        return [(f, "", []) for f in files], 0

    mobile: list[tuple[Path, str, list]] = []
    excluded = 0
    for f in files:
        try:
            info = fetch_conversation(cfg, token, f.stem)
        except Exception as exc:  # noqa: BLE001
            print(f"warning: lookup failed for {f.stem} ({exc}); keeping it",
                  file=sys.stderr)
            mobile.append((f, "", []))
            continue
        phone = ani_phone(info)
        if phone:
            mobile.append((f, str(phone), info.get("transcription") or []))
        else:
            excluded += 1
    return mobile, excluded


# --------------------------------------------------------------------------- #
# CLI / batch
# --------------------------------------------------------------------------- #
def fmt_ts(seconds: float) -> str:
    m, s = divmod(int(seconds), 60)
    return f"{m:d}:{s:02d}"


def _normalize_api_base(base: str) -> str:
    """Match the classifier's convention: base WITHOUT a trailing /api (it adds it).

    The frontend's VITE_API_BASE_URL includes /api (…/api); strip it so
    api_base_url + '/api/...' doesn't double up.
    """
    base = (base or "").rstrip("/")
    if base.endswith("/api"):
        base = base[: -len("/api")]
    return base


def run_single_call(cfg: Config, args) -> int:
    """Analyze exactly one call (the one CallRunner just placed) for interruption
    failures. Reports independently of the "zilla replied" signal.

    Resolves the call id (explicit --call-id, else the agent's latest), polls up to
    --wait-recording-seconds for the recording to be ready, downloads + analyzes it,
    prints INTERRUPTION_RESULT=PASS|FAIL|ERROR, and (with --fail-on-interruption)
    exits non-zero if any exchange had a sustained talk-over. ERROR means the
    recording could not be obtained/analyzed (infra), NOT a talk-over verdict.

    Exit codes: 0 = pass (or report-only), 1 = interruption failure, 3 = could not
    obtain/analyze the recording (infrastructure, not an interruption verdict).
    """
    try:
        token = fetch_token(cfg)
    except Exception as exc:  # noqa: BLE001
        # Infra error (can't reach/authenticate), NOT an interruption verdict.
        print(f"INTERRUPTION_RESULT=ERROR (login failed: {exc})")
        return 3

    # Reject conversations created before the CallRunner call started (with slack
    # for clock skew): right after hangup, "latest" may still be the PREVIOUS
    # call — which already has a recording and would be analyzed silently.
    min_created = None
    started = _parse_iso(args.call_started_at)
    if started:
        min_created = started - timedelta(seconds=60)

    deadline = time.monotonic() + args.wait_recording_seconds
    call_id = None
    info = None
    last_error = ""
    while True:
        cid = args.call_id
        if not cid:
            row = fetch_latest_call(cfg, token, cfg.agent_id)
            if row:
                created = _parse_iso(row.get("createdAt"))
                if min_created and created and created < min_created:
                    last_error = (f"latest call {row['id']} predates this run "
                                  f"(createdAt {row.get('createdAt')})")
                else:
                    cid = row["id"]
        if cid:
            try:
                info = fetch_conversation(cfg, token, cid)
            except Exception as exc:  # noqa: BLE001
                info = None
                last_error = f"lookup failed for {cid}: {exc}"
            if info and info.get("recording_url"):
                call_id = cid
                break
        if time.monotonic() >= deadline:
            call_id = cid
            break
        time.sleep(2)

    detail = f" ({last_error})" if last_error else ""
    if not call_id:
        print(f"INTERRUPTION_RESULT=ERROR (no call found for agent{detail})")
        return 3
    if not info or not info.get("recording_url"):
        print(f"INTERRUPTION_RESULT=ERROR (recording not ready within "
              f"{args.wait_recording_seconds}s for {call_id}{detail})")
        return 3

    rec_dir = Path(cfg.recordings_dir)
    rec_dir.mkdir(parents=True, exist_ok=True)
    dest = rec_dir / f"{call_id}.wav"
    try:
        download_recording(info["recording_url"], token, dest)
    except Exception as exc:  # noqa: BLE001
        print(f"INTERRUPTION_RESULT=ERROR (download failed for {call_id}: {exc})")
        return 3

    r = analyze(dest, cfg, info.get("transcription") or [])
    if r.error:
        print(f"INTERRUPTION_RESULT=ERROR (analyze error: {r.error})")
        return 3

    failed = r.failed_high + r.failed_low
    attempted = failed + r.interruptions_handled
    print(f"call {call_id}  (duration {r.duration_s:.1f}s)")
    print(f"  interruptions: attempted={attempted} handled={r.interruptions_handled} "
          f"failed={failed} (high {r.failed_high} / low {r.failed_low})")
    if r.longest_overlap_s > 0:
        print(f"  longest talk-over {r.longest_overlap_s:.2f}s @ "
              f"{fmt_ts(r.longest_overlap_start_s)}")
    if args.app_url:
        print(f"  {args.app_url.rstrip('/')}/en/agents/{cfg.agent_id}/conversations/{call_id}")
    ok = failed == 0
    print(f"INTERRUPTION_RESULT={'PASS' if ok else f'FAIL ({failed} failed interruption(s))'}")
    if args.fail_on_interruption and not ok:
        return 1
    return 0


def resolve_days(args) -> list[str]:
    """Resolve which UTC days to scan, as sorted YYYY-MM-DD strings.

    Precedence: explicit --date  >  --since (through --until)  >  --days N  >
    default (today only).
    """
    if args.date:
        return sorted(set(args.date))
    today = datetime.now(timezone.utc).date()
    if args.since:
        start = datetime.strptime(args.since, "%Y-%m-%d").date()
        end = datetime.strptime(args.until, "%Y-%m-%d").date() if args.until else today
        out, d = [], start
        while d <= end:
            out.append(d.isoformat())
            d += timedelta(days=1)
        return out
    n = max(1, args.days or 1)
    return sorted((today - timedelta(days=i)).isoformat() for i in range(n))


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("-c", "--config", default=str(DEFAULT_CONFIG_PATH),
                   help="path to config.json")
    # CLI flags default to None: they only override the JSON when explicitly set.
    p.add_argument("-d", "--dir", default=None, help="folder of WAV recordings")
    p.add_argument("-t", "--interruption-seconds", type=float, default=None,
                   help="min continuous overlap (s) to flag as a bug")
    p.add_argument("--margin-db", type=float, default=None,
                   help="dB above noise floor to count a frame as speech")
    p.add_argument("-o", "--report", default=None, help="output CSV path")
    p.add_argument("--copy-flagged-to", default=None,
                   help="copy flagged recordings into this folder")
    p.add_argument("--no-web-filter", action="store_true",
                   help="skip the API lookup that drops web calls (offline mode)")
    p.add_argument("--no-download", action="store_true",
                   help="don't auto-download recordings; analyze existing WAVs in --dir")
    # --- which calls to scan (interruption-quality mode) ---------------------
    p.add_argument("--days", type=int, default=None,
                   help="scan the last N days, UTC (e.g. --days 7)")
    p.add_argument("--since", default=None,
                   help="scan from this start date YYYY-MM-DD (through --until, default today)")
    p.add_argument("--until", default=None,
                   help="end date for --since (YYYY-MM-DD, UTC; default: today)")
    p.add_argument("--date", nargs="+", default=None,
                   help="explicit day list YYYY-MM-DD ... (overrides --days/--since); default: today")
    p.add_argument("--max-fail-rate", type=float, default=None,
                   help="exit non-zero if the interruption FAILURE rate (%%) exceeds this")
    # --- single-call mode (CallRunner integration) ---------------------------
    p.add_argument("--handoff", default=None,
                   help="path to CallRunner's last-call.json (sets agent id + API base)")
    p.add_argument("--call-id", default=None,
                   help="analyze exactly this conversation id")
    p.add_argument("--latest", action="store_true",
                   help="analyze the newest call for the agent (single-call mode)")
    p.add_argument("--wait-recording-seconds", type=float, default=20.0,
                   help="poll up to N seconds for the recording to be ready")
    p.add_argument("--fail-on-interruption", action="store_true",
                   help="exit non-zero if any exchange had a sustained talk-over")
    args = p.parse_args(argv)

    cfg = load_config(Path(args.config))

    # Handoff from CallRunner: agent + API base + start time of the call we placed.
    args.call_started_at = None
    args.app_url = None
    if args.handoff:
        handoff = json.loads(Path(args.handoff).read_text(encoding="utf-8"))
        if handoff.get("agentId"):
            cfg.agent_id = handoff["agentId"]
        if handoff.get("apiBase"):
            cfg.api_base_url = _normalize_api_base(handoff["apiBase"])
        args.call_started_at = handoff.get("callStartedAt")
        args.app_url = handoff.get("appUrl")
    # Endpoints + agent: env wins over handoff/config. Accept both this repo's
    # names (VITE_API_BASE_URL / ZILLA_AGENT_ID) and the classifier's own
    # (ZIILA_API_*), so one .env feeds both e2e.ts and this script.
    base_env = os.environ.get("ZIILA_API_BASE_URL") or os.environ.get("VITE_API_BASE_URL")
    if base_env:
        cfg.api_base_url = _normalize_api_base(base_env)
    cfg.agent_id = (os.environ.get("ZIILA_AGENT_ID")
                    or os.environ.get("ZILLA_AGENT_ID") or cfg.agent_id)
    # Credentials: env only (nothing hardcoded). Same account as the E2E login.
    cfg.api_email = (os.environ.get("ZIILA_API_EMAIL")
                     or os.environ.get("ZILLA_EMAIL") or cfg.api_email)
    cfg.api_password = (os.environ.get("ZIILA_API_PASSWORD")
                        or os.environ.get("ZILLA_PASSWORD") or cfg.api_password)

    if args.no_web_filter:
        cfg.filter_web_calls = False
    if args.no_download:
        cfg.download_today = False
    # CLI overrides — applied BEFORE the single-call branch so -d / -t work there.
    if args.dir is not None:
        cfg.recordings_dir = args.dir
    if args.interruption_seconds is not None:
        cfg.interruption_seconds = args.interruption_seconds
    if args.margin_db is not None:
        cfg.margin_db = args.margin_db
    if args.report is not None:
        cfg.report_csv = args.report
    if args.copy_flagged_to is not None:
        cfg.copy_flagged_to = args.copy_flagged_to

    # Single-call mode (CallRunner integration): analyze just the call we placed
    # and report interruption handling as an independent signal.
    if args.latest or args.call_id or args.handoff:
        return run_single_call(cfg, args)

    rec_dir = Path(cfg.recordings_dir)
    excluded_web = 0

    if cfg.filter_web_calls and cfg.download_today:
        # Auto-download today's phone-call recordings, then analyze them. The
        # download already skips web calls and carries each call's phone +
        # transcript, so no second lookup pass is needed.
        days = resolve_days(args)
        print(f"Interruption-quality scan over {len(days)} day(s): {', '.join(days)} "
              f"(agent {cfg.agent_id}, threshold {cfg.interruption_seconds:g}s) into {rec_dir}...")
        try:
            token = fetch_token(cfg)
        except Exception as exc:  # noqa: BLE001
            print(f"error: could not authenticate to {cfg.api_base_url} ({exc})",
                  file=sys.stderr)
            return 2
        mobile, excluded_web = [], 0
        for day in days:
            day_mobile, day_excluded = fetch_todays_calls(cfg, token, day, rec_dir)
            mobile.extend(day_mobile)
            excluded_web += day_excluded
        if not mobile:
            print(f"No mobile calls for {', '.join(days)} "
                  f"({excluded_web} web call(s) excluded).")
            return 0
    else:
        if not rec_dir.is_dir():
            print(f"error: recordings dir not found: {rec_dir}", file=sys.stderr)
            return 2
        files = sorted(rec_dir.glob("*.wav"))
        if not files:
            print(f"no .wav files in {rec_dir}", file=sys.stderr)
            return 1
        # Keep only mobile (phone) calls -- web calls are dropped before any
        # audio analysis so they never enter the report or the rate totals.
        if cfg.filter_web_calls:
            print(f"Looking up {len(files)} recording(s) to keep only mobile calls...")
            mobile, excluded_web = select_mobile_calls(files, cfg)
        else:
            mobile = [(f, "", []) for f in files]

    if not mobile:
        print(f"No mobile calls to analyze ({excluded_web} web call(s) excluded).")
        return 0

    print(f"Scanning {len(mobile)} mobile call(s) in {rec_dir} "
          f"(threshold = {cfg.interruption_seconds:g}s continuous overlap)\n")

    results = []
    for f, phone, transcript in mobile:
        r = analyze(f, cfg, transcript)
        r.phone_number = phone
        results.append(r)

    high = [r for r in results if r.confidence == "high"]
    low = [r for r in results if r.confidence == "low"]
    errors = [r for r in results if r.error]
    flagged = high + low

    # console report
    width = max(len(r.file) for r in results)
    marks = {"high": "BUG! ", "low": "bug? ", "": "ok   "}
    for r in results:
        if r.error:
            print(f"  !     {r.file:<{width}}  ERROR: {r.error}")
            continue
        detail = ""
        if r.longest_overlap_s > 0:
            detail = (f"longest overlap {r.longest_overlap_s:>5.2f}s @ "
                      f"{fmt_ts(r.longest_overlap_start_s)}  "
                      f"(total {r.total_overlap_s:.2f}s over {r.overlap_segment_count} seg)")
        print(f"  {marks[r.confidence]} {r.file:<{width}}  {detail}")

    # --- summary & rates (denominator = mobile calls) ------------------------
    n = len(results)
    nh, nl, ne = len(high), len(low), len(errors)
    clean = n - nh - nl - ne
    pct = lambda x: f"{100.0 * x / n:.1f}%" if n else "n/a"
    print("\n=== Summary ===")
    print(f"  Web calls excluded:         {excluded_web}")
    print(f"  Mobile calls analyzed:      {n}")
    print(f"    High-confidence (BUG!):   {nh:>4}  ({pct(nh)})")
    print(f"    Low-confidence  (bug?):   {nl:>4}  ({pct(nl)})")
    print(f"    Clean:                    {clean:>4}  ({pct(clean)})")
    if ne:
        print(f"    Errors:                   {ne:>4}")
    print(f"  Interruption rate (high+low): {nh + nl}/{n} = {pct(nh + nl)}  "
          f"(high-confidence only: {pct(nh)})")

    # --- exchange-level rates (per back-and-forth, needs transcripts) --------
    total_ex = sum(r.exchange_count for r in results)
    ex_high = sum(r.failed_high for r in results)
    ex_low = sum(r.failed_low for r in results)
    ex_fail = ex_high + ex_low
    handled = sum(r.interruptions_handled for r in results)
    attempts = ex_fail + handled
    fail_rate = (100.0 * ex_fail / attempts) if attempts else 0.0
    if total_ex:
        print(f"\n  Exchanges (back-and-forths) across mobile calls: {total_ex}")
        print(f"    Interruptions attempted (customer barged in): {attempts}")
        print(f"      Handled properly (agent yielded):  {handled:>4}")
        print(f"      Interruption FAILURES (talk-over): {ex_fail:>4}  "
              f"(high {ex_high} / low {ex_low})")
        if attempts:
            print(f"  Interruption failure rate: {ex_fail}/{attempts} = "
                  f"{100.0 * ex_fail / attempts:.1f}% of interruptions")

    # URLs for the failed cases: <base>/<call id> (call id = filename w/o .wav)
    if flagged:
        base = cfg.failed_url_base.rstrip("/")

        def print_urls(group: list[Result]) -> None:
            for r in group:
                phone = f" [{r.phone_number}]" if r.phone_number else ""
                failed = r.failed_high + r.failed_low
                exch = (f"  [{r.exchange_count} exchanges: {failed} failed, "
                        f"{r.interruptions_handled} handled]"
                        if r.exchange_count else "")
                print(f"  {base}/{Path(r.file).stem}{phone}"
                      f"   -> seek to {fmt_ts(r.longest_overlap_start_s)} "
                      f"({r.longest_overlap_s:.2f}s overlap){exch}")

        if high:
            print("\nHIGH-confidence bugs (both sides clearly talking over each other):")
            print_urls(high)
        if low:
            print("\nLOW-confidence bugs (overlap present but noisy -- please verify by ear):")
            print_urls(low)

    # CSV report
    out = Path(cfg.report_csv)
    with out.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=list(asdict(results[0]).keys()))
        w.writeheader()
        for r in results:
            w.writerow(asdict(r))
    print(f"Report written to {out}")

    # optional copy
    if cfg.copy_flagged_to and flagged:
        dest = Path(cfg.copy_flagged_to)
        dest.mkdir(parents=True, exist_ok=True)
        for r in flagged:
            shutil.copy2(rec_dir / r.file, dest / r.file)
        print(f"Copied {len(flagged)} flagged recording(s) to {dest}")

    # --- quality gate (optional): non-zero exit for CI/scheduled use ---------
    exit_code = 0
    if args.fail_on_interruption and ex_fail > 0:
        print(f"\nFAIL: {ex_fail} interruption failure(s) (--fail-on-interruption)")
        exit_code = 1
    if args.max_fail_rate is not None and fail_rate > args.max_fail_rate:
        print(f"\nFAIL: interruption failure rate {fail_rate:.1f}% exceeds "
              f"--max-fail-rate {args.max_fail_rate:g}%")
        exit_code = 1
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
