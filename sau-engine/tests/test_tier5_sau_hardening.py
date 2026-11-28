import io
import sqlite3
from datetime import datetime
from unittest.mock import patch

import pytest

import sau_backend
from myUtils import postVideo


def test_post_video_validation_bool_tags_and_path_traversal(tmp_path, monkeypatch):
    monkeypatch.setattr(sau_backend, "BASE_DIR", tmp_path)
    sau_backend.ensure_runtime_ready()
    (tmp_path / "videoFile" / "a.mp4").write_bytes(b"video")
    (tmp_path / "cookiesFile" / "c.json").write_text("{}", encoding="utf-8")
    client = sau_backend.app.test_client()

    # 1. 非 dict JSON 返回 JSON 400（非 HTML 500）
    resp_list = client.post("/postVideo", json=[1, 2, 3])
    assert resp_list.status_code == 400
    assert resp_list.is_json

    # 2. bool type（True == 1）必须拒绝
    for bad_type in (True, False, "1", 99):
        resp_bool = client.post(
            "/postVideo",
            json={
                "type": bad_type,
                "title": "标题",
                "fileList": ["a.mp4"],
                "accountList": ["c.json"],
            },
        )
        assert resp_bool.status_code == 400
        assert resp_bool.is_json

    # 3. fileList / accountList 路径穿越与绝对路径拦截
    for bad_file in ("../../conf.py", "../sau_backend.py", "C:/Windows/win.ini", "", "."):
        r_file = client.post(
            "/postVideo",
            json={"type": 3, "title": "标题", "fileList": [bad_file], "accountList": ["c.json"]},
        )
        assert r_file.status_code == 400
        r_acc = client.post(
            "/postVideo",
            json={"type": 3, "title": "标题", "fileList": ["a.mp4"], "accountList": [bad_file]},
        )
        assert r_acc.status_code == 400

    # 4. 非法 tags 类型拒绝，字符串 tags 规范拆分为列表（绝不逐字符迭代）
    r_bad_tags = client.post(
        "/postVideo",
        json={"type": 3, "title": "标题", "fileList": ["a.mp4"], "accountList": ["c.json"], "tags": 123},
    )
    assert r_bad_tags.status_code == 400

    captured = {}

    def fake_dy(title, file_list, tags, *args, **kwargs):
        captured["tags"] = tags

    with patch.object(sau_backend, "post_video_DouYin", side_effect=fake_dy):
        r_str_tags = client.post(
            "/postVideo",
            json={
                "type": 3,
                "title": "标题",
                "fileList": ["a.mp4"],
                "accountList": ["c.json"],
                "tags": "AI, 效率 #工具",
            },
        )
    assert r_str_tags.status_code == 200
    assert captured["tags"] == ["AI", "效率", "工具"]


def test_post_video_batch_validation_and_json_500(tmp_path, monkeypatch):
    monkeypatch.setattr(sau_backend, "BASE_DIR", tmp_path)
    sau_backend.ensure_runtime_ready()
    (tmp_path / "videoFile" / "a.mp4").write_bytes(b"video")
    (tmp_path / "cookiesFile" / "c.json").write_text("{}", encoding="utf-8")
    client = sau_backend.app.test_client()

    # 空数组、非数组、缺少必填字段、bool type、越界路径全部返回 JSON 400
    for bad_payload in (
        {},
        [],
        [{"type": 3}],
        [{"type": True, "title": "t", "fileList": ["a.mp4"], "accountList": ["c.json"]}],
        [{"type": 3, "title": "t", "fileList": ["../../conf.py"], "accountList": ["c.json"]}],
        [{"type": 3, "title": "  ", "fileList": ["a.mp4"], "accountList": ["c.json"]}],
    ):
        resp = client.post("/postVideoBatch", json=bad_payload)
        assert resp.status_code == 400
        assert resp.is_json

    # 上传器抛出异常时必须返回 JSON 500（而非 Flask HTML 500 页面）
    with patch.object(sau_backend, "post_video_DouYin", side_effect=RuntimeError("mock batch failure")):
        err_resp = client.post(
            "/postVideoBatch",
            json=[{"type": 3, "title": "批量测试", "fileList": ["a.mp4"], "accountList": ["c.json"]}],
        )
    assert err_resp.status_code == 500
    assert err_resp.is_json
    err_json = err_resp.get_json()
    assert err_json["code"] == 500
    assert "mock batch failure" in err_json["msg"]


def test_post_video_direct_helpers_confine_paths_and_normalize_tags(tmp_path, monkeypatch):
    monkeypatch.setattr(postVideo, "BASE_DIR", tmp_path)
    (tmp_path / "videoFile").mkdir(parents=True, exist_ok=True)
    (tmp_path / "cookiesFile").mkdir(parents=True, exist_ok=True)

    for fn in (
        postVideo.post_video_tencent,
        postVideo.post_video_DouYin,
        postVideo.post_video_ks,
        postVideo.post_video_xhs,
    ):
        with pytest.raises(ValueError):
            fn("t", ["../../conf.py"], ["tag"], ["c.json"])
        with pytest.raises(ValueError):
            fn("t", ["a.mp4"], ["tag"], ["../../conf.py"])
        with pytest.raises(ValueError):
            fn("t", ["C:/Windows/win.ini"], ["tag"], ["c.json"])

    captured = {}

    class DummyUploader:
        def __init__(self, title, file_path, tags, *args, **kwargs):
            captured["tags"] = tags

        async def main(self):
            return None

    with patch.object(postVideo, "TencentVideo", DummyUploader):
        postVideo.post_video_tencent("t", ["a.mp4"], "AI, 效率 #农资", ["c.json"])
    assert captured["tags"] == ["AI", "效率", "农资"]


def test_get_title_templates_escapes_sql_like_wildcards(tmp_path, monkeypatch):
    monkeypatch.setattr(sau_backend, "BASE_DIR", tmp_path)
    sau_backend.ensure_runtime_ready()
    client = sau_backend.app.test_client()

    # 默认预置模板不含 % 或 _
    assert client.get("/getTitleTemplates?keyword=%25").get_json()["data"] == []
    assert client.get("/getTitleTemplates?keyword=_").get_json()["data"] == []

    # 插入含字面 % 和 _ 的模板后应精准命中
    client.post(
        "/saveTitleTemplate",
        json={"category": "实测", "title": "100%有效的_测试模板", "tags": ["测试"]},
    )
    pct_hits = client.get("/getTitleTemplates?keyword=%25").get_json()["data"]
    assert len(pct_hits) == 1
    assert pct_hits[0]["title"] == "100%有效的_测试模板"

    underscore_hits = client.get("/getTitleTemplates?keyword=_").get_json()["data"]
    assert len(underscore_hits) == 1


def test_sau_backend_info_cleanups(tmp_path, monkeypatch):
    monkeypatch.setattr(sau_backend, "BASE_DIR", tmp_path)
    sau_backend.ensure_runtime_ready()
    client = sau_backend.app.test_client()

    # INFO-1: /uploadSave 不拼接重复后缀
    up_resp = client.post(
        "/uploadSave",
        data={"file": (io.BytesIO(b"video"), "raw.mp4"), "filename": "my_alias.mp4"},
        content_type="multipart/form-data",
    )
    assert up_resp.status_code == 200
    assert up_resp.get_json()["data"]["filename"] == "my_alias.mp4"

    # INFO-2: /deletePublishRecord 与 /deleteTitleTemplate 校验数字 ID 与 404
    assert client.get("/deletePublishRecord?id=abc").status_code == 400
    assert client.get("/deletePublishRecord?id=999999").status_code == 404
    assert client.get("/deleteTitleTemplate?id=abc").status_code == 400
    assert client.get("/deleteTitleTemplate?id=999999").status_code == 404

    # INFO-3: /importLocalFile 在路径触发 OS 异常时返回 JSON 错误（非 HTML 500）
    bad_resp = client.post("/importLocalFile", json={"filePath": "C:\\bad\x00path.mp4"})
    assert bad_resp.status_code in (400, 404)
    assert bad_resp.is_json

    with patch("pathlib.Path.exists", side_effect=OSError("mock stat error")):
        os_err_resp = client.post("/importLocalFile", json={"filePath": str(tmp_path / "any.mp4")})
    assert os_err_resp.status_code == 400
    assert os_err_resp.is_json


def test_new_gap_1_timer_file_existence_and_title_template_validation(tmp_path, monkeypatch):
    monkeypatch.setattr(sau_backend, "BASE_DIR", tmp_path)
    sau_backend.ensure_runtime_ready()
    (tmp_path / "videoFile" / "ok.mp4").write_bytes(b"video")
    (tmp_path / "cookiesFile" / "ok.json").write_text("{}", encoding="utf-8")
    client = sau_backend.app.test_client()

    with patch.object(sau_backend, "post_video_DouYin") as mock_dy:
        # 1. 不存在的本地素材或 cookie 文件必须返回 JSON 400，且绝不调用 uploader 或写 publish_records
        r_missing_file = client.post(
            "/postVideo",
            json={"type": 3, "title": "测试", "fileList": ["does_not_exist.mp4"], "accountList": ["ok.json"]},
        )
        assert r_missing_file.status_code == 400
        assert r_missing_file.is_json

        r_missing_cookie = client.post(
            "/postVideo",
            json={"type": 3, "title": "测试", "fileList": ["ok.mp4"], "accountList": ["missing_acc.json"]},
        )
        assert r_missing_cookie.status_code == 400
        assert r_missing_cookie.is_json

        # 2. enableTimer 参数预校验（videosPerDay 超槽位、非法 HH:MM、负数 startDays、非整数/bool）
        bad_timer_cases = [
            {"enableTimer": 1, "videosPerDay": 5, "dailyTimes": ["10:00", "18:00"], "startDays": 0},
            {"enableTimer": 1, "videosPerDay": 1, "dailyTimes": ["25:99"], "startDays": 0},
            {"enableTimer": 1, "videosPerDay": 1, "dailyTimes": ["bad"], "startDays": 0},
            {"enableTimer": 1, "videosPerDay": 1, "dailyTimes": [], "startDays": 0},
            {"enableTimer": 1, "videosPerDay": 1, "dailyTimes": ["10:00"], "startDays": -5},
            {"enableTimer": 1, "videosPerDay": 0, "dailyTimes": ["10:00"], "startDays": 0},
            {"enableTimer": 1, "videosPerDay": True, "dailyTimes": ["10:00"], "startDays": 0},
            {"enableTimer": 1, "videosPerDay": 1.5, "dailyTimes": ["10:00"], "startDays": 0},
        ]
        for timer_args in bad_timer_cases:
            payload = {"type": 3, "title": "定时校验", "fileList": ["ok.mp4"], "accountList": ["ok.json"], **timer_args}
            r_single = client.post("/postVideo", json=payload)
            assert r_single.status_code == 400, f"Expected 400 for {timer_args}, got {r_single.status_code}"
            assert r_single.is_json

            r_batch = client.post("/postVideoBatch", json=[payload])
            assert r_batch.status_code == 400, f"Expected batch 400 for {timer_args}, got {r_batch.status_code}"
            assert r_batch.is_json

        # 3. 2 小时安全提前窗口校验：23:30 预约明天 00:30（仅差 1 小时）必须拦截
        class FixedDatetime(datetime):
            @classmethod
            def now(cls, tz=None):
                return datetime(2026, 11, 28, 23, 30, 0)

        with patch.object(sau_backend, "datetime", FixedDatetime):
            r_too_soon = client.post(
                "/postVideo",
                json={
                    "type": 3,
                    "title": "过近定时校验",
                    "fileList": ["ok.mp4"],
                    "accountList": ["ok.json"],
                    "enableTimer": 1,
                    "videosPerDay": 1,
                    "dailyTimes": ["00:30"],
                    "startDays": 0,
                },
            )
            assert r_too_soon.status_code == 400
            assert r_too_soon.is_json

        mock_dy.assert_not_called()

    assert client.get("/getPublishHistory").get_json()["data"] == []

    # 4. /saveTitleTemplate 非 dict JSON 返回 JSON 400，非法 id 返回 400，不存在 id 返回 404 (NOTE-3)
    r_tpl_list = client.post("/saveTitleTemplate", json=[1, 2, 3])
    assert r_tpl_list.status_code == 400
    assert r_tpl_list.is_json

    r_tpl_bad_id = client.post("/saveTitleTemplate", json={"id": "abc", "title": "测试标题"})
    assert r_tpl_bad_id.status_code == 400
    assert r_tpl_bad_id.is_json

    r_tpl_missing = client.post("/saveTitleTemplate", json={"id": 999999, "title": "不存在模板"})
    assert r_tpl_missing.status_code == 404
    assert r_tpl_missing.is_json


def test_note_2_update_userinfo_validation_and_404(tmp_path, monkeypatch):
    monkeypatch.setattr(sau_backend, "BASE_DIR", tmp_path)
    sau_backend.ensure_runtime_ready()
    client = sau_backend.app.test_client()

    for bad_body in (
        [1, 2, 3],
        {"id": "abc", "type": 3, "userName": "测试号"},
        {"id": True, "type": 3, "userName": "测试号"},
        {"id": 0, "type": 3, "userName": "测试号"},
        {"id": 1, "type": True, "userName": "测试号"},
        {"id": 1, "type": 9, "userName": "测试号"},
        {"id": 1, "type": 3, "userName": "  "},
    ):
        resp = client.post("/updateUserinfo", json=bad_body)
        assert resp.status_code == 400
        assert resp.is_json

    # 不存在 id 返回 404
    not_found = client.post("/updateUserinfo", json={"id": 999999, "type": 3, "userName": "测试号"})
    assert not_found.status_code == 404
    assert not_found.is_json

    # 插入一条真实账号后更新成功
    with sqlite3.connect(tmp_path / "db" / "database.db") as conn:
        cur = conn.cursor()
        cur.execute("INSERT INTO user_info (type, filePath, userName, status) VALUES (3, 'acc.json', '旧名字', 1)")
        acc_id = cur.lastrowid
        conn.commit()

    ok_resp = client.post("/updateUserinfo", json={"id": acc_id, "type": 1, "userName": "新名字"})
    assert ok_resp.status_code == 200
    accounts = client.get("/getAccounts").get_json()["data"]
    assert accounts[0][1] == 1
    assert accounts[0][3] == "新名字"
