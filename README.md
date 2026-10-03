# 血色牌局 · 联机版（2-4 人）

还原桌游《血色牌局》的联机实现 + 经典德州扑克模式，Web 网页版，云服务器/局域网开服即玩。
目前已经部署在云服务器，点击 https://blood-table.top 开玩

## 在线游玩（现成服务器）

**https://blood-table.top** —— 打开即玩：创建房间后把「网址 + 房间码」发给朋友，
朋友打开网址、粘贴房间码即可加入。无需安装任何东西。

- **血色牌局模式**（主模式，按 `rulebook/RULES.md` 严格还原）：
  每人一副 54 张牌，8 阶段回合制（抽牌→换牌→出牌→对决→结算→购买→删牌→重整），
  暗扣 5 张同时亮牌比牌型（含 JOKER/强化芯片合成的五条~七条等扩展牌型），
  黑市购买强化芯片/道具/秘密交易，血筹为货币、车票为胜利目标（2/3/4 人局 24/20/16，房主可自定义 8-30），
  临时特权证决定行动顺序与额外换牌次数。全部 58 名角色技能均已自动化（拓展角色含少量交互流程，见角色详情内的实装说明）。
  内置速攻计分变体：**抢跑**（本局首个夺魁额外 +1🎫）与**连胜**（连续回合夺魁从第二连起每次 +1🎫），
  奖励前几轮连打建立胜势的速攻打法，制衡芯片发育流。
- **经典德州扑克模式**：完整德扑规则（盲注/边池/单挑特例等），建房时可切换。

## 运行

要求 Node.js ≥ 20。

```bash
npm install        # 首次安装依赖（workspaces: server + client）

npm run dev        # 开发模式：服务端 :3000 + 前端 Vite :5173（浏览器访问 5173）

npm run build      # 构建前端到 client/dist
npm start          # 生产模式：单端口 :3000 同时提供网页和 WebSocket（联机用这个）
```

本地试玩时浏览器打开 `http://localhost:3000`。建房时选择模式、人数上限、拓展选将与拓展黑市开关
（开局必定角色：角色牌足够时每人随机 2 张选 1——拓展选将开启后 3/4 人局同样可选将，基础池 3/4 人局随机分配 1 名），
把网址和房间码发给朋友即可。所有阶段 60 秒超时托管，断线重连自动恢复座位与手牌。

## 安全（公网开放）

服务面向公网开放（无需账号即可游玩），内置滥用防护：
消息大小上限 16KB、全局/单 IP 连接数与新建连接频率限制、每连接消息限速（超速丢弃、持续洪泛断开）、
房间总数与单 IP 建房数配额、加入尝试限速（防房间码枚举）、昵称清洗与重名后缀、房主请离玩家、
空房自动回收（换房/离场即时清理，无泄漏）。服务器建议配合防火墙（Web 服务器仅放行 22/80/443，
应用端口 3000 限本机访问）与 `pm2-logrotate` 使用。

线上服务器架构：nginx 反代 443 → 本机 3000（`deploy/nginx-blood-table.conf`），
HTTPS 证书由 certbot（Let's Encrypt）签发并自动续期，80 强制跳转 443；
客户端按页面协议自动使用 ws/wss，无需区分。

## 云服务器部署

推荐直接部署在云服务器上（2核1G 起步，Ubuntu 22.04/24.04），所有玩家直连、无需任何组网工具：

```bash
# 服务器上（安全组放行 TCP 22 与 3000）
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs git && sudo npm i -g pm2
git clone https://github.com/hellcrown/Blood-Table.git
cd Blood-Table && bash deploy.sh
```

访问 `http://服务器IP:3000` 即玩；更新版本：`git pull && bash deploy.sh`。

> **发版后玩家侧感知**：服务端 `GET /api/version` 下发「服务器上跑的是哪一条更新日志」
> （取自 `shared/src/changelog.ts` 的最新条目），前端每 5 分钟 / 回到前台时比对一次：
> 发现服务器那条日志的**日期**比页面打包的日期新，就在大厅顶部弹出「🆕 新版本已发布」横幅与「立即刷新」按钮——
> 仍开着旧页面（浏览器缓存里的旧 JS）的玩家由此能明确知道该刷新了，而不是靠运气。
> 天数相同的两次发版不提示（无从判断谁在前，宁可漏报也不让所有人白刷一次），此时靠下一条。
> 玩家没读过的更新日志另在「📜 更新日志」入口显示角标，点开即消。
>
> **更新日志的写作口径**：`shared/src/changelog.ts` 是给**玩家**看的，只写玩家看得见、用得上的变化；
> 命令、部署、仓库、接口、限流参数、管理端功能等开发/运维细节写在本 README 与提交记录里，不要写进日志。
> `server/test/changelog.test.ts` 用开发者词汇黑名单守着这条口径（并有「黑名单确实有牙」的用例防止守卫退化）。

> **更新与进行中对局**：deploy.sh 默认进入「排水」模式——先向所有进行中的对局广播更新公告，等待对局自然结束（上限 900 秒，超时强制重启）再重启服务。`DEPLOY_NO_DRAIN=1 bash deploy.sh` 或 `bash deploy.sh --now` 可跳过等待；`DEPLOY_DRAIN_MAX=1800` 可调上限。重启会清空内存中的对局状态（玩家会被送回大厅）。
前端构建产物 `client/dist` 已随仓库提交，服务器无需构建（1G 内存小机可跑）。
建仓后执行一次 `pm2 save && pm2 startup` 可开机自启。

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
  changelog.ts            更新日志（前端渲染 + 服务端 /api/version 的版本比对口径）
  bloodCards.ts           黑市牌定义（基础 25 种 57 张，拓展黑市另 27 种 55 张，数据驱动）
  bloodEval.ts            血色对决评估器（前后端共用，出牌实时牌型提示）
server/src/
  blood/                  血色模式引擎（8 阶段状态机/视图/超时托管）
  game/                   经典德扑引擎
  rooms.ts                房间、会话、重连、广播、计时
  index.ts                HTTP + WebSocket 服务、静态托管、心跳
server/test/              单元测试 + 随机整场模拟 + WS 端到端冒烟
client/src/
  net/socket.ts           WS 客户端、自动重连、token 管理
  net/version.ts          版本提示（旧包检测 + 更新日志未读标记）
  pages/Lobby|Room|Table|BloodTable
  components/             卡牌、座位、操作栏、结算浮层、日志
bin/bloodtable            服务器运维命令（update/restart/logs/clear/status…）
```

服务端为权威服务器：规则判定全在服务端，私有信息（手牌/牌堆/弃牌区）只下发给所有者。

## 测试

```bash
npm test           # 291 个用例：德扑规则回归 + 血色评估器 + 血色引擎流程 + 角色技能 + 机器人 + 随机整场模拟 + 账号/天梯 + 更新日志版本口径与写作口径
```

端到端脚本（先启动服务器）：

```bash
cd server && npx tsx test/bloodSmoke.ts   # 血色模式 2 机器人完整对局到车票胜利
cd server && npx tsx test/smoke.ts        # 经典模式联机 + 断线重连
```

## 已知限制

- 对局状态在内存中，服务器进程重启后进行中的对局会丢失
- 浏览器后台标签页可能被系统挂起导致连接中断，回到前台刷新页面即可恢复
- 血色模式角色技能已全部自动化；观战已支持（大厅输入房间码点「观战」，不占座位、可随时入座；AI 机器人补位已支持）

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

| 命令                        | 作用                                    |
| --------------------------- | --------------------------------------- |
| bloodtable update           | 拉最新代码并重启（最常用）              |
| bloodtable deploy           | 只部署当前代码并重启（**不联网**，见下） |
| bloodtable restart / reboot | 重启游戏服务                            |
| bloodtable clear            | 一键清空所有房间                        |
| bloodtable status / logs    | 看运行状态 / 看日志                     |

`bloodtable` 本体就在仓库里（`bin/bloodtable`），不再是只存在于服务器上的手写脚本——换机器、重装服务器都不再丢命令。
脚本会自行定位仓库目录（顺序：`$BLOOD_TABLE_DIR` → 脚本所在仓库 → `~/Blood-Table`），因此从 `/usr/local/bin` 调用也能找到代码。
新机器安装与查看用法：

```bash
sudo ln -sf "$PWD/bin/bloodtable" /usr/local/bin/bloodtable   # 或 bash bin/bloodtable install
bloodtable help                                              # 查看全部子命令
```

> **两种上线方式**：① 服务器上 `git pull && bash deploy.sh`（= `bloodtable update`，最常用）；
> ② 本机 `git push server main` —— 线上仓库设置了 `receive.denyCurrentBranch=updateInstead`，
> 推送会直接更新服务器的工作区，但**不会重启进程**，还须执行 `bloodtable deploy`（只跑 deploy.sh，
> 不依赖外网）或 `bloodtable restart` 才生效。
> 本仓库另有一个指向线上仓库的 `server` 远端（地址见本机 `.git/config`，不写入本文档）。

> **为什么要有 `deploy`**：线上机器出网到 GitHub 并不稳定（实测多次连接超时 / TLS 中断），
> 而 `update` 的第一步就是 `git pull` —— 网络一抖，明明代码已由推送到达服务器却上不了线。
> `update` 现在会在拉取失败时**明确告警后继续部署当前工作区代码**，只想上线当前代码可直接用 `deploy`。
