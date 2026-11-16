@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] 未检测到 Node.js，请先安装 Node.js 22.13+ 或 24+ 后再运行。
  pause
  exit /b 1
)
if not exist "node_modules" (
  echo [1/3] 首次启动，正在安装后端依赖...
  call npm install --no-audit --no-fund
  if errorlevel 1 pause & exit /b 1
)
if not exist "frontend\node_modules" (
  echo [2/3] 首次启动，正在安装前端依赖...
  call npm --prefix frontend install --no-audit --no-fund
  if errorlevel 1 pause & exit /b 1
)
if not exist "dist\server.js" (
  echo [3/3] 正在编译工作台...
  call npm run build
  if errorlevel 1 pause & exit /b 1
)
if not exist "frontend\dist\index.html" (
  echo [3/3] 正在编译前端界面...
  call npm run build:ui
  if errorlevel 1 pause & exit /b 1
)
node scripts\start.mjs
