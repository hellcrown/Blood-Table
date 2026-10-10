import { useEffect, useRef, useState } from 'react';
import type { RoomSettings, SeatView, TableView } from '@shared/protocol';
import { charPoolIds, BLOOD_CHAR_BY_ID } from '@shared/bloodChars';
import { net } from '../net/socket';
import { ChatModal } from '../components/ChatModal';
import { CharPortrait } from '../components/CharCard';

/** 兜底复制：textarea + execCommand，http 局域网（非安全上下文）下也能用 */
function fallbackCopy(text: string): boolean {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '-9999px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export function Room({ view }: { view: TableView }) {
  const me = view.players.find((p) => p.id === net.playerId);
  const isHost = view.hostId === net.playerId;
  const [settings, setSettings] = useState<RoomSettings>(view.settings);
  const [copyMsg, setCopyMsg] = useState<string | null>(null);
  // 目标票数本地草稿：输入中不实时上报，失焦时钳制并提交
  const [targetTicketsInput, setTargetTicketsInput] = useState(String(view.targetTickets || ''));
  // 房间密码草稿：服务端不下发密码本体，仅显示是否已设置
  const [pwDraft, setPwDraft] = useState('');
  const pwDirtyRef = useRef(false); // 本轮 focus 后是否实际编辑过（防 blur 误清已设密码/Enter 后二次提交）
  const [pwMsg, setPwMsg] = useState<string | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [djPickerOpen, setDjPickerOpen] = useState(false);

  // 服务端设置的三个数值：只在**数值真的变化**时同步草稿。
  // 依赖整个 view.settings（每条广播都是新对象）会在别人入座/改设置时，把房主正在输入、
  // 尚未失焦的值覆盖回旧值 —— 失焦后提交的就是被覆盖的值，等于白改。
  const srvSb = view.settings.sb;
  const srvBb = view.settings.bb;
  const srvChips = view.settings.startChips;
  useEffect(() => {
    setSettings((prev) => ({ ...prev, sb: srvSb, bb: srvBb, startChips: srvChips }));
  }, [srvSb, srvBb, srvChips]);

  // 邀请链接 = 当前访问地址 + 房间码参数（朋友打开后自动预填房间码）
  const inviteUrl = `${location.origin}/?room=${view.code}`;
  const brand = view.mode === 'blood' ? '血色牌局' : view.mode === 'mines' ? '扫雷竞速' : '经典德州';
  const inviteText = `${inviteUrl} — ${brand}房间码：${view.code}`;

  const copyInvite = async (text = inviteText) => {
    let ok = false;
    // 现代剪贴板 API 仅在安全上下文（https / localhost）可用；http 环境走兜底
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        ok = true;
      } catch {
        ok = fallbackCopy(text);
      }
    } else {
      ok = fallbackCopy(text);
    }
    setCopyMsg(ok ? '已复制 ✓' : '复制失败，请手动选中复制');
    window.setTimeout(() => setCopyMsg(null), 1500);
  };

  const seats: (SeatView | null)[] = Array.from({ length: view.maxPlayers }, (_, i) =>
    view.players.find((p) => p.seat === i) ?? null,
  );
  // 观战中：自己不在已入座玩家列表（点击空座位即可入座转为玩家）
  const spectating = !view.players.some((p) => p.id === net.playerId);

  const renderSeatCell = (i: number) => {
    const sv = seats[i];
    const empty = !sv;
    return (
      <div
        className={`seat-cell seat-${i % 4} ${sv ? 'taken' : 'empty'} ${empty ? 'clickable' : ''}`}
        title={empty ? '点击坐到这里' : undefined}
        onClick={() => {
          if (empty) net.send({ t: 'sit', seat: i });
        }}
      >
        {sv ? (
          <>
            <div className="seat-name">
              {sv.name}
              {sv.id === net.playerId && <em>（你）</em>}
            </div>
            <div className="seat-tags">
              {sv.isHost && <span className="tag host">房主</span>}
              {!sv.connected && <span className="tag off">已断线</span>}
            </div>
            {isHost && sv.id !== net.playerId && (
              <button
                className="btn tiny ghost kick-btn"
                title="请离该玩家"
                onClick={(e) => {
                  e.stopPropagation();
                  net.send({ t: 'kickPlayer', seat: sv.seat });
                }}
              >
                请出
              </button>
            )}
          </>
        ) : (
          <button
            className="sit-btn"
            onClick={(e) => {
              e.stopPropagation();
              net.send({ t: 'sit', seat: i });
            }}
            title="坐到这里"
          >
            空座位
          </button>
        )}
      </div>
    );
  };

  // 4 人局：以自己的座位为基准的桌面方位（自己在下=南）
  const mySeatBase = view.players.find((p) => p.id === net.playerId)?.seat ?? 0;
  const tablePosSeat = (offset: number): number => (mySeatBase + offset) % 4;

  const canStart = view.players.length >= (view.mode === 'mines' ? 1 : 2); // 扫雷支持单人开局

  const update = (patch: {
    sb?: number;
    bb?: number;
    startChips?: number;
    maxPlayers?: number;
    charExpansion?: boolean;
    expansion?: boolean;
    targetTickets?: number;
    minesDifficulty?: 'easy' | 'medium' | 'hard';
    minesTimeSec?: number;
    password?: string;
  }) => {
    net.send({ t: 'settings', ...patch });
  };

  /** 房主提交密码（失焦触发）：空串清除密码 */
  const commitPassword = () => {
    if (!isHost) return;
    if (!pwDirtyRef.current) return; // 未编辑过（纯 blur/重复触发）：不提交
    pwDirtyRef.current = false;
    const pw = pwDraft.trim();
    if (!pw && !view.hasPassword) return; // 无变化
    update({ password: pw });
    setPwDraft('');
    setPwMsg(pw ? '密码已设置 ✓（朋友加入时需输入）' : view.hasPassword ? '密码已清除' : null);
    window.setTimeout(() => setPwMsg(null), 2500);
  };

  return (
    <div className="room-page">
      <header className="page-bar">
        <span className="brand">血色牌局</span>
        <span className="room-code">
          房间码 <b>{view.code}</b>
        </span>
            <button className="btn small" onClick={() => copyInvite()}>
              {copyMsg ?? '复制邀请'}
            </button>
        <button className="btn tiny ghost" onClick={() => setChatOpen(true)} title="聊天：房间成员 / 全服在线玩家">
          💬
        </button>
        <span className="spacer" />
        <button className="btn small ghost" onClick={() => net.leaveRoom()}>
          退出房间
        </button>
      </header>

      <div className="room-body">
        {spectating && (
          <div className="spectate-banner">
            🔭 观战中 —— 点击下方空座位即可入座成为玩家
          </div>
        )}

        <div className="invite-box">
          <div className="box-title">邀请好友</div>
          <div className="invite-row">
            <span className="invite-code">
              房间码 <b>{view.code}</b>
            </span>
            <button className="btn small" onClick={() => copyInvite()}>
              {copyMsg ?? '复制邀请'}
            </button>
          </div>
          <div className="invite-urls">
            <div className="invite-group-label">游戏地址（朋友打开后输入房间码加入）</div>
            <button
              className="invite-url"
              title="点击复制地址+房间码"
              onClick={() => copyInvite(inviteText)}
            >
              {inviteUrl}
            </button>
          </div>
        </div>

        {view.maxPlayers === 4 ? (
          <div className="table-layout">
            <div className="table-pos pos-top">
              {renderSeatCell(tablePosSeat(2))}
            </div>
            <div className="table-pos pos-left">
              {renderSeatCell(tablePosSeat(3))}
            </div>
            <div className="table-center-x">
              <div className="table-code">{view.code}</div>
              <div className="hint">{view.mode === 'blood' ? '血色牌局' : '德州扑克'}</div>
              <div className="hint">{view.maxPlayers} 人局</div>
            </div>
            <div className="table-pos pos-right">
              {renderSeatCell(tablePosSeat(1))}
            </div>
            <div className="table-pos pos-bottom">
              {renderSeatCell(tablePosSeat(0))}
            </div>
          </div>
        ) : (
          <div className="seat-grid" style={{ gridTemplateColumns: `repeat(${Math.ceil(view.maxPlayers / 2)}, 1fr)` }}>
            {seats.map((sv, i) => (
              <div key={i} className={`seat-cell seat-${i % 4} ${sv ? 'taken' : 'empty'}`}>
                {sv ? (
                  <>
                    <div className="seat-name">
                      {sv.name}
                      {sv.id === net.playerId && <em>（你）</em>}
                    </div>
                    <div className="seat-tags">
                      {sv.isHost && <span className="tag host">房主</span>}
                      {!sv.connected && <span className="tag off">已断线</span>}
                    </div>
                    {isHost && sv.id !== net.playerId && (
                      <button
                        className="btn tiny ghost kick-btn"
                        title="请离该玩家"
                        onClick={(e) => {
                  e.stopPropagation();
                  net.send({ t: 'kickPlayer', seat: sv.seat });
                }}
                      >
                        请出
                      </button>
                    )}
                  </>
                ) : (
                  <button
                    className="sit-btn"
                    onClick={() => net.send({ t: 'sit', seat: i })}
                    title="坐到这里"
                  >
                    空座位
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="settings-panel">
          <div className="box-title">
            {view.mode === 'blood' ? '血色牌局 · 对局规则' : view.mode === 'mines' ? '扫雷竞速 · 对局规则' : '房间设置（德州扑克）'}
            {isHost ? '' : '（房主可修改）'}
          </div>
          {view.mode === 'mines' ? (
            <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div className="act-row wrap" style={{ alignItems: 'center' }}>
                <span className="hint">难度：</span>
                <select
                  value={view.minesDifficulty}
                  disabled={!isHost}
                  onChange={(e) =>
                    update({ minesDifficulty: e.target.value as 'easy' | 'medium' | 'hard' })
                  }
                >
                  <option value="easy">初级 9×9 / 10 雷</option>
                  <option value="medium">中级 16×16 / 40 雷</option>
                  <option value="hard">高级 30×16 / 99 雷</option>
                </select>
                <span className="hint">点雷出局 · 先扫完全部安全格者胜</span>
              </div>
              <div className="act-row wrap" style={{ alignItems: 'center' }}>
                <span className="hint">时间限制：</span>
                <select
                  value={view.minesTimeSec ?? 0}
                  disabled={!isHost}
                  onChange={(e) => update({ minesTimeSec: Number(e.target.value) })}
                >
                  <option value={0}>默认（初级 3 分 · 中级 6 分 · 高级 10 分）</option>
                  <option value={120}>2 分钟</option>
                  <option value={180}>3 分钟</option>
                  <option value={300}>5 分钟</option>
                  <option value={600}>10 分钟</option>
                  <option value={900}>15 分钟</option>
                </select>
                <span className="hint">倒计时归零按当前进度排名</span>
              </div>
            </div>
          ) : view.mode === 'blood' ? (
            <p className="hint">
              每人一副 54 张牌 · 暗扣 5 张对决 · 黑市买芯片 · 血筹购买/删牌 ·
              开局定角色（角色牌足够时每人抽2选1：拓展池3/4人局可选将；基础池随机分配）·
              按开局人数分档：2 人局 24 张车票 · 3 人局 20 张 · 4 人局 16 张（房主可自定义 8-30）
            </p>
          ) : (
            <div className="settings-grid">
              <label>
                小盲
                <input
                  type="number"
                  min={1}
                  value={settings.sb}
                  disabled={!isHost}
                  onChange={(e) => setSettings({ ...settings, sb: Number(e.target.value) })}
                  onBlur={() => isHost && Number.isFinite(settings.sb) && update({ sb: settings.sb })}
                />
              </label>
              <label>
                大盲
                <input
                  type="number"
                  min={2}
                  value={settings.bb}
                  disabled={!isHost}
                  onChange={(e) => setSettings({ ...settings, bb: Number(e.target.value) })}
                  onBlur={() => isHost && Number.isFinite(settings.bb) && update({ bb: settings.bb })}
                />
              </label>
              <label>
                初始筹码
                <input
                  type="number"
                  min={20}
                  value={settings.startChips}
                  disabled={!isHost}
                  onChange={(e) => setSettings({ ...settings, startChips: Number(e.target.value) })}
                  onBlur={() => isHost && Number.isFinite(settings.startChips) && update({ startChips: settings.startChips })}
                />
              </label>
              <label>
                人数上限
                <select
                  value={view.maxPlayers}
                  disabled={!isHost}
                  onChange={(e) => update({ maxPlayers: Number(e.target.value) })}
                >
                  <option value={2}>2 人</option>
                  <option value={3}>3 人</option>
                  <option value={4}>4 人</option>
                </select>
              </label>
            </div>
          )}
          {view.mode === 'blood' && (
            <div className="settings-grid" style={{ marginTop: 10 }}>
              <label>
                人数上限
                <select
                  value={view.maxPlayers}
                  disabled={!isHost}
                  onChange={(e) => update({ maxPlayers: Number(e.target.value) })}
                >
                  <option value={2}>2 人</option>
                  <option value={3}>3 人</option>
                  <option value={4}>4 人</option>
                </select>
              </label>
              <label
                className="charpick-toggle"
                title="选将始终进行：角色牌足够时（拓展池必满足）每人随机2张角色牌选1，基础池仅4名角色时3/4人局随机分配1名。开启后角色池并入拓展角色（共58名）"
              >
                拓展选将
                <input
                  type="checkbox"
                  checked={view.charExpansion}
                  disabled={!isHost}
                  onChange={(e) => update({ charExpansion: e.target.checked })}
                />
                <span className="hint">{view.charExpansion ? '开（全部58名角色）' : '关（仅基础4角色）'}</span>
              </label>
              <label className="charpick-toggle" title="开启后黑市牌库并入拓展牌（仿制印章、加密线路、闭店礼等）">
                拓展黑市
                <input
                  type="checkbox"
                  checked={view.expansion}
                  disabled={!isHost}
                  onChange={(e) => update({ expansion: e.target.checked })}
                />
                <span className="hint">{view.expansion ? '开（27种拓展牌）' : '关（默认）'}</span>
              </label>
              <label
                className="charpick-toggle"
                title="自定义胜利目标票数（8-30）。留空/0 = 按人数默认：2人24、3人20、4人16。内置计分：本局首个夺魁额外+1🎫（抢跑），连续回合夺魁从第二连起每次+1🎫（连胜）"
              >
                目标票数
                <input
                  type="number"
                  min={8}
                  max={30}
                  value={targetTicketsInput}
                  placeholder="默认"
                  disabled={!isHost}
                  onChange={(e) => setTargetTicketsInput(e.target.value)}
                  onBlur={() => {
                    if (!isHost) return;
                    const n = Math.round(Number(targetTicketsInput) || 0);
                    // 与界面承诺一致：非 0 值钳到 8-30（服务端虽放宽到 0-30，1-7 票的局会失去博弈意义）
                    const clamped = n === 0 ? 0 : Math.min(30, Math.max(8, n));
                    setTargetTicketsInput(String(clamped || ''));
                    if (clamped !== (view.targetTickets ?? 0)) update({ targetTickets: clamped });
                  }}
                />
                <span className="hint">{view.targetTickets ? `${view.targetTickets} 票` : '按人数默认'}</span>
              </label>
            </div>
          )}
          <div className="settings-grid" style={{ marginTop: 10, gridTemplateColumns: '1fr' }}>
            <label
              className="charpick-toggle"
              title={isHost ? '设置后朋友加入/观战需输入密码；留空提交即清除' : '该房间是否需要密码加入'}
            >
              房间密码
              <input
                value={pwDraft}
                maxLength={12}
                placeholder={view.hasPassword ? '已设置（输入新密码可修改）' : '未设置（可选）'}
                disabled={!isHost}
                onChange={(e) => {
                  pwDirtyRef.current = true;
                  setPwDraft(e.target.value);
                }}
                onBlur={commitPassword}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitPassword();
                }}
              />
              <span className="hint">{pwMsg ?? (view.hasPassword ? '🔒 需密码加入' : '公开房间')}</span>
            </label>
          </div>
        </div>

        {view.mode === 'blood' && !spectating && (
          <div className="settings-panel">
            <div className="box-title">🗡️ 点将卡{me?.dianjiangLeft != null ? `（今日剩余 ${me.dianjiangLeft} 局）` : ''}</div>
            {!net.account ? (
              <p className="hint">注册登录后可用：每天 3 局可指定本局角色（在大厅左下角注册/登录）</p>
            ) : (
              <div className="act-row wrap" style={{ alignItems: 'center' }}>
                {me?.dianjiangPick ? (
                  <>
                    <CharPortrait def={BLOOD_CHAR_BY_ID.get(me.dianjiangPick)!} size="sm" />
                    <span>
                      本局指定【{BLOOD_CHAR_BY_ID.get(me.dianjiangPick)?.name ?? me.dianjiangPick}】
                      <span className="hint">（开局生效；「再来一场」算新的一局）</span>
                      {(me.dianjiangLeft ?? 1) <= 0 && (
                        <b style={{ color: '#d4a017' }}>⚠️ 今日次数已用完，本局不会生效</b>
                      )}
                    </span>
                    <button className="btn small" onClick={() => net.send({ t: 'dianjiang', charId: null })}>
                      取消指定
                    </button>
                  </>
                ) : (
                  <>
                    <span className="hint">未指定——本局角色按常规随机</span>
                    <button
                      className="btn small primary"
                      disabled={(me?.dianjiangLeft ?? 0) <= 0}
                      title={(me?.dianjiangLeft ?? 0) <= 0 ? '今日次数已用完，明天再来' : undefined}
                      onClick={() => setDjPickerOpen(true)}
                    >
                      {(me?.dianjiangLeft ?? 0) <= 0 ? '今日已用完' : '选择角色'}
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        )}

        <div className="start-row">
          {isHost ? (
            <button className="btn primary big" disabled={!canStart} onClick={() => net.send({ t: 'start' })}>
              开始游戏
            </button>
          ) : (
            <span className="hint">等待房主开始游戏…</span>
          )}
          {isHost && view.mode === 'blood' && view.phase === 'waiting' && (
            <>
              {view.players.length < view.maxPlayers && (
                <button className="btn" onClick={() => net.send({ t: 'addBot' })} title="添加一个机器人玩家（AI 补位）">
                  🤖 添加机器人
                </button>
              )}
              {view.players.some((pl) => pl.isBot) && (
                <button
                  className="btn"
                  onClick={() => {
                    const bot = view.players.filter((pl) => pl.isBot).sort((a, b) => b.seat - a.seat)[0];
                    if (bot) net.send({ t: 'kickBot', seat: bot.seat });
                  }}
                >
                  移除机器人
                </button>
              )}
            </>
          )}
          {!canStart && <span className="hint">{view.mode === 'mines' ? '至少需要 1 名玩家（最多 2 人）' : '至少需要 2 名玩家'}</span>}
        </div>
        {me && !isHost && <p className="hint">你是 {me.name}，座位号 {me.seat + 1}</p>}
      </div>
      {chatOpen && <ChatModal onClose={() => setChatOpen(false)} roomScope />}
      {djPickerOpen && (
        <div className="overlay" onClick={() => setDjPickerOpen(false)}>
          <div className="panel" onClick={(e) => e.stopPropagation()}>
            <h3>🗡️ 点将卡 · 选择本局角色</h3>
            <p className="hint">
              仅限本房间角色池（{view.charExpansion ? '全部角色' : '基础 4 角色'}）；开局生效并消耗 1 次今日配额
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, maxHeight: '60vh', overflowY: 'auto' }}>
              {charPoolIds(view.charExpansion).map((cid) => (
                <CharPortrait
                  key={cid}
                  def={BLOOD_CHAR_BY_ID.get(cid)!}
                  size="sm"
                  onClick={() => {
                    net.send({ t: 'dianjiang', charId: cid });
                    setDjPickerOpen(false);
                  }}
                />
              ))}
            </div>
            <div className="panel-actions">
              <button className="btn" onClick={() => setDjPickerOpen(false)}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
