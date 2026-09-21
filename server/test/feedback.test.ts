import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { clearFeedback, initFeedbackStore, listFeedback, submitFeedback } from '../src/feedback';

const NOW = 1_700_000_000_000;

function tmpFile(): string {
  return path.join(os.tmpdir(), `feedback-test-${Math.random().toString(36).slice(2)}.jsonl`);
}

describe('玩家反馈存储', () => {
  let file: string;
  beforeEach(() => {
    vi.setSystemTime(new Date(NOW));
    file = tmpFile();
  });
  afterEach(() => {
    vi.useRealTimers();
    try {
      fs.unlinkSync(file);
    } catch {
      /* 忽略 */
    }
  });

  it('正常提交：落盘并计入列表（附带房间码/昵称/联系方式）', () => {
    initFeedbackStore(file);
    const err = submitFeedback({ text: '  对局中某个按钮无效  ', contact: 'QQ 123', room: 'X7K2', name: '玩家甲' }, '1.1.1.1', NOW);
    expect(err).toBeNull();
    const all = listFeedback();
    expect(all.length).toBe(1);
    expect(all[0].text).toBe('对局中某个按钮无效');
    expect(all[0].contact).toBe('QQ 123');
    expect(all[0].room).toBe('X7K2');
    expect(all[0].name).toBe('玩家甲');
    expect(all[0].ip).toBe('1.1.1.1');
    // 文件已写入一行
    expect(fs.readFileSync(file, 'utf-8').trim().split('\n').length).toBe(1);
  });

  it('空文本与超长文本拒绝', () => {
    initFeedbackStore(file);
    expect(submitFeedback({ text: '   ' }, '1.1.1.1', NOW)).toBe('EMPTY');
    expect(submitFeedback({ text: '长'.repeat(501) }, '1.1.1.1', NOW)).toBe('TOO_LONG');
    expect(listFeedback().length).toBe(0);
  });

  it('限流：同 IP 每小时最多 5 条，不同 IP 不受影响', () => {
    initFeedbackStore(file);
    for (let i = 0; i < 5; i++) {
      expect(submitFeedback({ text: `问题${i}` }, '2.2.2.2', NOW)).toBeNull();
    }
    expect(submitFeedback({ text: '第 6 条' }, '2.2.2.2', NOW)).toBe('RATE_LIMITED');
    expect(submitFeedback({ text: '另一个 IP 的反馈' }, '3.3.3.3', NOW)).toBeNull();
  });

  it('重启恢复：重新 init 同一文件能读回历史反馈（坏行跳过，超出 500 条截断）', () => {
    const f = tmpFile();
    initFeedbackStore(f);
    for (let i = 0; i < 505; i++) {
      expect(submitFeedback({ text: `反馈 ${i}` }, `9.9.9.${i % 200}`, NOW + i)).toBeNull();
    }
    expect(listFeedback().length).toBe(500);
    // 模拟重启：指向同一文件重新初始化
    initFeedbackStore(f);
    const all = listFeedback();
    expect(all.length).toBe(500);
    expect(all[0].text).toBe('反馈 5'); // 最旧的 5 条被淘汰
    expect(all[499].text).toBe('反馈 504');
    fs.unlinkSync(f);
  });
});


describe('清空反馈', () => {
  it('clearFeedback：清空内存与文件，之后可继续提交', () => {
    const f = tmpFile();
    initFeedbackStore(f);
    submitFeedback({ text: '问题1' }, '2.2.2.2', NOW);
    submitFeedback({ text: '问题2' }, '3.3.3.3', NOW + 1);
    clearFeedback();
    expect(listFeedback().length).toBe(0);
    expect(fs.readFileSync(f, 'utf-8')).toBe('');
    // 清空后可继续正常提交
    expect(submitFeedback({ text: '新的反馈' }, '4.4.4.4', NOW + 2)).toBeNull();
    expect(listFeedback().length).toBe(1);
    fs.unlinkSync(f);
  });
});
