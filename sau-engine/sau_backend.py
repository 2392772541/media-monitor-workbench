import asyncio
import json
import os
import re
import shutil
import sqlite3
import threading
import time
import uuid
from datetime import datetime, timedelta
from queue import Empty, Queue
from pathlib import Path
from flask_cors import CORS
from myUtils.auth import check_cookie
from flask import Flask, request, jsonify, Response, render_template, send_from_directory
from conf import BASE_DIR
from myUtils.login import get_tencent_cookie, douyin_cookie_gen, get_ks_cookie, xiaohongshu_cookie_gen
from myUtils.postVideo import post_video_tencent, post_video_DouYin, post_video_ks, post_video_xhs
from uploader.base_video import BaseVideoUploader
from utils.files_times import parse_schedule_at_list

active_queues = {}
active_queues_lock = threading.Lock()
app = Flask(__name__)


def ensure_runtime_ready():
    """Ensure required directories and SQLite tables exist before handling requests."""
    for subdir in ("videoFile", "cookiesFile", "db"):
        Path(BASE_DIR / subdir).mkdir(parents=True, exist_ok=True)

    db_path = Path(BASE_DIR / "db" / "database.db")
    with sqlite3.connect(db_path) as conn:
        cursor = conn.cursor()
        cursor.execute('''
        CREATE TABLE IF NOT EXISTS user_info (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            type INTEGER NOT NULL,
            filePath TEXT NOT NULL,
            userName TEXT NOT NULL,
            status INTEGER DEFAULT 0
        )
        ''')
        cursor.execute('''
        CREATE TABLE IF NOT EXISTS file_records (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            filename TEXT NOT NULL,
            filesize REAL,
            upload_time DATETIME DEFAULT CURRENT_TIMESTAMP,
            file_path TEXT
        )
        ''')
        cursor.execute('''
        CREATE TABLE IF NOT EXISTS publish_records (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            platform_type INTEGER NOT NULL,
            title TEXT NOT NULL,
            file_list TEXT NOT NULL,
            account_list TEXT NOT NULL,
            tags TEXT,
            enable_timer INTEGER DEFAULT 0,
            schedule_summary TEXT,
            is_draft INTEGER DEFAULT 0,
            status TEXT NOT NULL,
            message TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
        ''')
        cursor.execute('''
        CREATE TABLE IF NOT EXISTS title_templates (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            category TEXT DEFAULT '通用',
            title TEXT NOT NULL,
            tags TEXT,
            note TEXT DEFAULT '',
            use_count INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
        ''')
        existing_tpl_count = cursor.execute("SELECT COUNT(1) FROM title_templates").fetchone()[0]
        if existing_tpl_count == 0:
            seed_templates = [
                ("干货拆解", "【干货必看】3分钟讲清楚核心逻辑，建议先收藏再慢慢看！", ["干货分享", "效率提升"], "适合知识科普、方法总结类视频"),
                ("好物测评", "真实体验一周后才敢说实话：到底值不值得入手？", ["好物推荐", "真实测评"], "适合产品开箱、工具对比视频"),
                ("教程实操", "保姆级手把手教学，跟着做一遍就能学会！", ["教程", "新手必看"], "适合分步教学、软件演示视频"),
                ("日常Vlog", "记录生活里的小确幸，今天也请继续加油呀！", ["日常", "Vlog"], "适合生活碎片、日常记录"),
            ]
            for cat, ttl, tgs, nt in seed_templates:
                cursor.execute(
                    "INSERT INTO title_templates (category, title, tags, note) VALUES (?, ?, ?, ?)",
                    (cat, ttl, json.dumps(tgs, ensure_ascii=False), nt),
                )
        conn.commit()


ensure_runtime_ready()


def record_publish_history(
    platform_type,
    title,
    file_list,
    account_list,
    tags,
    enable_timer,
    videos_per_day,
    daily_times,
    start_days,
    is_draft,
    status,
    message='',
    schedule_datetimes=None,
):
    """Persist publish execution summary so users can inspect & reuse history."""
    ensure_runtime_ready()
    schedule_summary = ''
    if enable_timer:
        if schedule_datetimes:
            dt_text = ', '.join(dt.strftime('%Y-%m-%d %H:%M') for dt in schedule_datetimes)
            schedule_summary = f'定时({dt_text})'
        else:
            times_text = ', '.join(str(t) for t in (daily_times or []))
            start_label = '明天' if start_days == 0 else ('后天' if start_days == 1 else f'{start_days}天后')
            schedule_summary = f'定时({start_label}起，每天{videos_per_day or 1}条 {times_text})'
    else:
        schedule_summary = '立即发布'

    db_path = Path(BASE_DIR / "db" / "database.db")
    with sqlite3.connect(db_path) as conn:
        cursor = conn.cursor()
        cursor.execute(
            '''
            INSERT INTO publish_records (
                platform_type, title, file_list, account_list, tags,
                enable_timer, schedule_summary, is_draft, status, message
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ''',
            (
                int(platform_type or 0),
                str(title or ''),
                json.dumps(file_list or [], ensure_ascii=False),
                json.dumps(account_list or [], ensure_ascii=False),
                json.dumps(tags or [], ensure_ascii=False),
                1 if enable_timer else 0,
                schedule_summary,
                1 if is_draft else 0,
                status,
                str(message or ''),
            ),
        )
        conn.commit()

# 仅允许本机回环来源跨域访问，保障本地账号凭证安全
CORS(app, resources={r"/*": {"origins": [r"^http://127\.0\.0\.1(:\d+)?$", r"^http://localhost(:\d+)?$"]}})

# 限制上传文件大小为160MB
app.config['MAX_CONTENT_LENGTH'] = 160 * 1024 * 1024

# 获取当前目录（假设 index.html 和 assets 在这里）
current_dir = os.path.dirname(os.path.abspath(__file__))

# 处理所有静态资源请求（未来打包用）
@app.route('/assets/<filename>')
def custom_static(filename):
    return send_from_directory(os.path.join(current_dir, 'assets'), filename)

# 处理 favicon.ico 静态资源（未来打包用）
@app.route('/favicon.ico')
def favicon():
    return send_from_directory(os.path.join(current_dir, 'assets'), 'vite.svg')

@app.route('/vite.svg')
def vite_svg():
    return send_from_directory(os.path.join(current_dir, 'assets'), 'vite.svg')

# （未来打包用）
@app.route('/')
def index():  # put application's code here
    return send_from_directory(current_dir, 'index.html')

@app.route('/upload', methods=['POST'])
def upload_file():
    if 'file' not in request.files:
        return jsonify({
            "code": 400,
            "data": None,
            "msg": "No file part in the request"
        }), 400
    file = request.files['file']
    if file.filename == '':
        return jsonify({
            "code": 400,
            "data": None,
            "msg": "No selected file"
        }), 400
    try:
        # 保存文件到指定位置
        uuid_v1 = uuid.uuid1()
        print(f"UUID v1: {uuid_v1}")
        safe_name = Path(file.filename).name
        if not safe_name:
            return jsonify({"code": 400, "data": None, "msg": "Invalid filename"}), 400
        video_dir = Path(BASE_DIR / "videoFile")
        video_dir.mkdir(parents=True, exist_ok=True)
        saved_name = f"{uuid_v1}_{safe_name}"
        filepath = video_dir / saved_name
        file.save(filepath)
        return jsonify({"code":200,"msg": "File uploaded successfully", "data": saved_name}), 200
    except Exception as e:
        return jsonify({"code":500,"msg": str(e),"data":None}), 500

@app.route('/getFile', methods=['GET'])
def get_file():
    # 获取 filename 参数
    filename = request.args.get('filename')

    if not filename:
        return jsonify({"code": 400, "msg": "filename is required", "data": None}), 400

    # 防止路径穿越攻击
    base_dir = Path(BASE_DIR / "videoFile").resolve()
    target_path = (base_dir / filename).resolve()
    if not target_path.is_relative_to(base_dir) or target_path == base_dir:
        return jsonify({"code": 400, "msg": "Invalid filename", "data": None}), 400

    # 拼接完整路径
    file_path = str(base_dir)

    # 返回文件
    return send_from_directory(file_path, target_path.name)


@app.route('/uploadSave', methods=['POST'])
def upload_save():
    if 'file' not in request.files:
        return jsonify({
            "code": 400,
            "data": None,
            "msg": "No file part in the request"
        }), 400

    file = request.files['file']
    if file.filename == '':
        return jsonify({
            "code": 400,
            "data": None,
            "msg": "No selected file"
        }), 400

    # 获取表单中的自定义文件名（可选）
    custom_filename = request.form.get('filename', None)
    original_name = Path(file.filename).name
    if not original_name:
        return jsonify({"code": 400, "data": None, "msg": "Invalid filename"}), 400
    if custom_filename:
        safe_custom = Path(custom_filename).name
        ext = original_name.rsplit('.', 1)[-1] if '.' in original_name else ''
        if ext and not safe_custom.lower().endswith(f".{ext.lower()}"):
            filename = f"{safe_custom}.{ext}"
        else:
            filename = safe_custom
    else:
        filename = original_name

    try:
        # 生成 UUID v1
        uuid_v1 = uuid.uuid1()
        print(f"UUID v1: {uuid_v1}")

        # 构造文件名和路径
        final_filename = f"{uuid_v1}_{filename}"
        video_dir = Path(BASE_DIR / "videoFile")
        video_dir.mkdir(parents=True, exist_ok=True)
        filepath = video_dir / final_filename

        # 保存文件
        file.save(filepath)

        with sqlite3.connect(Path(BASE_DIR / "db" / "database.db")) as conn:
            cursor = conn.cursor()
            cursor.execute('''
                                INSERT INTO file_records (filename, filesize, file_path)
            VALUES (?, ?, ?)
                                ''', (filename, round(float(os.path.getsize(filepath)) / (1024 * 1024),2), final_filename))
            conn.commit()
            print("✅ 上传文件已记录")

        return jsonify({
            "code": 200,
            "msg": "File uploaded and saved successfully",
            "data": {
                "filename": filename,
                "filepath": final_filename
            }
        }), 200

    except Exception as e:
        print(f"Upload failed: {e}")
        return jsonify({
            "code": 500,
            "msg": f"upload failed: {e}",
            "data": None
        }), 500


@app.route('/importLocalFile', methods=['POST'])
def import_local_file():
    """免拖拽导入本机绝对路径视频文件到素材库，并登记到 file_records。"""
    raw = request.get_json(silent=True)
    if not isinstance(raw, dict):
        return jsonify({
            "code": 400,
            "msg": "Invalid JSON object payload",
            "data": None
        }), 400
    data = raw
    raw_val = data.get('filePath')
    raw_path = raw_val.strip().strip('"').strip("'").strip() if isinstance(raw_val, str) else ''

    if not raw_path or not Path(raw_path).is_absolute():
        return jsonify({
            "code": 400,
            "msg": "filePath must be a non-empty absolute path",
            "data": None
        }), 400

    src_path = Path(raw_path)
    try:
        exists = src_path.exists()
        is_file = exists and src_path.is_file()
    except (OSError, ValueError) as e:
        return jsonify({
            "code": 400,
            "msg": f"Invalid filePath: {e}",
            "data": None
        }), 400
    if not exists:
        return jsonify({
            "code": 404,
            "msg": f"Local file not found: {src_path}",
            "data": None
        }), 404
    if not is_file:
        return jsonify({
            "code": 400,
            "msg": f"Path is not a regular file: {src_path}",
            "data": None
        }), 400
    if src_path.suffix.lower() not in BaseVideoUploader.SUPPORTED_VIDEO_EXTENSIONS:
        return jsonify({
            "code": 400,
            "msg": f"Unsupported video extension: {src_path.suffix}",
            "data": None
        }), 400

    # 处理可选自定义文件名：保留安全文件名及原始视频扩展名，拒绝非法路径段
    custom_raw = data.get('filename')
    if custom_raw is not None:
        if not isinstance(custom_raw, str):
            return jsonify({
                "code": 400,
                "msg": "Invalid filename",
                "data": None
            }), 400
        custom_stripped = custom_raw.strip()
        if custom_stripped:
            if (
                custom_stripped in {".", ".."}
                or any(sep in custom_stripped for sep in ("/", "\\"))
                or Path(custom_stripped).name != custom_stripped
            ):
                return jsonify({
                    "code": 400,
                    "msg": "Invalid filename",
                    "data": None
                }), 400
            safe_candidate = Path(custom_stripped).name
            if not safe_candidate or safe_candidate in {".", ".."}:
                return jsonify({
                    "code": 400,
                    "msg": "Invalid filename",
                    "data": None
                }), 400
            if src_path.suffix and not safe_candidate.lower().endswith(src_path.suffix.lower()):
                final_name = f"{safe_candidate}{src_path.suffix}"
            else:
                final_name = safe_candidate
        else:
            final_name = src_path.name
    else:
        final_name = src_path.name

    try:
        video_dir = Path(BASE_DIR / "videoFile")
        video_dir.mkdir(parents=True, exist_ok=True)
        saved_name = f"{uuid.uuid1()}_{final_name}"
        dest_path = video_dir / saved_name
        shutil.copy2(src_path, dest_path)

        filesize = round(float(os.path.getsize(dest_path)) / (1024 * 1024), 2)
        ensure_runtime_ready()
        conn = sqlite3.connect(Path(BASE_DIR / "db" / "database.db"))
        try:
            cursor = conn.cursor()
            cursor.execute(
                '''
                INSERT INTO file_records (filename, filesize, file_path)
                VALUES (?, ?, ?)
                ''',
                (final_name, filesize, saved_name),
            )
            record_id = cursor.lastrowid
            conn.commit()
        finally:
            conn.close()

        return jsonify({
            "code": 200,
            "msg": "import success",
            "data": {
                "id": record_id,
                "filename": final_name,
                "filepath": saved_name,
                "filesize": filesize,
            }
        }), 200
    except Exception as e:
        return jsonify({
            "code": 500,
            "msg": f"import failed: {e}",
            "data": None
        }), 500

@app.route('/getFiles', methods=['GET'])
def get_all_files():
    try:
        # 使用 with 自动管理数据库连接
        with sqlite3.connect(Path(BASE_DIR / "db" / "database.db")) as conn:
            conn.row_factory = sqlite3.Row  # 允许通过列名访问结果
            cursor = conn.cursor()

            # 查询所有记录
            cursor.execute("SELECT * FROM file_records")
            rows = cursor.fetchall()

            # 将结果转为字典列表，并提取UUID
            data = []
            for row in rows:
                row_dict = dict(row)
                # 从 file_path 中提取 UUID (文件名的第一部分，下划线前)
                if row_dict.get('file_path'):
                    file_path_parts = row_dict['file_path'].split('_', 1)  # 只分割第一个下划线
                    if len(file_path_parts) > 0:
                        row_dict['uuid'] = file_path_parts[0]  # UUID 部分
                    else:
                        row_dict['uuid'] = ''
                else:
                    row_dict['uuid'] = ''
                data.append(row_dict)

            return jsonify({
                "code": 200,
                "msg": "success",
                "data": data
            }), 200
    except Exception as e:
        return jsonify({
            "code": 500,
            "msg": str("get file failed!"),
            "data": None
        }), 500


@app.route("/getAccounts", methods=['GET'])
def getAccounts():
    """快速获取所有账号信息，不进行cookie验证"""
    try:
        with sqlite3.connect(Path(BASE_DIR / "db" / "database.db")) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()
            cursor.execute('''
            SELECT * FROM user_info''')
            rows = cursor.fetchall()
            rows_list = [list(row) for row in rows]

            print("\n📋 当前数据表内容（快速获取）：")
            for row in rows:
                print(row)

            return jsonify(
                {
                    "code": 200,
                    "msg": None,
                    "data": rows_list
                }), 200
    except Exception as e:
        print(f"获取账号列表时出错: {str(e)}")
        return jsonify({
            "code": 500,
            "msg": f"获取账号列表失败: {str(e)}",
            "data": None
        }), 500


@app.route("/getValidAccounts",methods=['GET'])
async def getValidAccounts():
    with sqlite3.connect(Path(BASE_DIR / "db" / "database.db")) as conn:
        cursor = conn.cursor()
        cursor.execute('''
        SELECT * FROM user_info''')
        rows = cursor.fetchall()
        rows_list = [list(row) for row in rows]
        print("\n📋 当前数据表内容：")
        for row in rows:
            print(row)
        for row in rows_list:
            try:
                flag = await check_cookie(row[1], row[2])
            except Exception as e:
                print(f"⚠️ 验证账号 {row[3]} Cookie 异常: {e}")
                flag = False
            if not flag:
                row[4] = 0
                cursor.execute('''
                UPDATE user_info 
                SET status = ? 
                WHERE id = ?
                ''', (0,row[0]))
                conn.commit()
                print("✅ 用户状态已更新")
            elif row[4] != 1:
                row[4] = 1
                cursor.execute('''
                UPDATE user_info 
                SET status = ? 
                WHERE id = ?
                ''', (1, row[0]))
                conn.commit()
        for row in rows:
            print(row)
        return jsonify(
                        {
                            "code": 200,
                            "msg": None,
                            "data": rows_list
                        }),200

@app.route('/deleteFile', methods=['GET'])
def delete_file():
    file_id = request.args.get('id')

    if not file_id or not file_id.isdigit():
        return jsonify({
            "code": 400,
            "msg": "Invalid or missing file ID",
            "data": None
        }), 400

    try:
        # 获取数据库连接
        with sqlite3.connect(Path(BASE_DIR / "db" / "database.db")) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()

            # 查询要删除的记录
            cursor.execute("SELECT * FROM file_records WHERE id = ?", (file_id,))
            record = cursor.fetchone()

            if not record:
                return jsonify({
                    "code": 404,
                    "msg": "File not found",
                    "data": None
                }), 404

            record = dict(record)

            # 获取文件路径并删除实际文件
            file_path = Path(BASE_DIR / "videoFile" / record['file_path'])
            if file_path.exists():
                try:
                    file_path.unlink()  # 删除文件
                    print(f"✅ 实际文件已删除: {file_path}")
                except Exception as e:
                    print(f"⚠️ 删除实际文件失败: {e}")
                    # 即使删除文件失败，也要继续删除数据库记录，避免数据不一致
            else:
                print(f"⚠️ 实际文件不存在: {file_path}")

            # 删除数据库记录
            cursor.execute("DELETE FROM file_records WHERE id = ?", (file_id,))
            conn.commit()

        return jsonify({
            "code": 200,
            "msg": "File deleted successfully",
            "data": {
                "id": record['id'],
                "filename": record['filename']
            }
        }), 200

    except Exception as e:
        return jsonify({
            "code": 500,
            "msg": str("delete failed!"),
            "data": None
        }), 500

@app.route('/deleteAccount', methods=['GET'])
def delete_account():
    account_id = request.args.get('id')

    if not account_id or not account_id.isdigit():
        return jsonify({
            "code": 400,
            "msg": "Invalid or missing account ID",
            "data": None
        }), 400

    account_id = int(account_id)

    try:
        # 获取数据库连接
        with sqlite3.connect(Path(BASE_DIR / "db" / "database.db")) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()

            # 查询要删除的记录
            cursor.execute("SELECT * FROM user_info WHERE id = ?", (account_id,))
            record = cursor.fetchone()

            if not record:
                return jsonify({
                    "code": 404,
                    "msg": "account not found",
                    "data": None
                }), 404

            record = dict(record)

            # 删除关联的cookie文件
            if record.get('filePath'):
                cookie_file_path = Path(BASE_DIR / "cookiesFile" / record['filePath'])
                if cookie_file_path.exists():
                    try:
                        cookie_file_path.unlink()
                        print(f"✅ Cookie文件已删除: {cookie_file_path}")
                    except Exception as e:
                        print(f"⚠️ 删除Cookie文件失败: {e}")

            # 删除数据库记录
            cursor.execute("DELETE FROM user_info WHERE id = ?", (account_id,))
            conn.commit()

        return jsonify({
            "code": 200,
            "msg": "account deleted successfully",
            "data": None
        }), 200

    except Exception as e:
        return jsonify({
            "code": 500,
            "msg": f"delete failed: {str(e)}",
            "data": None
        }), 500


# SSE 登录接口
@app.route('/login')
def login():
    # 1 小红书 2 视频号 3 抖音 4 快手
    login_type = request.args.get('type')
    # 账号名
    account_id = request.args.get('id')

    if login_type not in {'1', '2', '3', '4'} or not account_id:
        return jsonify({"code": 400, "msg": "缺少或非法的平台类型/账号名称", "data": None}), 400

    # 模拟一个用于异步通信的队列
    status_queue = Queue()
    queue_key = f"{login_type}:{account_id}:{uuid.uuid4().hex[:8]}"
    with active_queues_lock:
        active_queues[queue_key] = status_queue

    # 启动异步任务线程
    thread = threading.Thread(target=run_async_function, args=(login_type, account_id, status_queue), daemon=True)
    thread.start()
    response = Response(sse_stream(status_queue, queue_key=queue_key), mimetype='text/event-stream')
    response.headers['Cache-Control'] = 'no-cache'
    response.headers['X-Accel-Buffering'] = 'no'  # 关键：禁用 Nginx 缓冲
    response.headers['Content-Type'] = 'text/event-stream'
    response.headers['Connection'] = 'keep-alive'
    return response

def _escape_like(term: str) -> str:
    """转义 SQLite LIKE 通配符（\\, %, _）。"""
    return str(term or "").replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _validate_confined_entries(entries, base_subdir: str, label: str, require_exists: bool = True):
    if not isinstance(entries, list) or len(entries) == 0:
        return None, f"{label}必须为非空字符串数组"
    root = (Path(BASE_DIR) / base_subdir).resolve()
    cleaned = []
    for item in entries:
        if not isinstance(item, str) or not item.strip():
            return None, f"{label}包含无效文件名"
        raw = item.strip()
        candidate = Path(raw)
        if candidate.is_absolute():
            return None, f"{label}不允许包含绝对路径"
        resolved = (root / candidate).resolve()
        if not resolved.is_relative_to(root) or resolved == root:
            return None, f"{label}包含非法越界路径"
        if require_exists and not resolved.is_file():
            return None, f"{label}中存在不存在的文件: {raw}"
        cleaned.append(raw)
    return cleaned, None


def _normalize_post_tags(raw_tags):
    if raw_tags is None:
        return [], None
    items = []
    if isinstance(raw_tags, list):
        for elem in raw_tags:
            if isinstance(elem, bool) or not isinstance(elem, (str, int, float)):
                return None, "tags 数组元素必须为字符串"
            if isinstance(elem, str):
                items.extend(re.split(r"[,，\s]+", elem))
            else:
                items.append(str(elem))
    elif isinstance(raw_tags, str):
        items = re.split(r"[,，\s]+", raw_tags)
    else:
        return None, "tags 必须为字符串数组或逗号分隔字符串"
    cleaned = []
    seen = set()
    for item in items:
        tag = str(item or "").strip().lstrip("#").strip()
        if not tag or tag in seen:
            continue
        seen.add(tag)
        cleaned.append(tag)
    return cleaned, None


def _validate_post_payload(data):
    if not isinstance(data, dict):
        return None, "请求体必须为 JSON 对象"
    platform_type = data.get("type")
    if isinstance(platform_type, bool) or not isinstance(platform_type, int) or platform_type not in (1, 2, 3, 4):
        return None, f"不支持的平台类型: {platform_type}"
    raw_title = data.get("title")
    if not isinstance(raw_title, str) or not raw_title.strip():
        return None, "标题不能为空"
    title = raw_title.strip()
    file_list, file_err = _validate_confined_entries(data.get("fileList"), "videoFile", "文件列表", require_exists=True)
    if file_err:
        return None, file_err
    account_list, acc_err = _validate_confined_entries(data.get("accountList"), "cookiesFile", "账号列表", require_exists=True)
    if acc_err:
        return None, acc_err
    tags, tag_err = _normalize_post_tags(data.get("tags"))
    if tag_err:
        return None, tag_err
    raw_desc = data.get("description", "")
    if raw_desc is None:
        description = ""
    elif isinstance(raw_desc, str):
        description = raw_desc
    else:
        return None, "description 必须为字符串"

    raw_enable_timer = data.get("enableTimer", 0)
    if isinstance(raw_enable_timer, bool):
        enable_timer = 1 if raw_enable_timer else 0
    elif isinstance(raw_enable_timer, int) and raw_enable_timer in (0, 1):
        enable_timer = raw_enable_timer
    elif raw_enable_timer is None:
        enable_timer = 0
    else:
        return None, "enableTimer 必须为布尔值或 0/1"

    videos_per_day = data.get("videosPerDay")
    daily_times = data.get("dailyTimes")
    start_days = data.get("startDays", 0)
    raw_schedule_at = data.get("scheduleAt")
    schedule_datetimes = None

    if enable_timer == 1:
        current_time = datetime.now()
        if raw_schedule_at is not None and raw_schedule_at != "":
            try:
                schedule_datetimes = parse_schedule_at_list(raw_schedule_at, len(file_list))
            except ValueError as exc:
                return None, str(exc)
            earliest = min(schedule_datetimes)
            if earliest <= current_time + timedelta(hours=2):
                return None, f"最早定时时间（{earliest.strftime('%Y-%m-%d %H:%M')}）必须晚于当前时间至少 2 小时以上"
        else:
            if isinstance(videos_per_day, bool) or not isinstance(videos_per_day, int) or videos_per_day < 1:
                return None, "启用定时发布时，videosPerDay 必须为大于等于 1 的整数"
            if not isinstance(daily_times, list) or len(daily_times) == 0:
                return None, "启用定时发布时，dailyTimes 必须为非空 HH:MM 字符串数组"
            parsed_times = []
            normalized_times = []
            for entry in daily_times:
                if not isinstance(entry, str):
                    return None, f"定时时间点必须为 HH:MM 字符串: {entry!r}"
                match = re.fullmatch(r"(\d{1,2}):(\d{2})", entry.strip())
                if not match:
                    return None, f"定时时间点格式错误: {entry!r}，必须为 HH:MM"
                hour, minute = int(match.group(1)), int(match.group(2))
                if not (0 <= hour <= 23 and 0 <= minute <= 59):
                    return None, f"定时时间点超出有效范围: {entry!r}（小时 0~23，分钟 0~59）"
                parsed_times.append((hour, minute))
                normalized_times.append(f"{hour:02d}:{minute:02d}")
            if videos_per_day > len(normalized_times):
                return None, f"启用定时发布时，videosPerDay ({videos_per_day}) 不能大于 dailyTimes 数量 ({len(normalized_times)})"
            if start_days is None:
                start_days = 0
            if isinstance(start_days, bool) or not isinstance(start_days, int) or start_days < 0:
                return None, "启用定时发布时，startDays 必须为大于等于 0 的整数"

            schedule = []
            for video_idx in range(len(file_list)):
                day = video_idx // videos_per_day + start_days + 1
                daily_video_index = video_idx % videos_per_day
                hour, minute = parsed_times[daily_video_index]
                scheduled_dt = current_time + timedelta(
                    days=day,
                    hours=hour - current_time.hour,
                    minutes=minute - current_time.minute,
                    seconds=-current_time.second,
                    microseconds=-current_time.microsecond,
                )
                schedule.append(scheduled_dt)
            earliest = min(schedule)
            if earliest <= current_time + timedelta(hours=2):
                return None, f"最早定时时间（{earliest.strftime('%Y-%m-%d %H:%M')}）必须晚于当前时间至少 2 小时以上"
            daily_times = normalized_times

    category = data.get("category")
    if category == 0:
        category = None
    product_link = data.get("productLink", "")
    product_title = data.get("productTitle", "")

    raw_thumb = data.get("coverPath") if data.get("coverPath") not in (None, "") else data.get("thumbnail", "")
    thumbnail_path = ""
    if raw_thumb is not None and raw_thumb != "":
        if not isinstance(raw_thumb, str):
            return None, "封面路径 thumbnail/coverPath 必须为字符串"
        cleaned_thumb = raw_thumb.strip().strip('"').strip("'").strip()
        if cleaned_thumb:
            try:
                validated_cover = BaseVideoUploader.validate_image_file(cleaned_thumb)
                thumbnail_path = str(validated_cover)
            except (FileNotFoundError, ValueError, OSError) as exc:
                return None, f"封面图片校验失败: {exc}"

    return {
        "type": platform_type,
        "title": title,
        "description": description,
        "file_list": file_list,
        "account_list": account_list,
        "tags": tags,
        "category": category,
        "enable_timer": enable_timer,
        "videos_per_day": videos_per_day,
        "daily_times": daily_times,
        "start_days": start_days,
        "schedule_datetimes": schedule_datetimes,
        "product_link": product_link if isinstance(product_link, str) else "",
        "product_title": product_title if isinstance(product_title, str) else "",
        "thumbnail_path": thumbnail_path,
        "is_draft": bool(data.get("isDraft", False)),
    }, None


@app.route('/postVideo', methods=['POST'])
def postVideo():
    # 获取并严格校验 JSON 请求体
    raw_data = request.get_json(silent=True)
    parsed, err = _validate_post_payload(raw_data)
    if err:
        return jsonify({"code": 400, "msg": err, "data": None}), 400

    file_list = parsed["file_list"]
    account_list = parsed["account_list"]
    type = parsed["type"]
    title = parsed["title"]
    description = parsed["description"]
    tags = parsed["tags"]
    category = parsed["category"]
    enableTimer = parsed["enable_timer"]
    productLink = parsed["product_link"]
    productTitle = parsed["product_title"]
    thumbnail_path = parsed["thumbnail_path"]
    is_draft = parsed["is_draft"]
    videos_per_day = parsed["videos_per_day"]
    daily_times = parsed["daily_times"]
    start_days = parsed["start_days"]
    schedule_datetimes = parsed["schedule_datetimes"]

    print("File List:", file_list)
    print("Account List:", account_list)

    try:
        match type:
            case 1:
                post_video_xhs(
                    title, file_list, tags, account_list, category, enableTimer, videos_per_day, daily_times,
                    start_days, desc=description, thumbnail_path=thumbnail_path, schedule_datetimes=schedule_datetimes,
                )
            case 2:
                post_video_tencent(
                    title, file_list, tags, account_list, category, enableTimer, videos_per_day, daily_times,
                    start_days, is_draft, desc=description, schedule_datetimes=schedule_datetimes,
                )
            case 3:
                post_video_DouYin(
                    title, file_list, tags, account_list, category, enableTimer, videos_per_day, daily_times,
                    start_days, thumbnail_path, productLink, productTitle, desc=description, schedule_datetimes=schedule_datetimes,
                )
            case 4:
                post_video_ks(
                    title, file_list, tags, account_list, category, enableTimer, videos_per_day, daily_times,
                    start_days, desc=description, thumbnail_path=thumbnail_path, schedule_datetimes=schedule_datetimes,
                )
            case _:
                return jsonify({"code": 400, "msg": f"不支持的平台类型: {type}", "data": None}), 400

        # 返回响应给客户端
        record_publish_history(
            type, title, file_list, account_list, tags,
            enableTimer, videos_per_day, daily_times, start_days,
            is_draft, 'success', '发布任务已提交', schedule_datetimes=schedule_datetimes
        )
        return jsonify(
            {
                "code": 200,
                "msg": "发布任务已提交",
                "data": None
            }), 200
    except Exception as e:
        print(f"发布视频时出错: {str(e)}")
        try:
            record_publish_history(
                type, title, file_list, account_list, tags,
                enableTimer, videos_per_day, daily_times, start_days,
                is_draft, 'error', str(e), schedule_datetimes=schedule_datetimes
            )
        except Exception:
            pass
        return jsonify({
            "code": 500,
            "msg": f"发布失败: {str(e)}",
            "data": None
        }), 500


@app.route('/updateUserinfo', methods=['POST'])
def updateUserinfo():
    # 获取JSON数据
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"code": 400, "msg": "请求体必须为 JSON 对象", "data": None}), 400

    # 从JSON数据中提取并严格校验 id、type 和 userName
    user_id = data.get('id')
    if isinstance(user_id, bool) or not isinstance(user_id, int) or user_id <= 0:
        return jsonify({"code": 400, "msg": "非法账号 ID", "data": None}), 400

    platform_type = data.get('type')
    if isinstance(platform_type, bool) or not isinstance(platform_type, int) or platform_type not in (1, 2, 3, 4):
        return jsonify({"code": 400, "msg": f"不支持的平台类型: {platform_type}", "data": None}), 400

    raw_user_name = data.get('userName')
    if not isinstance(raw_user_name, str) or not raw_user_name.strip():
        return jsonify({"code": 400, "msg": "账号名称不能为空", "data": None}), 400
    userName = raw_user_name.strip()

    try:
        # 获取数据库连接
        with sqlite3.connect(Path(BASE_DIR / "db" / "database.db")) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()

            # 更新数据库记录
            cursor.execute('''
                           UPDATE user_info
                           SET type     = ?,
                               userName = ?
                           WHERE id = ?;
                           ''', (platform_type, userName, user_id))
            updated_rows = cursor.rowcount
            conn.commit()

        if updated_rows == 0:
            return jsonify({
                "code": 404,
                "msg": "账号不存在",
                "data": None
            }), 404

        return jsonify({
            "code": 200,
            "msg": "account update successfully",
            "data": None
        }), 200

    except Exception:
        return jsonify({
            "code": 500,
            "msg": "update failed!",
            "data": None
        }), 500

@app.route('/postVideoBatch', methods=['POST'])
def postVideoBatch():
    data_list = request.get_json(silent=True)

    if not isinstance(data_list, list) or len(data_list) == 0:
        return jsonify({"code": 400, "msg": "Expected a non-empty JSON array", "data": None}), 400
    validated_items = []
    for data in data_list:
        parsed, err = _validate_post_payload(data)
        if err:
            return jsonify({"code": 400, "msg": err, "data": None}), 400
        validated_items.append(parsed)

    for parsed in validated_items:
        file_list = parsed["file_list"]
        account_list = parsed["account_list"]
        type = parsed["type"]
        title = parsed["title"]
        description = parsed["description"]
        tags = parsed["tags"]
        category = parsed["category"]
        enableTimer = parsed["enable_timer"]
        productLink = parsed["product_link"]
        productTitle = parsed["product_title"]
        thumbnail_path = parsed["thumbnail_path"]
        is_draft = parsed["is_draft"]
        videos_per_day = parsed["videos_per_day"]
        daily_times = parsed["daily_times"]
        start_days = parsed["start_days"]
        schedule_datetimes = parsed["schedule_datetimes"]
        print("File List:", file_list)
        print("Account List:", account_list)
        try:
            match type:
                case 1:
                    post_video_xhs(
                        title, file_list, tags, account_list, category, enableTimer, videos_per_day, daily_times,
                        start_days, desc=description, thumbnail_path=thumbnail_path, schedule_datetimes=schedule_datetimes,
                    )
                case 2:
                    post_video_tencent(
                        title, file_list, tags, account_list, category, enableTimer, videos_per_day, daily_times,
                        start_days, is_draft, desc=description, schedule_datetimes=schedule_datetimes,
                    )
                case 3:
                    post_video_DouYin(
                        title, file_list, tags, account_list, category, enableTimer, videos_per_day, daily_times,
                        start_days, thumbnail_path, productLink, productTitle, desc=description, schedule_datetimes=schedule_datetimes,
                    )
                case 4:
                    post_video_ks(
                        title, file_list, tags, account_list, category, enableTimer, videos_per_day, daily_times,
                        start_days, desc=description, thumbnail_path=thumbnail_path, schedule_datetimes=schedule_datetimes,
                    )
                case _:
                    return jsonify({"code": 400, "msg": f"Unsupported platform type: {type}", "data": None}), 400
            record_publish_history(
                type, title, file_list, account_list, tags,
                enableTimer, videos_per_day, daily_times, start_days,
                is_draft, 'success', '批量发布任务已提交', schedule_datetimes=schedule_datetimes
            )
        except Exception as e:
            try:
                record_publish_history(
                    type, title, file_list, account_list, tags,
                    enableTimer, videos_per_day, daily_times, start_days,
                    is_draft, 'error', str(e), schedule_datetimes=schedule_datetimes
                )
            except Exception:
                pass
            return jsonify({
                "code": 500,
                "msg": f"批量发布失败: {str(e)}",
                "data": None
            }), 500
    # 返回响应给客户端
    return jsonify(
        {
            "code": 200,
            "msg": None,
            "data": None
        }), 200


@app.route('/getPublishHistory', methods=['GET'])
def get_publish_history():
    ensure_runtime_ready()
    try:
        raw_limit = int(request.args.get('limit', 50) or 50)
    except (TypeError, ValueError):
        raw_limit = 50
    limit = min(max(raw_limit, 1), 200)
    platform_map = {1: '小红书', 2: '视频号', 3: '抖音', 4: '快手'}
    db_path = Path(BASE_DIR / "db" / "database.db")
    with sqlite3.connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        rows = cursor.execute(
            '''
            SELECT id, platform_type, title, file_list, account_list, tags,
                   enable_timer, schedule_summary, is_draft, status, message, created_at
            FROM publish_records
            ORDER BY id DESC
            LIMIT ?
            ''',
            (limit,),
        ).fetchall()
    result = []
    for row in rows:
        item = dict(row)
        item['platform_name'] = platform_map.get(item['platform_type'], f"平台({item['platform_type']})")
        for field in ('file_list', 'account_list', 'tags'):
            try:
                item[field] = json.loads(item[field] or '[]')
            except Exception:
                item[field] = []
        result.append(item)
    return jsonify({"code": 200, "msg": "success", "data": result}), 200


@app.route('/deletePublishRecord', methods=['GET'])
def delete_publish_record():
    ensure_runtime_ready()
    record_id = (request.args.get('id') or '').strip()
    if not record_id or not record_id.isdigit() or int(record_id) <= 0:
        return jsonify({"code": 400, "msg": "非法记录 ID", "data": None}), 400
    db_path = Path(BASE_DIR / "db" / "database.db")
    with sqlite3.connect(db_path) as conn:
        cursor = conn.cursor()
        cursor.execute("DELETE FROM publish_records WHERE id = ?", (int(record_id),))
        deleted = cursor.rowcount
        conn.commit()
    if deleted == 0:
        return jsonify({"code": 404, "msg": "记录不存在", "data": None}), 404
    return jsonify({"code": 200, "msg": "删除成功", "data": None}), 200


@app.route('/getTitleTemplates', methods=['GET'])
def get_title_templates():
    ensure_runtime_ready()
    category = (request.args.get('category') or '').strip()
    keyword = (request.args.get('keyword') or '').strip()
    db_path = Path(BASE_DIR / "db" / "database.db")
    with sqlite3.connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        sql = "SELECT id, category, title, tags, note, use_count, created_at FROM title_templates WHERE 1=1"
        params = []
        if category and category != '全部':
            sql += " AND category = ?"
            params.append(category)
        if keyword:
            sql += " AND (title LIKE ? ESCAPE '\\' OR note LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\')"
            like = f"%{_escape_like(keyword)}%"
            params.extend([like, like, like])
        sql += " ORDER BY id DESC"
        rows = cursor.execute(sql, params).fetchall()
    items = []
    for row in rows:
        item = dict(row)
        try:
            item['tags'] = json.loads(item['tags'] or '[]')
        except Exception:
            item['tags'] = []
        items.append(item)
    return jsonify({"code": 200, "msg": "success", "data": items}), 200


@app.route('/saveTitleTemplate', methods=['POST'])
def save_title_template():
    ensure_runtime_ready()
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"code": 400, "msg": "请求体必须为 JSON 对象", "data": None}), 400

    raw_tpl_id = data.get('id')
    tpl_id = None
    if raw_tpl_id is not None and raw_tpl_id != '':
        if isinstance(raw_tpl_id, bool) or not isinstance(raw_tpl_id, int) or raw_tpl_id <= 0:
            return jsonify({"code": 400, "msg": "非法模板 ID", "data": None}), 400
        tpl_id = raw_tpl_id

    raw_category = data.get('category')
    category = raw_category.strip() if isinstance(raw_category, str) and raw_category.strip() else '通用'
    raw_title = data.get('title')
    if not isinstance(raw_title, str) or not raw_title.strip():
        return jsonify({"code": 400, "msg": "标题内容不能为空", "data": None}), 400
    title = raw_title.strip()
    raw_note = data.get('note')
    note = raw_note.strip() if isinstance(raw_note, str) else ''

    raw_tags = data.get('tags') or []
    if isinstance(raw_tags, str):
        tags = [t.strip().lstrip('#') for t in raw_tags.replace('，', ',').split(',') if t.strip()]
    elif isinstance(raw_tags, list):
        tags = [str(t).strip().lstrip('#') for t in raw_tags if str(t).strip()]
    else:
        tags = []

    db_path = Path(BASE_DIR / "db" / "database.db")
    with sqlite3.connect(db_path) as conn:
        cursor = conn.cursor()
        if tpl_id is not None:
            cursor.execute(
                "UPDATE title_templates SET category = ?, title = ?, tags = ?, note = ? WHERE id = ?",
                (category, title, json.dumps(tags, ensure_ascii=False), note, tpl_id),
            )
            if cursor.rowcount == 0:
                return jsonify({"code": 404, "msg": "模板不存在", "data": None}), 404
        else:
            cursor.execute(
                "INSERT INTO title_templates (category, title, tags, note) VALUES (?, ?, ?, ?)",
                (category, title, json.dumps(tags, ensure_ascii=False), note),
            )
            tpl_id = cursor.lastrowid
        conn.commit()
    return jsonify({"code": 200, "msg": "保存成功", "data": {"id": tpl_id}}), 200


@app.route('/deleteTitleTemplate', methods=['GET'])
def delete_title_template():
    ensure_runtime_ready()
    tpl_id = (request.args.get('id') or '').strip()
    if not tpl_id or not tpl_id.isdigit() or int(tpl_id) <= 0:
        return jsonify({"code": 400, "msg": "非法模板 ID", "data": None}), 400
    db_path = Path(BASE_DIR / "db" / "database.db")
    with sqlite3.connect(db_path) as conn:
        cursor = conn.cursor()
        cursor.execute("DELETE FROM title_templates WHERE id = ?", (int(tpl_id),))
        deleted = cursor.rowcount
        conn.commit()
    if deleted == 0:
        return jsonify({"code": 404, "msg": "模板不存在", "data": None}), 404
    return jsonify({"code": 200, "msg": "删除成功", "data": None}), 200

# Cookie文件上传API
@app.route('/uploadCookie', methods=['POST'])
def upload_cookie():
    try:
        if 'file' not in request.files:
            return jsonify({
                "code": 400,
                "msg": "没有找到Cookie文件",
                "data": None
            }), 400

        file = request.files['file']
        if file.filename == '':
            return jsonify({
                "code": 400,
                "msg": "Cookie文件名不能为空",
                "data": None
            }), 400

        if not file.filename.endswith('.json'):
            return jsonify({
                "code": 400,
                "msg": "Cookie文件必须是JSON格式",
                "data": None
            }), 400

        # 获取账号信息
        account_id = request.form.get('id')
        platform = request.form.get('platform')

        if not account_id or not platform:
            return jsonify({
                "code": 400,
                "msg": "缺少账号ID或平台信息",
                "data": None
            }), 400

        # 从数据库获取账号的文件路径
        with sqlite3.connect(Path(BASE_DIR / "db" / "database.db")) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()
            cursor.execute('SELECT filePath FROM user_info WHERE id = ?', (account_id,))
            result = cursor.fetchone()

        if not result:
            return jsonify({
                "code": 500,
                "msg": "账号不存在",
                "data": None
            }), 404

        # 保存上传的Cookie文件到对应路径
        cookie_file_path = Path(BASE_DIR / "cookiesFile" / result['filePath'])
        cookie_file_path.parent.mkdir(parents=True, exist_ok=True)

        file.save(str(cookie_file_path))

        # 更新数据库中的账号信息（可选，比如更新更新时间）
        # 这里可以根据需要添加额外的处理逻辑

        return jsonify({
            "code": 200,
            "msg": "Cookie文件上传成功",
            "data": None
        }), 200

    except Exception as e:
        print(f"上传Cookie文件时出错: {str(e)}")
        return jsonify({
            "code": 500,
            "msg": f"上传Cookie文件失败: {str(e)}",
            "data": None
        }), 500


# Cookie文件下载API
@app.route('/downloadCookie', methods=['GET'])
def download_cookie():
    try:
        file_path = request.args.get('filePath')
        if not file_path:
            return jsonify({
                "code": 500,
                "msg": "缺少文件路径参数",
                "data": None
            }), 400

        # 验证文件路径的安全性，防止路径遍历攻击
        cookie_file_path = Path(BASE_DIR / "cookiesFile" / file_path).resolve()
        base_path = Path(BASE_DIR / "cookiesFile").resolve()

        if not cookie_file_path.is_relative_to(base_path):
            return jsonify({
                "code": 500,
                "msg": "非法文件路径",
                "data": None
            }), 400

        if not cookie_file_path.exists():
            return jsonify({
                "code": 500,
                "msg": "Cookie文件不存在",
                "data": None
            }), 404

        # 返回文件
        return send_from_directory(
            directory=str(cookie_file_path.parent),
            path=cookie_file_path.name,
            as_attachment=True
        )

    except Exception as e:
        print(f"下载Cookie文件时出错: {str(e)}")
        return jsonify({
            "code": 500,
            "msg": f"下载Cookie文件失败: {str(e)}",
            "data": None
        }), 500


# 包装函数：在线程中运行异步函数
def run_async_function(type,id,status_queue):
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        match type:
            case '1':
                loop.run_until_complete(xiaohongshu_cookie_gen(id, status_queue))
            case '2':
                loop.run_until_complete(get_tencent_cookie(id, status_queue))
            case '3':
                loop.run_until_complete(douyin_cookie_gen(id, status_queue))
            case '4':
                loop.run_until_complete(get_ks_cookie(id, status_queue))
            case _:
                status_queue.put("500")
    except Exception as e:
        print(f"❌ 登录任务异常 (type={type}, id={id}): {e}")
        status_queue.put("500")
    finally:
        loop.close()

# SSE 流生成器函数（超时设为 300 秒，略高于后台 270 秒轮询，确保后端能返回明确结果）
def sse_stream(status_queue, queue_key=None, timeout_seconds=300):
    deadline = time.monotonic() + timeout_seconds
    last_keepalive = time.monotonic()
    try:
        while time.monotonic() < deadline:
            try:
                msg = status_queue.get(timeout=0.5)
            except Empty:
                if time.monotonic() - last_keepalive >= 15:
                    yield ": keepalive\n\n"
                    last_keepalive = time.monotonic()
                continue

            if msg is None:
                continue
            msg_str = str(msg)
            yield f"data: {msg_str}\n\n"
            if msg_str in {"200", "500"}:
                return

        yield "data: 500\n\n"
    finally:
        if queue_key:
            with active_queues_lock:
                active_queues.pop(queue_key, None)

if __name__ == '__main__':
    ensure_runtime_ready()
    # 默认仅监听本地回环地址并启用多线程，防止 SSE 登录流阻塞常规请求
    bind_host = os.environ.get('SAU_HOST', '127.0.0.1')
    bind_port = int(os.environ.get('SAU_PORT', '5409'))
    app.run(host=bind_host, port=bind_port, threaded=True)
