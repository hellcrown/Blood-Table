import { useEffect, useState } from 'react';
import type { RoomSettings, SeatView, TableView } from '@shared/protocol';
import { net } from '../net/socket';

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

  useEffect(() => {
    setSettings(view.settings);
  }, [view.settings]);

  // 邀请链接 = 当前访问地址（部署在云服务器上，朋友直接打开同网址进大厅）
  const inviteUrl = `${location.origin}/`;
  const inviteText = `${inviteUrl} — 血色牌局房间码：${view.code}`;

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

  const canStart = view.players.length >= 2;

  const update = (patch: {
    sb?: number;
    bb?: number;
    startChips?: number;
    maxPlayers?: number;
    charPick?: boolean;
    expansion?: boolean;
  }) => {
    net.send({ t: 'settings', ...patch });
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
        <span className="spacer" />
        <button className="btn small ghost" onClick={() => net.leaveRoom()}>
          退出房间
        </button>
      </header>

      <div className="room-body">
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
              onClick={() => copyInvite(`${inviteUrl} — 血色牌局房间码：${view.code}`)}
            >
              {inviteUrl}
            </button>
          </div>
        </div>

        <div className="seat-grid" style={{ gridTemplateColumns: `repeat(${Math.ceil(view.maxPlayers / 2)}, 1fr)` }}>
          {seats.map((sv, i) => (
            <div key={i} className={`seat-cell ${sv ? 'taken' : 'empty'}`}>
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

        <div className="settings-panel">
          <div className="box-title">
            {view.mode === 'blood' ? '血色牌局 · 对局规则' : '房间设置（德州扑克）'}
            {isHost ? '' : '（房主可修改）'}
          </div>
          {view.mode === 'blood' ? (
            <p className="hint">
              每人一副 54 张牌 · 暗扣 5 张对决 · 黑市买芯片 · 血筹购买/删牌 ·
              集齐 {view.maxPlayers <= 2 ? 24 : view.maxPlayers === 3 ? 20 : 16} 张车票获胜（
              {view.maxPlayers <= 2 ? '2人局' : view.maxPlayers === 3 ? '3人局' : '4人局'}目标）
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
                  onBlur={() => isHost && update({ sb: settings.sb })}
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
                  onBlur={() => isHost && update({ bb: settings.bb })}
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
                  onBlur={() => isHost && update({ startChips: settings.startChips })}
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
              <label className="charpick-toggle" title="开启后开局每人随机抽 2 张角色牌，选择 1 张获得其技能">
                选将模式
                <input
                  type="checkbox"
                  checked={view.charPick}
                  disabled={!isHost}
                  onChange={(e) => update({ charPick: e.target.checked })}
                />
                <span className="hint">{view.charPick ? '开（2选1角色牌）' : '关（默认）'}</span>
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
            </div>
          )}
        </div>

        <div className="start-row">
          {isHost ? (
            <button className="btn primary big" disabled={!canStart} onClick={() => net.send({ t: 'start' })}>
              开始游戏
            </button>
          ) : (
            <span className="hint">等待房主开始游戏…</span>
          )}
          {!canStart && <span className="hint">至少需要 2 名玩家</span>}
        </div>
        {me && !isHost && <p className="hint">你是 {me.name}，座位号 {me.seat + 1}</p>}
      </div>
    </div>
  );
}
