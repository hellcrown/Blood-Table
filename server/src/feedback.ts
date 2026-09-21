/**
 * 玩家反馈存储：JSONL 追加落盘 + 内存保留最近 500 条。
 * - 文件：server/data/feedback.jsonl，每行一条 JSON（时间/房间码/昵称/内容/联系方式/IP）
 * - 重启：initFeedbackStore 从文件尾部恢复最近 MAX_FEEDBACK 条（容错坏行）
 * - 限流：单 IP 每小时最多 5 条（SlidingWindow）
 */
import fs from 'node:fs';
import path from 'node:path';
import { IpTable, SlidingWindow } from './net/limits';

export interface FeedbackEntry {
  /** 提交时间（epoch ms） */
  t: number;
  /** 房间码（对局内反馈时附带，可为空） */
  room?: string;
  /** 提交者昵称（可得时附带，可为空） */
  name?: string;
  /** 问题描述（≤500 字） */
  text: string;
  /** 联系方式（选填，≤50 字） */
  contact?: string;
  /** 来源 IP（仅管理员可见，供封禁参考） */
  ip?: string;
}

const MAX_FEEDBACK = 500;
const MAX_TEXT = 500;
const MAX_CONTACT = 50;

let file: string | null = null;
const list: FeedbackEntry[] = [];
const ipLimit = new IpTable(
  () => new SlidingWindow(3_600_000, 5),
  (w, now) => w.idle(now),
);
setInterval(() => ipLimit.prune(), 30 * 60_000).unref();

export type FeedbackError = 'EMPTY' | 'TOO_LONG' | 'RATE_LIMITED';

/** 启动时调用：从文件尾部恢复最近 MAX_FEEDBACK 条（目录自动创建，坏行跳过） */
export function initFeedbackStore(filePath: string): void {
  file = filePath;
  list.length = 0;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, '');
      return;
    }
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed) as FeedbackEntry;
        if (typeof entry?.t === 'number' && typeof entry?.text === 'string') list.push(entry);
      } catch {
        /* 尾部半行或坏行：跳过 */
      }
    }
    if (list.length > MAX_FEEDBACK) list.splice(0, list.length - MAX_FEEDBACK);
  } catch (e) {
    console.error('[feedback] 初始化存储失败（反馈暂存内存）:', e);
  }
}

/** 提交一条反馈；通过校验与限流则落盘并返回 null，否则返回错误码 */
export function submitFeedback(
  input: { text?: unknown; contact?: unknown; room?: unknown; name?: unknown },
  ip: string,
  now = Date.now(),
): FeedbackError | null {
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  if (!text) return 'EMPTY';
  if (text.length > MAX_TEXT) return 'TOO_LONG';
  const contact = typeof input.contact === 'string' ? input.contact.trim().slice(0, MAX_CONTACT) : '';
  if (!ipLimit.get(ip).allow(now)) return 'RATE_LIMITED';

  const entry: FeedbackEntry = {
    t: now,
    text,
    ...(contact ? { contact } : {}),
    ...(typeof input.room === 'string' && input.room ? { room: input.room.slice(0, 8) } : {}),
    ...(typeof input.name === 'string' && input.name ? { name: input.name.slice(0, 12) } : {}),
    ip,
  };
  list.push(entry);
  if (list.length > MAX_FEEDBACK) list.splice(0, list.length - MAX_FEEDBACK);
  if (file) {
    try {
      fs.appendFileSync(file, JSON.stringify(entry) + '\n');
      // 文件轮转：超过 1MB 重写为最近 200 条，避免无限膨胀
      if (fs.statSync(file).size > 1024 * 1024) {
        const keep = list.slice(-200);
        fs.writeFileSync(
          file,
          keep
            .map((e2) => JSON.stringify(e2))
            .join('\n') + '\n',
        );
      }
    } catch (e) {
      console.error('[feedback] 落盘失败（已保留内存）:', e);
    }
  }
  return null;
}

/** 管理员查看：全部反馈（含 IP） */
export function listFeedback(): FeedbackEntry[] {
  return list.slice();
}

/** 管理员清空全部反馈（内存与文件） */
export function clearFeedback(): void {
  list.length = 0;
  if (file) {
    try {
      fs.writeFileSync(file, '');
    } catch (e) {
      console.error('[feedback] 清空文件失败:', e);
    }
  }
}
