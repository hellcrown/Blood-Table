/**
 * 全服聊天 ChatHub 回归测试：消息消费边界、广播与历史、身份解析、清洗/限流/封顶。
 */
import { describe, expect, it } from 'vitest';
import { ChatHub, type ChatDeps, type ChatMsg } from '../src/chat';

function makeHub(overrides: Partial<ChatDeps> = {}): {
  hub: ChatHub;
  sent: { ws: unknown; msg: unknown }[];
  broadcasts: unknown[];
} {
  const sent: { ws: unknown; msg: unknown }[] = [];
  const broadcasts: unknown[] = [];
  const hub = new ChatHub({
    send: (ws, msg) => sent.push({ ws, msg }),
    broadcast: (msg) => broadcasts.push(msg),
    resolveIdentity: (_ws, name, auth) =>
      auth === 'token-A' ? { name: '账号甲', account: true } : { name: String(name ?? '路人1'), account: false },
    ...overrides,
  });
  return { hub, sent, broadcasts };
}

const fakeWs = { ip: '1.2.3.4' };

describe('ChatHub · 消息消费边界', () => {
  it('非聊天前缀返回 false（交回房间分发层）；聊天前缀返回 true', () => {
    const { hub } = makeHub();
    expect(hub.onRaw(fakeWs, '{"t":"ping","n":1}')).toBe(false);
    expect(hub.onRaw(fakeWs, 'not json')).toBe(false);
    expect(hub.onRaw(fakeWs, '{"t":"chat","text":"hi"}')).toBe(true);
    expect(hub.onRaw(fakeWs, '{"t":"chatHistory"}')).toBe(true);
    expect(hub.onRaw(fakeWs, '{"t":"chat" broken')).toBe(true); // 前缀命中但解析失败：消费不进房间层
  });
});

describe('ChatHub · 发言与历史', () => {
  it('发言广播（含本人回显）并追加历史；chatHistory 下发快照', () => {
    const { hub, sent, broadcasts } = makeHub();
    hub.onRaw(fakeWs, '{"t":"chat","text":"大家好","name":"甲"}');
    const b0 = broadcasts[0] as { t: string; name: string; text: string; account?: boolean };
    expect(b0).toMatchObject({ t: 'chatMsg', name: '甲', text: '大家好' });
    expect(b0.account).toBeUndefined();
    // 历史：新连接拉取
    const ws2 = { ip: '5.6.7.8' };
    hub.onRaw(ws2, '{"t":"chatHistory"}');
    const log = (sent.find((x) => x.ws === ws2)!.msg as { t: string; msgs: ChatMsg[] }).msgs;
    expect(log).toHaveLength(1);
    expect(log[0]!.text).toBe('大家好');
  });

  it('登录令牌：昵称取账号名并带 account 标记（客户端发什么 name 都被覆盖）', () => {
    const { hub, broadcasts } = makeHub();
    hub.onRaw(fakeWs, '{"t":"chat","text":"在吗","name":"冒名者","auth":"token-A"}');
    expect(broadcasts[0]).toMatchObject({ name: '账号甲', account: true });
  });

  it('清洗：控制/零宽字符剔除、120 字截断、空文本丢弃', () => {
    const { hub, broadcasts } = makeHub();
    hub.onRaw(fakeWs, '{"t":"chat","text":"\\u200b行\\u0001一下"}');
    expect((broadcasts[0] as { text: string }).text).toBe('行一下');
    hub.onRaw(fakeWs, `{"t":"chat","text":"${'长'.repeat(150)}"}`);
    expect((broadcasts[1] as { text: string }).text).toHaveLength(120);
    hub.onRaw(fakeWs, '{"t":"chat","text":"   "}');
    expect(broadcasts).toHaveLength(2);
  });
});

describe('ChatHub · 防护', () => {
  it('限流 10 秒 5 条：第 6 条静默丢弃（不广播不入历史），换 IP 不受影响', () => {
    const { hub, broadcasts } = makeHub();
    for (let i = 0; i < 5; i++) hub.onRaw(fakeWs, `{"t":"chat","text":"m${i}"}`);
    expect(broadcasts).toHaveLength(5);
    hub.onRaw(fakeWs, '{"t":"chat","text":"m5"}');
    expect(broadcasts).toHaveLength(5); // 丢弃
    const other = { ip: '9.9.9.9' };
    hub.onRaw(other, '{"t":"chat","text":"其他IP正常"}');
    expect(broadcasts).toHaveLength(6);
  });

  it('历史封顶 80 条', () => {
    const { hub, sent } = makeHub();
    // 每条换 IP：绕开 10s/5 条限流，专测历史封顶
    for (let i = 0; i < 90; i++) hub.onRaw({ ip: `10.0.0.${i}` }, `{"t":"chat","text":"n${i}","name":"甲"}`);
    hub.onRaw({ ip: '8.8.8.8' }, '{"t":"chatHistory"}');
    const log = (sent.at(-1)!.msg as { msgs: ChatMsg[] }).msgs;
    expect(log).toHaveLength(80);
    expect(log[0]!.text).toBe('n10'); // 最旧的 10 条被挤掉
    expect(log.at(-1)!.text).toBe('n89');
  });

  it('限流按 IP 隔离：解析失败/空文本不占用限流额度', () => {
    const { hub, broadcasts } = makeHub();
    for (let i = 0; i < 5; i++) hub.onRaw(fakeWs, '{"t":"chat","text":"  "}'); // 空文本
    hub.onRaw(fakeWs, '{"t":"chat","text":"还能发"}');
    expect(broadcasts.some((m) => (m as { text: string }).text === '还能发')).toBe(true);
  });
});
