from pathlib import Path

from conf import BASE_DIR
from uploader.bilibili_uploader.main import cookie_auth as uploader_bilibili_cookie_auth
from uploader.douyin_uploader.main import cookie_auth as uploader_douyin_cookie_auth
from uploader.ks_uploader.main import cookie_auth as uploader_ks_cookie_auth
from uploader.tencent_uploader.main import cookie_auth as uploader_tencent_cookie_auth
from uploader.xiaohongshu_uploader.main import cookie_auth as uploader_xhs_cookie_auth


async def cookie_auth_douyin(account_file):
    if not Path(account_file).exists():
        return False
    return bool(await uploader_douyin_cookie_auth(str(account_file)))


async def cookie_auth_tencent(account_file):
    if not Path(account_file).exists():
        return False
    return bool(await uploader_tencent_cookie_auth(str(account_file)))


async def cookie_auth_ks(account_file):
    if not Path(account_file).exists():
        return False
    return bool(await uploader_ks_cookie_auth(str(account_file)))


async def cookie_auth_xhs(account_file):
    if not Path(account_file).exists():
        return False
    return bool(await uploader_xhs_cookie_auth(str(account_file)))


async def cookie_auth_bilibili(account_file):
    if not Path(account_file).exists():
        return False
    return bool(await uploader_bilibili_cookie_auth(str(account_file)))


async def check_cookie(type, file_path):
    match type:
        # 小红书
        case 1:
            return await cookie_auth_xhs(Path(BASE_DIR / "cookiesFile" / file_path))
        # 视频号
        case 2:
            return await cookie_auth_tencent(Path(BASE_DIR / "cookiesFile" / file_path))
        # 抖音
        case 3:
            return await cookie_auth_douyin(Path(BASE_DIR / "cookiesFile" / file_path))
        # 快手
        case 4:
            return await cookie_auth_ks(Path(BASE_DIR / "cookiesFile" / file_path))
        # B站
        case 5:
            return await cookie_auth_bilibili(Path(BASE_DIR / "cookiesFile" / file_path))
        case _:
            return False
