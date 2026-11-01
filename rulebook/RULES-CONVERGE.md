# 心有灵犀 · 规则文档（实现依据）

> 双人填词趋同（合作向，无对抗）。两人不交流，每轮各写一个词或一句话；两边都提交后
> 同时亮牌，**写到同一个答案即「相遇」**，用时轮数即默契值。灵感来自短视频平台的
> 「脑回路相遇」玩法；无时限、无题库、纯自由联想。

## 1. 基本流程

- 固定 **2 人**对局（房间容量钳 2，另可有观战者）；大厅选「心有灵犀」建房，房主开始后进入第 1 轮。
- 每轮双方各写一个文本（≤60 字，服务端钳制；纯空白拒收）。**提交后、对方提交前可反复修改**
  （`cSubmit` 幂等覆写）；**双方都已提交才揭示本轮**。
- 揭示后：
  - 归一化相同 → **相遇终局**，`result.rounds` = 当前轮数（相遇轮计入），`result.word` 取相遇轮
    seat 0 的原文；
  - 不同 → 进入下一轮（`round+1`），双方当轮文本清空待重写；已揭示轮进入 `rounds` 历史永久保留。

## 2. 判同口径（宽松归一化）

比较时使用 `shared/src/convergeProtocol.ts` 的 `normalizeText()`（客户端测试与服务器引擎同源）：

```
raw.normalize('NFKC')   // 全角→半角（６=6）、兼容字符分解
  .replace(/\s+/g, '')  // 去掉全部空白（含中文间空格）
  .toLowerCase()        // 拉丁字母小写
```

- **展示保留原文**：历史与相遇词都显示原样输入（「６」与「6」相遇时相遇词显示 seat 0 的原文）。
- 提交时服务端还会：控制字符（`\u0000-\u001f\u007f`）折成空格、`trim`、截断到 60 字。

## 3. 终局（四种）

| 结果 | reason | 触发 |
| --- | --- | --- |
| 相遇 | `match` | 某轮归一化判同（唯一「胜利」结局） |
| 未相遇 | `abort` | 房主「终止本局」 |
| 未相遇 | `leave` | 玩家中途退出/被移除（双人局少一人无法继续，`removeSession` 内统一触发） |
| 未相遇 | `idle` | 进行中全员断线 30s（宽限覆盖刷新重连，口径同扫雷） |

## 4. 隐私红线

- **对手当轮未揭示的文本绝不下发**：`ConvergeView.players` 只有 `{id,name,seat,submitted}`，
  `myText` 只回本人；已揭示文本只存在于 `rounds` 历史。
- 故意超时/拖延在口径上无收益可言（本作不限时），无需防「超时偷看」规则。

## 5. 房间层接线（与扫雷同口径）

- 不限时：无 deadline、无 tick 结算；`convergeEmptySince` 只做全员断线 30s 宽限。
- 房间码/邀请链接/断线重连（rejoin）/观战（终局自动回等待页）/房间聊天/审计
  （`auditPlayerAct` 记每次提交尝试；终局 `recordGameEnd` summary 带 `mode:'converge'` + result）
  全部复用现有机制；`再来一局`（`cRematch`，房主专属）重建引擎并归零日志游标。
- 服务端纯函数引擎：`server/src/converge/engine.ts`
  （`createConvergeGame / cSubmit / convergeAbort / convergeForceEnd / cLeave / buildConvergeView`）。
