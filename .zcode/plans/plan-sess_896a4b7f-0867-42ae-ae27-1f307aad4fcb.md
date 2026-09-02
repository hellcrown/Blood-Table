# 拓展黑市·复杂 4 张牌实装（弹簧夹层 / 复制芯片 / 屏蔽器 / 防护屏障）

体验优先，引入两个通用框架：亮牌决策队列 + 反制询问窗口。

## 一、亮牌决策队列（对决阶段新交互框架）
- `openRevealWindow` 触发完镀层效果后，检查该玩家出牌区上的可决策芯片，生成队列：
  `gs.secretPending = { seat, kind: 'revealDecide', queue: Decision[], decision: 当前决策 }`
  - Decision = spring（弹簧夹层，带 chipId/cardId）/ copy（复制芯片）/ shield（屏蔽器）
  - 决策期间窗口不推进；完成后弹出下一条；队列空 → `nextRevealOrSettle` 推进
  - 超时托管：剩余决策按"跳过"处理并推进（复用 demagTarget 超时模式）
- 新动作：`bSpringUse {chipId, mod}`、`bRevealChipTarget {seat, cardId, defId}`、`bSkipDecision`

## 二、逐牌实现
1. **弹簧夹层**：`ChipInst.springMod`（对决临时修正，finishReorg 清除）；决策控件选 ±X（X ≤ 血筹、有效点数钳制 2-14）→ 扣血筹；评估链（evalCardsFor/bestFive）追加合成 rankMod → 牌型/点数/顺子/编剧 50 点全部自动生效
2. **复制芯片**：亮牌时选目标芯片（排除双生镜片与已失效），效果快照存 `ChipInst.copiedFx`（支持一层链：复制"复制芯片复制出的效果"）；评估类直接生效；复制镀层（出/夺）当场立即触发；复制屏蔽器追加 shield 决策；结算循环（镀层/车票/自毁）解析 copiedFx
3. **屏蔽器**：亮牌时选任一玩家的一张芯片 → `off = true`（复用消磁枪失效机制，finishReorg 恢复）；目标列表含双生镜片与自己的芯片
4. **防护屏障**：反制询问窗口——暴力删除/定点爆破/黑厢抢夺/投毒/冻结/失忆/干扰器/消磁枪结算前，若受害者持有屏障 → 消耗并询问"抵消/允许生效"（超时=不抵消托管）；抵消则效果落空、费用不退；按来源（购买/换牌/对决）正确推进后续

## 三、数据与协议
- ChipInst + `springMod/copiedFx`；secretPending kind + `'revealDecide'|'barrierAsk'`，字段 + `queue/decision/eff`
- BloodMyPrompt：k + `'revealDecide'|'barrierAsk'`，字段 + `decision/chipId/eff`
- 新动作：bSpringUse、bRevealChipTarget、bSkipDecision、bBarrierDecide；rooms.ts 路由

## 四、客户端（体验优先）
- revealDecide 控件：spring → 牌高亮 + ±X 按钮 + 跳过；copy/shield → 全场芯片目标列表（来自 view.players[].played[].chipIds，无需新视图字段）
- barrierAsk 面板：效果描述 + 抵消/允许生效按钮
- myTurnText 提示文案全覆盖

## 五、测试与验证
- 引擎测试：弹簧（评估变化/扣费/越界拒绝）、复制（镀层胜结算触发/夺的掠夺/双生镜片拒绝）、屏蔽（失效后评估下降、次回合恢复）、屏障（抵消与放行两分支）
- 全量 79 测试 + 随机模拟 seed 扫描不回归
- 本地 3100 实例勾选拓展黑市手测四张牌 → 提交推送 GitHub + `git push server` 直连云服务器远程部署（已打通免密通道，无需你操作）
