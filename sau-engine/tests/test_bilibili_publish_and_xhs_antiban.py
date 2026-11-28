import asyncio
import json
from datetime import datetime, timedelta
from pathlib import Path
from queue import Queue
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import sau_backend
from myUtils import auth as my_auth
from myUtils import postVideo
import uploader.bilibili_uploader.main as bili_main
import uploader.xiaohongshu_uploader.main as xhs_main


def test_xhs_launch_kwargs_strips_proxies_and_never_uses_stealth(monkeypatch):
    monkeypatch.setenv("ALL_PROXY", "http://127.0.0.1:7897")
    monkeypatch.setenv("HTTP_PROXY", "http://127.0.0.1:7897")
    monkeypatch.setenv("HTTPS_PROXY", "http://127.0.0.1:7897")

    kwargs = xhs_main._xhs_launch_kwargs(headless=False)
    assert "--no-proxy-server" in kwargs["args"]
    assert "--enable-automation" in kwargs["ignore_default_args"]
    env = kwargs["env"]
    for key in ("ALL_PROXY", "HTTP_PROXY", "HTTPS_PROXY", "all_proxy", "http_proxy", "https_proxy"):
        assert key not in env
    assert env["NO_PROXY"] == "*"
    # 确认模块不再引用易触发小红书风控的 stealth.min.js 注入函数
    assert not hasattr(xhs_main, "set_init_script")


def test_xhs_cookie_auth_fast_rejects_empty_cookie_without_browser(tmp_path):
    empty_cookie = tmp_path / "empty.json"
    empty_cookie.write_text(json.dumps({"cookies": [], "origins": []}), encoding="utf-8")

    with patch("uploader.xiaohongshu_uploader.main.async_playwright") as mock_pw:
        ok = asyncio.run(xhs_main.cookie_auth(str(empty_cookie)))
    assert ok is False
    mock_pw.assert_not_called()


def test_xhs_cookie_gen_verifies_in_same_tab_without_second_headless_probe(tmp_path):
    account_file = tmp_path / "xhs_acc.json"
    emitted = []

    class FakePage:
        url = "https://creator.xiaohongshu.com/new/home"

        def is_closed(self):
            return False

        async def goto(self, url, **kwargs):
            if "publish" in url:
                self.url = url

        async def wait_for_timeout(self, ms):
            return None

        def locator(self, sel):
            loc = MagicMock()
            loc.first = loc
            loc.count = AsyncMock(return_value=0)
            loc.is_visible = AsyncMock(return_value=False)
            return loc

        def get_by_text(self, text):
            loc = MagicMock()
            loc.first = loc
            loc.count = AsyncMock(return_value=0)
            loc.is_visible = AsyncMock(return_value=False)
            return loc

    class FakeContext:
        def __init__(self, page):
            self.pages = [page]

        async def cookies(self, url=None):
            return [{"name": "web_session", "value": "valid-session", "domain": ".xiaohongshu.com"}]

        async def storage_state(self, path=None):
            Path(path).write_text(
                json.dumps({"cookies": [{"name": "web_session", "value": "valid-session", "domain": ".xiaohongshu.com"}]}),
                encoding="utf-8",
            )

        async def close(self):
            return None

    class FakeBrowser:
        def __init__(self, context):
            self.contexts = [context]

        async def close(self):
            return None

    class FakeProc:
        def poll(self):
            return None

        def terminate(self):
            return None

        def wait(self, timeout=None):
            return 0

    fake_page = FakePage()
    fake_ctx = FakeContext(fake_page)
    fake_browser = FakeBrowser(fake_ctx)

    fake_pw = MagicMock()
    fake_pw.chromium.connect_over_cdp = AsyncMock(return_value=fake_browser)

    class FakeAsyncPW:
        async def __aenter__(self):
            return fake_pw

        async def __aexit__(self, *args):
            return None

    with patch.object(xhs_main, "_resolve_real_chrome_executable", return_value="C:\\Chrome\\chrome.exe"), \
         patch.object(xhs_main, "_get_xhs_profile_dir", return_value=tmp_path / "profile"), \
         patch.object(xhs_main, "_launch_clean_real_chrome_cdp", return_value=(FakeProc(), 9222)), \
         patch.object(xhs_main, "async_playwright", return_value=FakeAsyncPW()), \
         patch.object(xhs_main, "cookie_auth", new=AsyncMock(return_value=True)) as mock_cookie_auth:
        res = asyncio.run(
            xhs_main.xiaohongshu_cookie_gen(
                str(account_file),
                qrcode_callback=lambda p: emitted.append(p),
                poll_interval=0,
                max_checks=2,
                headless=False,
            )
        )

    assert res["success"] is True
    assert account_file.is_file()
    # 关键防风控断言：登录成功后绝不能起第二个无头浏览器调用 cookie_auth
    mock_cookie_auth.assert_not_awaited()
    assert any("手机号" in (item.get("status_message") or "") for item in emitted)


def test_bilibili_qr_png_and_cookie_gen_and_auth(tmp_path):
    account_file = tmp_path / "bili_acc.json"
    emitted = []

    data_url, png_bytes = bili_main._render_qr_data_url("https://passport.bilibili.com/h5-app/passport/login/scan?navhide=1&qrcode_key=demo")
    assert data_url.startswith("data:image/png;base64,")
    assert png_bytes[:8] == b"\x89PNG\r\n\x1a\n"

    poll_seq = iter([{"code": 86090}, {"code": 0}])

    def fake_poll(session, qr_key):
        val = next(poll_seq)
        if val["code"] == 0:
            session.cookies.set("SESSDATA", "mock_sess", domain=".bilibili.com", path="/")
            session.cookies.set("bili_jct", "mock_csrf", domain=".bilibili.com", path="/")
            session.cookies.set("DedeUserID", "123456", domain=".bilibili.com", path="/")
        return val

    with patch.object(bili_main, "_request_qr_sync", return_value=("https://passport.bilibili.com/scan?k=1", "qk_1")), \
         patch.object(bili_main, "_poll_qr_sync", side_effect=fake_poll), \
         patch.object(bili_main, "_warmup_and_verify_sync", return_value=(True, "测试UP主", {"buvid3": "b3_val"})):
        res = asyncio.run(
            bili_main.bilibili_cookie_gen(
                str(account_file),
                qrcode_callback=lambda p: emitted.append(p),
                poll_interval=0,
                max_checks=5,
            )
        )

    assert res["success"] is True
    assert "测试UP主" in res["message"]
    assert account_file.is_file()
    saved = json.loads(account_file.read_text(encoding="utf-8"))
    names = {c["name"] for c in saved["cookies"]}
    assert {"SESSDATA", "bili_jct", "DedeUserID", "buvid3"}.issubset(names)
    assert any((p.get("image_data_url") or "").startswith("data:image/png;base64,") for p in emitted)
    assert any("确认登录" in (p.get("status_message") or "") for p in emitted)

    # 校验 cookie_auth（mock nav 返回已登录）
    fake_resp = MagicMock(ok=True)
    fake_resp.json.return_value = {"code": 0, "data": {"isLogin": True, "uname": "测试UP主"}}
    with patch.object(bili_main.requests.Session, "get", return_value=fake_resp):
        assert asyncio.run(bili_main.cookie_auth(str(account_file))) is True


def test_sau_backend_supports_bilibili_type_5_end_to_end(tmp_path, monkeypatch):
    monkeypatch.setattr(sau_backend, "BASE_DIR", tmp_path)
    monkeypatch.setattr(postVideo, "BASE_DIR", tmp_path)
    monkeypatch.setattr(my_auth, "BASE_DIR", tmp_path)
    sau_backend.ensure_runtime_ready()
    (tmp_path / "videoFile" / "clip.mp4").write_bytes(b"mp4-bytes")
    (tmp_path / "cookiesFile" / "bili.json").write_text("{}", encoding="utf-8")

    client = sau_backend.app.test_client()

    # 1. check_cookie 支持 type=5
    assert asyncio.run(my_auth.check_cookie(5, "missing.json")) is False

    # 2. run_async_function 分发 type='5' 到 bilibili_cookie_gen
    q = Queue()
    called_login = []

    async def fake_bili_login(acc_id, sq):
        called_login.append(acc_id)
        sq.put("200")

    with patch.object(sau_backend, "bilibili_cookie_gen", side_effect=fake_bili_login):
        sau_backend.run_async_function("5", "我的B站号", q)
    assert called_login == ["我的B站号"]
    assert q.get_nowait() == "200"

    # 3. /postVideo 与 /postVideoBatch 接受 type=5，并记录 platform_name == 'B站'
    captured = []
    with patch.object(sau_backend, "post_video_bilibili", side_effect=lambda *a, **kw: captured.append((a, kw))):
        r_single = client.post(
            "/postVideo",
            json={
                "type": 5,
                "title": "B站干货实测标题",
                "description": "这是B站简介",
                "tags": ["科技", "#AI工具"],
                "fileList": ["clip.mp4"],
                "accountList": ["bili.json"],
            },
        )
        assert r_single.status_code == 200
        r_batch = client.post(
            "/postVideoBatch",
            json=[
                {
                    "type": 5,
                    "title": "B站批量标题",
                    "description": "B站批量简介",
                    "tags": ["教程"],
                    "fileList": ["clip.mp4"],
                    "accountList": ["bili.json"],
                }
            ],
        )
        assert r_batch.status_code == 200

    assert len(captured) == 2
    assert captured[0][0][0] == "B站干货实测标题"
    assert captured[0][1]["desc"] == "这是B站简介"

    hist = client.get("/getPublishHistory").get_json()["data"]
    assert len(hist) == 2
    assert hist[0]["platform_type"] == 5
    assert hist[0]["platform_name"] == "B站"

    # 4. post_video_bilibili 路径约束与定时策略
    with pytest.raises(ValueError):
        postVideo.post_video_bilibili("t", ["../../evil.mp4"], ["tag"], ["bili.json"])
    pv_captured = {}

    class DummyBiliUploader:
        def __init__(self, *args, **kwargs):
            pv_captured["args"] = args
            pv_captured["kwargs"] = kwargs

        async def main(self):
            return None

    target_dt = datetime.now() + timedelta(hours=5)
    with patch.object(postVideo, "BiliBiliVideo", DummyBiliUploader):
        postVideo.post_video_bilibili(
            "定时B站",
            ["clip.mp4"],
            ["#科技", "实测"],
            ["bili.json"],
            enableTimer=True,
            schedule_datetimes=[target_dt],
            desc="定时简介",
        )
    assert pv_captured["args"][3] == target_dt
    assert pv_captured["kwargs"]["publish_strategy"] == "scheduled"
    assert pv_captured["kwargs"]["desc"] == "定时简介"
