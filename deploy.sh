#!/usr/bin/env bash
# 云服务器一键部署 / 更新（在仓库根目录执行：bash deploy.sh）
# 流程：安装依赖 → 用 pm2 启动（已存在则重启）→ 开机说明见 README「云服务器部署」
set -e
cd "$(dirname "$0")"

# 1. 环境检查
if ! command -v node >/dev/null 2>&1; then
  echo "❌ 未安装 Node.js（需 20+）。Ubuntu 安装命令："
  echo "   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs"
  exit 1
fi
if ! command -v pm2 >/dev/null 2>&1; then
  echo "安装 pm2 进程守护..."
  sudo npm i -g pm2
fi

# 2. 安装依赖（服务端仅需 tsx + ws，dist 前端产物已随仓库提交，无需在服务器构建）
echo "安装依赖..."
npm install --no-audit --no-fund

# 3. 启动 / 重启（进程名 blood-table）
PORT="${PORT:-3000}"
pm2 delete blood-table >/dev/null 2>&1 || true
PORT="$PORT" pm2 start npm --name blood-table -- start
pm2 save

echo ""
echo "✅ 部署完成：http://<服务器IP>:$PORT"
echo "   - 别忘了在云控制台「安全组」放行 TCP $PORT"
echo "   - 常用命令：pm2 logs blood-table ｜ pm2 restart blood-table ｜ pm2 stop blood-table"
echo "   - 更新代码后重新执行 bash deploy.sh 即可"
