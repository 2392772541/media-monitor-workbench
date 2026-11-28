import asyncio
from pathlib import Path
import re
import struct

from conf import BASE_DIR
from uploader.douyin_uploader.main import (
    DOUYIN_PUBLISH_STRATEGY_IMMEDIATE,
    DOUYIN_PUBLISH_STRATEGY_SCHEDULED,
    DouYinVideo,
)
from uploader.ks_uploader.main import (
    KUAISHOU_PUBLISH_STRATEGY_IMMEDIATE,
    KUAISHOU_PUBLISH_STRATEGY_SCHEDULED,
    KSVideo,
)
from uploader.tencent_uploader.main import TencentVideo
from uploader.xiaohongshu_uploader.main import (
    XIAOHONGSHU_PUBLISH_STRATEGY_IMMEDIATE,
    XIAOHONGSHU_PUBLISH_STRATEGY_SCHEDULED,
    XiaoHongShuVideo,
)
from utils.constant import TencentZoneTypes
from utils.files_times import generate_schedule_time_next_day


def _detect_image_dimensions(image_path: str) -> tuple[int, int] | None:
    """零依赖读取常见图片（PNG/JPEG/WEBP/BMP）宽高，用于自动区分横竖版封面。"""
    if not image_path:
        return None
    p = Path(image_path)
    if not p.is_file():
        return None
    try:
        with p.open("rb") as f:
            head = f.read(32)
            # PNG
            if len(head) >= 24 and head[:8] == b"\x89PNG\r\n\x1a\n":
                w, h = struct.unpack(">II", head[16:24])
                return int(w), int(h)
            # BMP
            if len(head) >= 26 and head[:2] == b"BM":
                w, h = struct.unpack("<ii", head[18:26])
                return abs(int(w)), abs(int(h))
            # JPEG
            if len(head) >= 2 and head[:2] == b"\xff\xd8":
                f.seek(2)
                while True:
                    marker_start = f.read(1)
                    if not marker_start:
                        break
                    if marker_start != b"\xff":
                        continue
                    marker = f.read(1)
                    while marker == b"\xff":
                        marker = f.read(1)
                    if not marker:
                        break
                    code = marker[0]
                    if code in (0xD8, 0xD9, 0x01) or (0xD0 <= code <= 0xD7):
                        continue
                    size_bytes = f.read(2)
                    if len(size_bytes) < 2:
                        break
                    seg_len = struct.unpack(">H", size_bytes)[0]
                    if code in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
                        sof = f.read(5)
                        if len(sof) == 5:
                            h, w = struct.unpack(">HH", sof[1:5])
                            return int(w), int(h)
                        break
                    f.seek(max(0, seg_len - 2), 1)
    except Exception:
        return None
    return None


def _resolve_confined_path(base_subdir: str, entry: str) -> Path:
    """将文件名安全约束在指定子目录内，阻止绝对路径与 ../ 越界访问。"""
    if not isinstance(entry, str) or not entry.strip():
        raise ValueError(f"无效的文件路径参数: {entry!r}")
    raw = entry.strip()
    candidate = Path(raw)
    if candidate.is_absolute():
        raise ValueError(f"不允许使用绝对路径: {entry!r}")
    root = (Path(BASE_DIR) / base_subdir).resolve()
    resolved = (root / candidate).resolve()
    if not resolved.is_relative_to(root) or resolved == root:
        raise ValueError(f"检测到越界路径: {entry!r}")
    return resolved


def _normalize_tags(raw_tags) -> list[str]:
    """防卫式清洗标签参数，兼容列表或逗号/空白分隔字符串。"""
    if raw_tags is None:
        return []
    items = []
    if isinstance(raw_tags, (list, tuple)):
        for elem in raw_tags:
            if isinstance(elem, str):
                items.extend(re.split(r"[,，\s]+", elem))
            elif elem is not None:
                items.append(str(elem))
    elif isinstance(raw_tags, str):
        items = re.split(r"[,，\s]+", raw_tags)
    else:
        raise ValueError("tags 必须为字符串列表或逗号分隔字符串")
    cleaned = []
    seen = set()
    for item in items:
        tag = str(item or "").strip().lstrip("#").strip()
        if not tag or tag in seen:
            continue
        seen.add(tag)
        cleaned.append(tag)
    return cleaned


def post_video_tencent(title,files,tags,account_file,category=TencentZoneTypes.LIFESTYLE.value,enableTimer=False,videos_per_day = 1, daily_times=None,start_days = 0, is_draft=False, desc='', schedule_datetimes=None):
    # 生成受限目录内的完整路径
    account_file = [_resolve_confined_path("cookiesFile", file) for file in account_file]
    files = [_resolve_confined_path("videoFile", file) for file in files]
    tags = _normalize_tags(tags)
    if enableTimer:
        if schedule_datetimes:
            publish_datetimes = list(schedule_datetimes)
        else:
            publish_datetimes = generate_schedule_time_next_day(
                len(files), videos_per_day or 1, daily_times or None, start_days=start_days or 0
            )
    else:
        publish_datetimes = [0 for i in range(len(files))]
    for index, file in enumerate(files):
        for cookie in account_file:
            print(f"文件路径{str(file)}")
            # 打印视频文件名、标题和 hashtag
            print(f"视频文件名：{file}")
            print(f"标题：{title}")
            print(f"Hashtag：{tags}")
            app = TencentVideo(title, str(file), tags, publish_datetimes[index], cookie, category, is_draft, desc=desc or "")
            asyncio.run(app.main(), debug=False)


def post_video_DouYin(title,files,tags,account_file,category=TencentZoneTypes.LIFESTYLE.value,enableTimer=False,videos_per_day = 1, daily_times=None,start_days = 0,
                      thumbnail_path = '',
                      productLink = '', productTitle = '', desc = '', schedule_datetimes=None):
    # 生成受限目录内的完整路径
    account_file = [_resolve_confined_path("cookiesFile", file) for file in account_file]
    files = [_resolve_confined_path("videoFile", file) for file in files]
    tags = _normalize_tags(tags)
    if enableTimer:
        if schedule_datetimes:
            publish_datetimes = list(schedule_datetimes)
        else:
            publish_datetimes = generate_schedule_time_next_day(
                len(files), videos_per_day or 1, daily_times or None, start_days=start_days or 0
            )
        publish_strategy = DOUYIN_PUBLISH_STRATEGY_SCHEDULED
    else:
        publish_datetimes = [0 for i in range(len(files))]
        publish_strategy = DOUYIN_PUBLISH_STRATEGY_IMMEDIATE

    # 根据封面图片实际宽高自动归类为竖版封面或横版封面
    thumb_landscape = None
    thumb_portrait = None
    if thumbnail_path:
        dims = _detect_image_dimensions(str(thumbnail_path))
        if dims and dims[1] > dims[0]:
            thumb_portrait = str(thumbnail_path)
        else:
            thumb_landscape = str(thumbnail_path)

    for index, file in enumerate(files):
        for cookie in account_file:
            print(f"文件路径{str(file)}")
            # 打印视频文件名、标题和 hashtag
            print(f"视频文件名：{file}")
            print(f"标题：{title}")
            print(f"Hashtag：{tags}")
            app = DouYinVideo(
                title,
                str(file),
                tags,
                publish_datetimes[index],
                cookie,
                thumbnail_landscape_path=thumb_landscape,
                productLink=productLink,
                productTitle=productTitle,
                thumbnail_portrait_path=thumb_portrait,
                desc=desc or "",
                publish_strategy=publish_strategy,
            )
            asyncio.run(app.douyin_upload_video(), debug=False)


def post_video_ks(title,files,tags,account_file,category=TencentZoneTypes.LIFESTYLE.value,enableTimer=False,videos_per_day = 1, daily_times=None,start_days = 0, desc='', thumbnail_path='', schedule_datetimes=None):
    # 生成受限目录内的完整路径
    account_file = [_resolve_confined_path("cookiesFile", file) for file in account_file]
    files = [_resolve_confined_path("videoFile", file) for file in files]
    tags = _normalize_tags(tags)
    if enableTimer:
        if schedule_datetimes:
            publish_datetimes = list(schedule_datetimes)
        else:
            publish_datetimes = generate_schedule_time_next_day(
                len(files), videos_per_day or 1, daily_times or None, start_days=start_days or 0
            )
        publish_strategy = KUAISHOU_PUBLISH_STRATEGY_SCHEDULED
    else:
        publish_datetimes = [0 for i in range(len(files))]
        publish_strategy = KUAISHOU_PUBLISH_STRATEGY_IMMEDIATE
    for index, file in enumerate(files):
        for cookie in account_file:
            print(f"文件路径{str(file)}")
            # 打印视频文件名、标题和 hashtag
            print(f"视频文件名：{file}")
            print(f"标题：{title}")
            print(f"Hashtag：{tags}")
            app = KSVideo(
                title,
                str(file),
                tags,
                publish_datetimes[index],
                cookie,
                publish_strategy=publish_strategy,
                thumbnail_path=thumbnail_path or None,
                desc=desc or "",
            )
            asyncio.run(app.main(), debug=False)

def post_video_xhs(title,files,tags,account_file,category=TencentZoneTypes.LIFESTYLE.value,enableTimer=False,videos_per_day = 1, daily_times=None,start_days = 0, desc = '', thumbnail_path='', schedule_datetimes=None):
    # 生成受限目录内的完整路径
    account_file = [_resolve_confined_path("cookiesFile", file) for file in account_file]
    files = [_resolve_confined_path("videoFile", file) for file in files]
    tags = _normalize_tags(tags)
    file_num = len(files)
    if enableTimer:
        if schedule_datetimes:
            publish_datetimes = list(schedule_datetimes)
        else:
            publish_datetimes = generate_schedule_time_next_day(
                file_num, videos_per_day or 1, daily_times or None, start_days=start_days or 0
            )
        publish_strategy = XIAOHONGSHU_PUBLISH_STRATEGY_SCHEDULED
    else:
        publish_datetimes = [0 for _ in range(file_num)]
        publish_strategy = XIAOHONGSHU_PUBLISH_STRATEGY_IMMEDIATE
    for index, file in enumerate(files):
        for cookie in account_file:
            # 打印视频文件名、标题和 hashtag
            print(f"视频文件名：{file}")
            print(f"标题：{title}")
            print(f"Hashtag：{tags}")
            app = XiaoHongShuVideo(
                title,
                file,
                tags,
                publish_datetimes[index],
                cookie,
                thumbnail_path=thumbnail_path or None,
                desc=desc or "",
                publish_strategy=publish_strategy,
            )
            asyncio.run(app.main(), debug=False)



# post_video("333",["demo.mp4"],"d","d")
# post_video_DouYin("333",["demo.mp4"],"d","d")
