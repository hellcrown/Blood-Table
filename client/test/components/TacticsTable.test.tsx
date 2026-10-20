/**
 * 血色猎场 · 对局页组件测试（jsdom）：钉住交互口径——
 * 1. 移动模式只点共享 BFS 算出的可达格（与服务端同源，不漂移）；
 * 2. 攻击/打击技能只点射程内目标；增益技能点击即发；
 * 3. 非本回合无操作按钮且点格无效；终局房主可再来一局。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TacticsTable } from '../../src/pages/TacticsTable';
import { net } from '../../src/net/socket';
import type { TacticsPlayerRow, TacticsView } from '@shared/tacticsProtocol';

const ME = 'u-me';

function prow(partial: Partial<TacticsPlayerRow> & { id: string; seat: number }): TacticsPlayerRow {
  return {
    name: partial.id,
    charId: 'hunter',
    hp: 10,
    maxHp: 10,
    ap: 4,
    maxAp: 4,
    r: 0,
    c: 0,
    alive: true,
    cooldowns: [0, 0],
    gold: 0,
    items: [],
    connected: true,
    ...partial,
  };
}

function tacView(overrides?: Partial<TacticsView>): TacticsView {
  return {
    kind: 'tactics',
    mode: 'tactics',
    code: 'TEST',
    hostId: ME,
    mapSize: 'small',
    rows: 5,
    cols: 5,
    grid: new Array(25).fill(0),
    phase: 'playing',
    players: [prow({ id: ME, seat: 0, r: 2, c: 2 }), prow({ id: 'u2', seat: 1, r: 4, c: 4, name: '对手' })],
    monsters: [],
    currentId: ME,
    turnNumber: 1,
    startedAt: Date.now(),
    deadline: Date.now() + 60_000,
    log: [{ seq: 1, kind: 'sys', text: '🏹 血色猎场开局' }],
    logSeq: 1,
    youId: ME,
    spectator: false,
    ranking: [],
    winnerId: null,
    serverTime: Date.now(),
    ...overrides,
  };
}

/** 取棋盘第 i 格（行优先） */
function cellAt(container: HTMLElement, r: number, c: number): HTMLElement {
  const cells = container.querySelectorAll('.tac-cell');
  return cells[r * 5 + c] as HTMLElement;
}

describe('TacticsTable · 血色猎场对局页', () => {
  beforeEach(() => {
    net.playerId = ME;
  });
  afterEach(() => {
    net.playerId = null;
    vi.restoreAllMocks();
  });

  it('移动模式：点可达格发 tMove，点不可达格不发', () => {
    const sendSpy = vi.spyOn(net, 'send');
    const { container } = render(<TacticsTable view={tacView()} />);
    // 我在 (2,2)、AP 4、无障碍：(2,3) 可达（发消息），(0,0) 距离 4 可达但 (0,4) 距离 2 也可达——用越界邻近性测"不可达"：(4,4) 被对手占着，不可停留
    fireEvent.click(cellAt(container, 2, 3));
    expect(sendSpy).toHaveBeenCalledWith({ t: 'tMove', to: { r: 2, c: 3 } });

    sendSpy.mockClear();
    fireEvent.click(cellAt(container, 4, 4)); // 对手所在格：BFS 不可达
    expect(sendSpy).not.toHaveBeenCalled();

    sendSpy.mockClear();
    fireEvent.click(cellAt(container, 4, 0)); // 距离 4 恰好可达
    expect(sendSpy).toHaveBeenCalledWith({ t: 'tMove', to: { r: 4, c: 0 } });
  });

  it('AP 不足的远格不在可达高亮里，点击不发', () => {
    const sendSpy = vi.spyOn(net, 'send');
    const view = tacView();
    view.players[0]!.ap = 1;
    const { container } = render(<TacticsTable view={view} />);
    expect(container.querySelector('.tac-cell.reach')).not.toBeNull();
    fireEvent.click(cellAt(container, 2, 4)); // 距离 2 > AP 1
    expect(sendSpy).not.toHaveBeenCalled();
    sendSpy.mockClear();
    fireEvent.click(cellAt(container, 2, 3)); // 距离 1 可达
    expect(sendSpy).toHaveBeenCalledWith({ t: 'tMove', to: { r: 2, c: 3 } });
  });

  it('攻击模式：切按钮后点射程内目标发 tAttack，目标格显示伤害角标', () => {
    const sendSpy = vi.spyOn(net, 'send');
    const view = tacView();
    view.monsters = [{ id: 'm1', type: 'leech', hp: 3, maxHp: 3, r: 2, c: 3 }];
    const { container } = render(<TacticsTable view={view} />);
    expect(container.querySelector('.tac-cell.atkable')).toBeNull(); // 移动模式下不高亮攻击目标
    fireEvent.click(screen.getByRole('button', { name: /⚔ 攻击/ }));
    expect(container.querySelector('.tac-cell.atkable')).not.toBeNull();
    expect(container.querySelector('.tac-dmg')?.textContent).toBe('-2'); // 角标=普攻伤害
    fireEvent.click(cellAt(container, 2, 3));
    expect(sendSpy).toHaveBeenCalledWith({ t: 'tAttack', r: 2, c: 3 });
  });

  it('增益技能点击即发；冷却中禁用', () => {
    const sendSpy = vi.spyOn(net, 'send');
    const view = tacView();
    view.players[0]!.cooldowns = [0, 2];
    render(<TacticsTable view={view} />);
    const bandage = screen.getByRole('button', { name: /包扎/ });
    expect(bandage).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /重击/ }));
    expect(sendSpy).not.toHaveBeenCalled(); // 打击技能进选点模式而非直接发
  });

  it('打击技能进入选点模式：点目标发 tSkill（带技能序号与坐标），角标显示技能伤害', () => {
    const sendSpy = vi.spyOn(net, 'send');
    const view = tacView();
    view.players[1]!.r = 2;
    view.players[1]!.c = 3;
    const { container } = render(<TacticsTable view={view} />);
    fireEvent.click(screen.getByRole('button', { name: /重击/ }));
    expect(container.querySelector('.tac-dmg')?.textContent).toBe('-4'); // 角标=重击伤害
    fireEvent.click(cellAt(container, 2, 3));
    expect(sendSpy).toHaveBeenCalledWith({ t: 'tSkill', skill: 0, r: 2, c: 3 });
  });

  it('非本回合：无操作按钮，点格子无效；观战者见横幅', () => {
    const sendSpy = vi.spyOn(net, 'send');
    const view = tacView({ currentId: 'u2' });
    const { container } = render(<TacticsTable view={view} />);
    expect(screen.queryByRole('button', { name: '🚶 移动' })).toBeNull();
    fireEvent.click(cellAt(container, 2, 3));
    expect(sendSpy).not.toHaveBeenCalled();

    const spec = tacView();
    spec.players = spec.players.filter((p) => p.id !== ME);
    spec.youId = null;
    spec.spectator = true;
    render(<TacticsTable view={spec} />);
    expect(screen.getByText(/观战中/)).toBeTruthy();
  });

  it('终局面板：渲染排名，房主可再来一局（tRematch）', () => {
    const sendSpy = vi.spyOn(net, 'send');
    const view = tacView({
      phase: 'gameover',
      deadline: null,
      winnerId: ME,
      ranking: [
        { seat: 0, name: '房主', rank: 1, hp: 10, alive: true },
        { seat: 1, name: '对手', rank: 2, hp: 0, alive: false },
      ],
    });
    render(<TacticsTable view={view} />);
    expect(screen.getByText(/猎场之王/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /再来一局/ }));
    expect(sendSpy).toHaveBeenCalledWith({ t: 'tRematch' });
  });
});
