# 新电脑可选：一键安装最新版 MediaCrawler 到 ./tools/MediaCrawler（用于抖音/B站热评深采）
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$target = Join-Path $root 'tools\MediaCrawler'

if (-not (Test-Path $target)) {
  Write-Host '[1/3] 正在克隆最新版 NanmiCoder/MediaCrawler ...'
  git clone --depth 1 https://github.com/NanmiCoder/MediaCrawler.git $target
} else {
  Write-Host '[1/3] 已存在 tools/MediaCrawler，拉取最新代码...'
  git -C $target pull --ff-only
}

Set-Location $target
if (Get-Command uv -ErrorAction SilentlyContinue) {
  Write-Host '[2/3] 检测到 uv，正在创建隔离环境并安装依赖...'
  uv sync
} else {
  Write-Host '[2/3] 正在使用 Python venv 安装依赖...'
  python -m venv .venv
  & '.venv\Scripts\python.exe' -m pip install -r requirements.txt
}

Write-Host '[3/3] 正在确认 Playwright Chromium 浏览器...'
& '.venv\Scripts\python.exe' -m playwright install chromium

Write-Host "MediaCrawler 安装完成！路径：$target（工作台会自动识别，无需单独启动 8089 端口）"
