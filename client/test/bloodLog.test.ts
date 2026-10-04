import { describe, expect, it } from 'vitest';
import { BLOOD_LOG_CAP, mergeBloodLog } from '../src/net/bloodLog';
import type { LogLine } from '@shared/protocol';

const line = (seq: number, text = `s${seq}`): LogLine => ({ seq, kind: 'sys', text });

describe('客户端 · 血战日志合并', () => {
  it('按 seq 排序并入本地缓冲', () => {
    const out = mergeBloodLog([line(1), line(2)], [line(3)], false);
    expect(out.map((l) => l.seq)).toEqual([1, 2, 3]);
  });

  it('乱序到达的增量会被排回正确位置', () => {
    const out = mergeBloodLog([line(1), line(2)], [line(4), line(3)], false);
    expect(out.map((l) => l.seq)).toEqual([1, 2, 3, 4]);
  });

  it('批量下发时末尾不是最大 seq：不得误判为换局而丢掉本地历史', () => {
    // 曾经的实现直接读 incoming[last].seq 当最大值：[5,2] 会被算成 2 < 本地 3 → 假重置，
    // 本地已有的 3 被整段丢弃，表现为"日志莫名少了几条"。
    const out = mergeBloodLog([line(1), line(2), line(3)], [line(5), line(2)], false);
    expect(out.map((l) => l.seq)).toEqual([1, 2, 3, 5]);
  });

  it('同一 seq 重复到达只保留一条（去重）', () => {
    const out = mergeBloodLog([line(1), line(2)], [line(2), line(3)], false);
    expect(out.map((l) => l.seq)).toEqual([1, 2, 3]);
    expect(out.filter((l) => l.seq === 2)).toHaveLength(1);
  });

  it('full=true 时用本次下发内容重置本地累积', () => {
    const out = mergeBloodLog([line(1), line(2), line(3)], [line(9)], true);
    expect(out.map((l) => l.seq)).toEqual([9]);
  });

  it('full=true 且下发的就是旧的同一批：仍以本次为准（重连后不叠加）', () => {
    const out = mergeBloodLog([line(1), line(2)], [line(1), line(2)], true);
    expect(out.map((l) => l.seq)).toEqual([1, 2]);
  });

  it('序号回退 = 服务端开了新一局：必须重置，不能把新局日志当已见过吞掉', () => {
    const out = mergeBloodLog([line(50), line(51)], [line(1), line(2)], false);
    expect(out.map((l) => l.seq)).toEqual([1, 2]);
  });

  it('空增量 + 非 full：原样保留', () => {
    const buf = [line(1), line(2)];
    expect(mergeBloodLog(buf, [], false).map((l) => l.seq)).toEqual([1, 2]);
  });

  it('空增量 + full：清空（换局首帧尚未产生日志）', () => {
    expect(mergeBloodLog([line(1)], [], true)).toEqual([]);
  });

  it('超出上限时只保留最新的 BLOOD_LOG_CAP 条', () => {
    const many = Array.from({ length: BLOOD_LOG_CAP + 50 }, (_, i) => line(i + 1));
    const out = mergeBloodLog([], many, false);
    expect(out).toHaveLength(BLOOD_LOG_CAP);
    expect(out[0].seq).toBe(51); // 丢的是最早那批
    expect(out[out.length - 1].seq).toBe(BLOOD_LOG_CAP + 50);
  });

  it('不修改传入的本地缓冲（纯函数）', () => {
    const buf = [line(1), line(2)];
    const snapshot = buf.map((l) => l.seq);
    mergeBloodLog(buf, [line(3)], false);
    expect(buf.map((l) => l.seq)).toEqual(snapshot);
  });

  it('缓冲区与增量都为空时返回空数组', () => {
    expect(mergeBloodLog([], [], false)).toEqual([]);
  });
});
