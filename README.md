# 血色牌局 · 联机版（2-4 人）

还原桌游《血色牌局》的联机实现 + 经典德州扑克模式，Web 网页版，局域网/Tailscale 开服即玩。

- **血色牌局模式**（主模式，按 `rulebook/RULES.md` 严格还原）：
  每人一副 54 张牌，8 阶段回合制（抽牌→换牌→出牌→对决→结算→购买→删牌→重整），
  暗扣 5 张同时亮牌比牌型（含 JOKER/强化芯片合成的五条~七条等扩展牌型），
  黑市购买强化芯片/道具/秘密交易，血筹为货币、车票为胜利目标（2/3/4 人局 24/20/16），
  临时特权证决定行动顺序与额外换牌次数。角色技能暂未实现（见 RULES.md 存疑项）。
- **经典德州扑克模式**：完整德扑规则（盲注/边池/单挑特例等），建房时可切换。

## 运行

要求 Node.js ≥ 20。

```bash
npm install        # 首次安装依赖（workspaces: server + client）

npm run dev        # 开发模式：服务端 :3000 + 前端 Vite :5173（浏览器访问 5173）

npm run build      # 构建前端到 client/dist
npm start          # 生产模式：单端口 :3000 同时提供网页和 WebSocket（联机用这个）
```

`npm start` 会打印本机地址（含 Tailscale 地址）。建房时选择模式与人数上限（2/3/4），
把房间码告诉朋友即可。所有阶段 60 秒超时托管，断线重连自动恢复座位与手牌。

## 外网联机（Tailscale）

和不在同一局域网的朋友玩，用 [Tailscale](https://tailscale.com) 组虚拟局域网（免费，3 用户 100 设备）：

1. **你和朋友各自**下载安装 Tailscale（Windows/macOS/手机都有），登录各自账号；
2. 你在 https://login.tailscale.com 管理页 → Users → **邀请朋友**（或 Machines → 你的电脑 → Share）；
3. 你的电脑保持 Tailscale 在线并 `npm start`，建房后房间页「邀请好友」区会显示你的 **`100.x.x.x` Tailscale 地址**（点击即复制），朋友浏览器打开它 + 输房间码即玩。

Windows 防火墙需放行 Tailscale 网段（管理员 PowerShell/CMD 执行一次即可）：

```
netsh advfirewall firewall add rule name="血色牌局3000(Tailscale)" dir=in action=allow protocol=TCP localport=3000 remoteip=100.64.0.0/10
```

注意：服务端跑在你的电脑上，你关机/掉线朋友就进不来；想 24 小时在线可改走云服务器部署。

## 血色牌局模式速览

- **每人独立 54 张牌堆**（含大小王），初始构筑两轮「抽 8 删 ≤4」
- 每回合 8 阶段：抽牌（至手牌上限 6）→ 换牌（默认 3 次，特权证 4 次，未用次数兑 1 血筹/次）→
  出牌（暗扣 5 张，界面上实时显示当前牌型）→ 对决（亮牌宣告）→
  结算（牌型 → 5 张总点数 → 离特权证顺时针最近；按名次发车票/血筹）→
  购买（黑市五格，买/跳过循环，右两格叠 1 血筹）→ 删牌（免费 1 张 + 2 血筹/张）→
  重整（重洗牌库 或 +2 血筹）
- 强化芯片可把牌改点/改花色/造出五条~七条/触发血筹效果；备用道具（荷官证）可翻转比较规则；
  秘密交易买后立即结算
- 集齐目标车票立即获胜；平局比血筹、再比特权证距离；房主可「再来一场」
- 完整规则与黑市 57 张卡表见 `rulebook/RULES.md`

## 经典德州扑克模式速览

- 标准 2-4 人：盲注轮转（2 人单挑庄家即小盲）、最小加注、不足额全下不重开行动权、边池切分
- 默认盲注 5/10、初始筹码 1000，房主可改；筹码打光即出局，最后留在桌上者胜

## 项目结构

```
shared/src/
  protocol.ts             前后端共享的 WS 消息与类型
  bloodCards.ts           黑市牌定义（24 种 57 张，数据驱动）
  bloodEval.ts            血色对决评估器（前后端共用，出牌实时牌型提示）
server/src/
  blood/                  血色模式引擎（8 阶段状态机/视图/超时托管）
  game/                   经典德扑引擎
  rooms.ts                房间、会话、重连、广播、计时
  index.ts                HTTP + WebSocket 服务、静态托管、心跳
  test/                   单元测试 + 随机整场模拟 + WS 端到端冒烟
client/src/
  net/socket.ts           WS 客户端、自动重连、token 管理
  pages/Lobby|Room|Table|BloodTable
  components/             卡牌、座位、操作栏、结算浮层、日志
```

服务端为权威服务器：规则判定全在服务端，私有信息（手牌/牌堆/弃牌区）只下发给所有者。

## 测试

```bash
npm test           # 59 个用例：德扑回归 34 + 血色评估器 19 + 血色引擎流程 5 + 随机整场模拟
```

端到端脚本（先启动服务器）：

```bash
cd server && npx tsx test/bloodSmoke.ts   # 血色模式 2 机器人完整对局到车票胜利
cd server && npx tsx test/smoke.ts        # 经典模式联机 + 断线重连
```

## 已知限制

- 对局状态在内存中，服务器进程重启后进行中的对局会丢失
- 浏览器后台标签页可能被系统挂起导致连接中断，回到前台刷新页面即可恢复
- 血色模式的角色技能、事件牌尚未实现（数据结构已预留）；观战/AI 补位未做

## 云服务器部署

1. 购买任意云服务器（2核1G 起步即可），系统镜像选 **Ubuntu 22.04**，安全组放行 TCP 22 与 3000；
2. SSH 登录后安装 Node 20+ 与 git，然后：
   ```bash
   git clone https://github.com/hellcrown/Blood-Table.git
   cd Blood-Table
   bash deploy.sh
   ```
3. 访问 `http://服务器IP:3000` 即可游玩；代码更新后 `git pull && bash deploy.sh` 一键重启。

说明：前端构建产物 `client/dist` 已随仓库提交，服务器上无需构建（1G 内存小机也跑得动）；
`deploy.sh` 使用 pm2 守护进程并开机自启（`pm2 save` 后执行一次 `pm2 startup` 按提示操作）。
