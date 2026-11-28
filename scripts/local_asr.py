# -*- coding: utf-8 -*-
"""本机显卡开源语音转写脚本（faster-whisper，免登录、零配额限制、自动适配 RTX GPU / CPU）。"""

import argparse
import glob
import json
import os
import re
import sys
import time
from pathlib import Path


def register_cuda_dll_dirs() -> list[str]:
    """自动发现本机已安装的 CUDA 12 / cuBLAS / cuDNN 动态库目录并注册到 DLL 搜索路径。"""
    if os.name != "nt":
        return []

    py_dir = Path(sys.executable).resolve().parent
    candidate_patterns = [
        str(py_dir / "Lib" / "site-packages" / "nvidia" / "*" / "bin"),
        str(py_dir / "Lib" / "site-packages" / "torch" / "lib"),
        str(py_dir / "Library" / "bin"),
        str(py_dir / "envs" / "*" / "Lib" / "site-packages" / "nvidia" / "*" / "bin"),
        str(py_dir / "envs" / "*" / "Lib" / "site-packages" / "torch" / "lib"),
        r"C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.*\bin",
        r"D:\km\*\Lib\site-packages\torch\lib",
        r"D:\km\*\Lib\site-packages\nvidia\*\bin",
    ]

    added: list[str] = []
    seen: set[str] = set()
    cur_path = os.environ.get("PATH", "")

    for pattern in candidate_patterns:
        for match in glob.glob(pattern):
            p = Path(match)
            if not p.is_dir():
                continue
            key = str(p).lower()
            if key in seen:
                continue
            # 仅挂载包含 cublas / cudnn / cudart 动态库的目录，避免污染 PATH
            has_cuda_dll = any(
                (p / name).exists()
                for name in (
                    "cublas64_12.dll",
                    "cublasLt64_12.dll",
                    "cudnn_ops64_9.dll",
                    "cudnn64_9.dll",
                    "cudnn64_8.dll",
                    "cudart64_12.dll",
                )
            )
            if not has_cuda_dll:
                continue
            seen.add(key)
            try:
                if hasattr(os, "add_dll_directory"):
                    os.add_dll_directory(str(p))
            except Exception:
                pass
            if key not in cur_path.lower():
                cur_path = f"{p};{cur_path}"
            added.append(str(p))

    if added:
        os.environ["PATH"] = cur_path
    return added


def format_paragraphs(segments_text: list[str]) -> str:
    """将口播分段文本按自然语义整理为干净、无时间轴、无复读幻觉、易复制的中文段落。"""
    cleaned = []
    prev_norm = ""
    repeat_run = 0
    for raw in segments_text:
        t = re.sub(r"\s+", " ", (raw or "").strip())
        if not t:
            continue
        # 过滤 Whisper 静音/配乐段偶发的提示词回显或连续相同句子复读
        if "准确识别专业名词并使用规范中文标点符号" in t or t in ("简体中文普通话。", "简体中文普通话"):
            continue
        norm = re.sub(r"[，。！？、；：,.!?;:\s]+", "", t)
        if not norm:
            continue
        if norm == prev_norm:
            repeat_run += 1
            if repeat_run >= 1:
                continue
        else:
            prev_norm = norm
            repeat_run = 0
        cleaned.append(t)

    if not cleaned:
        return ""

    paragraphs: list[str] = []
    buf = ""
    for seg in cleaned:
        # 英文单词间保留空格，中文直接自然衔接
        need_space = bool(buf and re.search(r"[A-Za-z0-9]$", buf) and re.match(r"^[A-Za-z0-9]", seg))
        if buf:
            # 若上一段没有标点且以中文结尾，用逗号或直接拼接保持通顺
            if not re.search(r"[，。！？、；：,.!?;:]$", buf) and not need_space:
                buf = f"{buf}，{seg}"
            else:
                buf = f"{buf} {seg}" if need_space else f"{buf}{seg}"
        else:
            buf = seg

        if len(buf) >= 200 and re.search(r"[。！？!?…]$", buf):
            paragraphs.append(buf)
            buf = ""

    if buf:
        paragraphs.append(buf)
    return "\n\n".join(paragraphs).strip()


def load_whisper_model(WhisperModel, model_name: str, device: str, compute_type: str):
    """优先使用本机已缓存的模型实现零网络延迟秒加载，未缓存时再联网拉取。"""
    try:
        return WhisperModel(model_name, device=device, compute_type=compute_type, local_files_only=True)
    except Exception:
        return WhisperModel(model_name, device=device, compute_type=compute_type)


def run_asr(audio_path: str, output_txt: str, model_name: str, language: str | None) -> dict:
    register_cuda_dll_dirs()

    import ctranslate2
    from faster_whisper import WhisperModel

    src = Path(audio_path)
    if not src.is_file():
        raise FileNotFoundError(f"音频文件不存在: {audio_path}")

    started = time.time()
    has_cuda = False
    try:
        has_cuda = ctranslate2.get_cuda_device_count() > 0
    except Exception:
        has_cuda = False

    def transcribe_with(chosen_model: str, device: str, compute_type: str):
        model = load_whisper_model(WhisperModel, chosen_model, device, compute_type)
        segments_iter, info = model.transcribe(
            str(src),
            language=language or None,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 500},
            beam_size=5,
            condition_on_previous_text=False,
            no_speech_threshold=0.6,
            initial_prompt="简体中文普通话。",
        )
        texts = [seg.text for seg in segments_iter]
        return texts, info

    device = "cuda" if has_cuda else "cpu"
    compute_type = "float16" if has_cuda else "int8"
    used_model = model_name

    # 将模型加载与真实推理都包在 CUDA 保护块中；任意显卡库异常自动平滑降级 CPU int8
    if has_cuda:
        try:
            texts, info = transcribe_with(used_model, device, compute_type)
        except Exception:
            device = "cpu"
            compute_type = "int8"
            used_model = "small" if model_name in ("large-v3", "medium") else model_name
            texts, info = transcribe_with(used_model, device, compute_type)
    else:
        texts, info = transcribe_with(used_model, device, compute_type)

    full_text = format_paragraphs(texts)

    out_path = Path(output_txt)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(full_text, encoding="utf-8")

    elapsed = round(time.time() - started, 2)
    return {
        "ok": True,
        "chars": len(full_text),
        "duration": round(float(getattr(info, "duration", 0.0) or 0.0), 1),
        "language": getattr(info, "language", language or "zh"),
        "device": device,
        "compute_type": compute_type,
        "model": used_model,
        "elapsed_sec": elapsed,
        "output_txt": str(out_path),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="本机显卡 faster-whisper 语音转口播文字")
    parser.add_argument("audio", help="输入音频路径")
    parser.add_argument("output_txt", help="输出纯文本路径")
    parser.add_argument("--model", default=os.environ.get("MMW_WHISPER_MODEL", "medium"), help="Whisper 模型规格")
    parser.add_argument("--lang", default="zh", help="语言代码，默认 zh")
    args = parser.parse_args()

    try:
        result = run_asr(args.audio, args.output_txt, args.model, args.lang)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
