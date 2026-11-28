from datetime import timedelta

from datetime import datetime
from pathlib import Path

from conf import BASE_DIR


def get_absolute_path(relative_path: str, base_dir: str = None) -> str:
    # Convert the relative path to an absolute path
    absolute_path = Path(BASE_DIR) / base_dir / relative_path
    return str(absolute_path)


def get_title_and_hashtags(filename):
    """
  获取视频标题和 hashtag

  Args:
    filename: 视频文件名

  Returns:
    视频标题和 hashtag 列表
  """

    # 获取视频标题和 hashtag txt 文件名
    txt_filename = filename.replace(".mp4", ".txt")

    # 读取 txt 文件
    with open(txt_filename, "r", encoding="utf-8") as f:
        content = f.read()

    # 获取标题和 hashtag
    splite_str = content.strip().split("\n")
    title = splite_str[0]
    hashtags = splite_str[1].replace("#", "").split(" ")

    return title, hashtags


def generate_schedule_time_next_day(total_videos, videos_per_day = 1, daily_times=None, timestamps=False, start_days=0):
    """
    Generate a schedule for video uploads, starting from the next day.

    Args:
    - total_videos: Total number of videos to be uploaded.
    - videos_per_day: Number of videos to be uploaded each day.
    - daily_times: Optional list of specific times of the day to publish the videos.
    - timestamps: Boolean to decide whether to return timestamps or datetime objects.
    - start_days: Start from after start_days.

    Returns:
    - A list of scheduling times for the videos, either as timestamps or datetime objects.
    """
    if videos_per_day <= 0:
        raise ValueError("videos_per_day should be a positive integer")

    if daily_times is None:
        # Default times to publish videos if not provided
        daily_times = [6, 11, 14, 16, 22]

    if videos_per_day > len(daily_times):
        raise ValueError("videos_per_day should not exceed the length of daily_times")

    # Generate timestamps
    schedule = []
    current_time = datetime.now()

    parsed_times = []
    for entry in daily_times:
        if isinstance(entry, int):
            hour, minute = entry, 0
        elif isinstance(entry, str) and ":" in entry:
            parts = entry.strip().split(":", 1)
            hour, minute = int(parts[0]), int(parts[1])
        elif isinstance(entry, str):
            hour, minute = int(entry.strip()), 0
        else:
            raise ValueError(f"Unsupported daily_times entry: {entry!r}")
        if not (0 <= hour <= 23 and 0 <= minute <= 59):
            raise ValueError(f"Invalid time in daily_times: {entry!r}")
        parsed_times.append((hour, minute))

    for video in range(total_videos):
        day = video // videos_per_day + start_days + 1  # +1 to start from the next day
        daily_video_index = video % videos_per_day

        # Calculate the time for the current video
        hour, minute = parsed_times[daily_video_index]
        time_offset = timedelta(days=day, hours=hour - current_time.hour, minutes=minute - current_time.minute,
                                seconds=-current_time.second, microseconds=-current_time.microsecond)
        timestamp = current_time + time_offset

        schedule.append(timestamp)

    if timestamps:
        schedule = [int(time.timestamp()) for time in schedule]
    return schedule


def parse_schedule_at_list(raw_schedule_at, total_videos: int = 1) -> list[datetime]:
    """解析精确定时时间字符串或列表（支持当天 YYYY-MM-DD HH:MM）。"""
    if isinstance(raw_schedule_at, str):
        entries = [raw_schedule_at.strip()]
    elif isinstance(raw_schedule_at, (list, tuple)):
        entries = [str(x or "").strip() for x in raw_schedule_at if str(x or "").strip()]
    else:
        raise ValueError("scheduleAt 必须为 YYYY-MM-DD HH:MM 字符串或非空字符串列表")

    if not entries:
        raise ValueError("scheduleAt 不能为空")

    parsed: list[datetime] = []
    for entry in entries:
        normalized = entry.replace("T", " ").strip()
        dt = None
        for fmt in ("%Y-%m-%d %H:%M", "%Y-%m-%d %H:%M:%S"):
            try:
                dt = datetime.strptime(normalized, fmt)
                break
            except ValueError:
                continue
        if dt is None:
            raise ValueError(f"定时时间格式错误: {entry!r}，必须为 YYYY-MM-DD HH:MM（例如 2026-11-28 19:00）")
        parsed.append(dt.replace(second=0, microsecond=0))

    count = max(1, int(total_videos or 1))
    if len(parsed) < count:
        # 仅给单时间点时复用到所有视频（每条递延 1 天）
        last = parsed[-1]
        while len(parsed) < count:
            last = last + timedelta(days=1)
            parsed.append(last)
    return parsed[:count]
