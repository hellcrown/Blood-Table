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
# 必须用 npm ci 而不是 npm install：npm install 会**重写被跟踪的 package-lock.json**，
# 把线上部署目录变成「工作区有本地修改」。而线上仓库用的是 receive.denyCurrentBranch=updateInstead，
# 工作区一脏，此后所有**改到 lock 文件的推送**都会被拒，报错只有
#   Entry 'package-lock.json' not uptodate. Cannot merge. / Could not update working tree to new HEAD
# ——既不说谁改的，也不说怎么修（若再被 skip-worktree 位掩盖，连 git status 都显示干净）。
# npm ci 只按 lock 安装、从不写 lock，也更快、可复现。
echo "安装依赖..."
if ! npm ci --no-audit --no-fund; then
  echo "❌ npm ci 失败：通常是 package-lock.json 与 package.json 不同步。"
  echo "   请在**本地**执行 npm install 并把更新后的 package-lock.json 提交推送，再重新部署。"
  echo "   （不要在服务器上跑 npm install：那会改脏工作区，导致后续推送被 updateInstead 拒绝）"
  exit 1
fi
# 兜底断言：本次部署不应改动被跟踪的 lock 文件
if ! git diff --quiet -- package-lock.json 2>/dev/null; then
  echo "⚠️ package-lock.json 在部署后发生了变化：请勿在服务器上执行 npm install，否则后续推送会被拒"
fi

# 3. 管理密码（网站「管理员」入口用）：保存在 .admin-secret，可自行修改
# 用 umask 077 创建：默认 umask 下会得到 0644（全局可读）——该 key 可读取全部玩家反馈（含 IP）
# 并一键清空全服房间；对已存在的旧文件同样 chmod 收权
SECRET_FILE=".admin-secret"
if [ ! -f "$SECRET_FILE" ] || [ ! -s "$SECRET_FILE" ]; then
  ( umask 077 && { openssl rand -hex 12 > "$SECRET_FILE" 2>/dev/null || node -e "console.log(require('crypto').randomBytes(12).toString('hex'))" > "$SECRET_FILE"; } )
fi
chmod 600 "$SECRET_FILE" 2>/dev/null || true
ADMIN_KEY_VALUE=$(cat "$SECRET_FILE")

# 4. 启动 / 重启（进程名 blood-table）
PORT="${PORT:-3000}"
# 千人并发连接需要大量 fd，Ubuntu 默认软上限 1024 会先爆（EMFILE）；pm2 守护进程继承本 shell 限制，
# 若守护进程已按旧限制运行，需先 `pm2 kill` 再重新执行本脚本
ulimit -n 65535 2>/dev/null || ulimit -n "$(ulimit -H)" 2>/dev/null || true

# 4.5 排水（drain）：写入标记 → 服务器向进行中对局广播更新公告 → 等待对局自然结束后再重启。
# 跳过：DEPLOY_NO_DRAIN=1 bash deploy.sh 或 bash deploy.sh --now；上限：DEPLOY_DRAIN_MAX 秒（默认 900）
# trap 必须先于排水块安装：等待期间 Ctrl+C 否则会把标记留在磁盘上（此后每局新开局都收假公告）
trap 'rm -f server/.draining' EXIT
trap 'rm -f server/.draining; exit 130' INT TERM
if [ "${1:-}" != "--now" ] && [ "${DEPLOY_NO_DRAIN:-}" != "1" ] && curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
  touch server/.draining # 与服务端 DRAIN_MARKER（cwd=server/）一致
  DRAIN_MAX="${DEPLOY_DRAIN_MAX:-900}"
  DRAIN_WAITED=0
  echo "⏳ 检测到部署排水模式：等待进行中的对局结束（上限 ${DRAIN_MAX}s，Ctrl+C 放弃等待；DEPLOY_NO_DRAIN=1 可跳过）"
  while :; do
    GAMES=$(curl -sf "http://127.0.0.1:$PORT/api/health" | grep -o '"games":[0-9]*' | grep -o '[0-9]*' || echo 0)
    if [ "${GAMES:-0}" = "0" ]; then
      echo "✅ 所有对局已结束（等待 ${DRAIN_WAITED}s），继续部署"
      break
    fi
    if [ "$DRAIN_WAITED" -ge "$DRAIN_MAX" ]; then
      echo "⚠️ 等待超时（${DRAIN_WAITED}s）仍有 $GAMES 场对局进行：强制重启"
      break
    fi
    sleep 10
    DRAIN_WAITED=$((DRAIN_WAITED + 10))
  done
fi
rm -f server/.draining

pm2 delete blood-table >/dev/null 2>&1 || true
PORT="$PORT" ADMIN_KEY="$ADMIN_KEY_VALUE" pm2 start npm --name blood-table -- start
pm2 save

# 5. 日志轮转（防止 pm2 日志无限膨胀）
# 固定版本而非 @latest：部署行为不该随上游发布漂移；且放在 pm2 start **之前**，
# 否则首次部署到轮转装好之间的日志是裸奔的（此前顺序相反）。
# 失败不阻断部署但必须留痕：该服务器出网不稳，npx 拉不到模块时若无输出，
# 轮转会静默缺失、pm2 日志回到无限膨胀——恰是本步要防的后果
if ! npx --yes pm2-logrotate@3 >/tmp/pm2-logrotate-install.log 2>&1; then
  echo "⚠️ pm2-logrotate 安装失败（日志轮转未生效，详见 /tmp/pm2-logrotate-install.log），不阻断部署"
fi

echo ""
echo "✅ 部署完成：http://<服务器IP>:$PORT"
echo "   - 别忘了在云控制台「安全组」放行 TCP $PORT（生产环境建议只放行 22/80/443，"
echo "     由 nginx 反代到本机 3000，见 README「云服务器部署」）"
echo "   - 网站左下角「管理员」入口的管理密码**不再回显**（避免出现在终端记录/CI 日志里）："
echo "     查看：cat $(pwd)/$SECRET_FILE     修改后重新执行本脚本即生效"
echo "   - 常用命令：pm2 logs blood-table ｜ pm2 restart blood-table ｜ pm2 stop blood-table"
echo "   - 更新代码后重新执行 bash deploy.sh 即可（或本机 push 后 bloodtable deploy）"
