import { describe, expect, it } from 'vitest';
import { formatDueAt, parseExplicitDueAt } from '../../../src/proactive/due';

describe('explicit due parser', () => {
  const timeZone = 'Asia/Shanghai';
  const now = Date.parse('2026-10-09T02:30:00.000Z'); // 2026-10-09 10:30 in Shanghai

  it('parses explicit relative dates and rejects messages without a date', () => {
    expect(parseExplicitDueAt('我明天把报告发出来', now, timeZone)).toBe(
      Date.parse('2026-10-10T10:00:00.000Z'),
    );
    expect(parseExplicitDueAt('这个三天后再跟进', now, timeZone)).toBe(
      Date.parse('2026-10-12T10:00:00.000Z'),
    );
    expect(parseExplicitDueAt('我晚点把报告发出来', now, timeZone)).toBeUndefined();
  });

  it('parses explicit clock times in the configured zone rather than the host timezone', () => {
    const dueAt = parseExplicitDueAt('我明天下午 3 点前把反馈发群里', now, timeZone);
    expect(dueAt).toBe(Date.parse('2026-10-10T07:00:00.000Z'));
    expect(formatDueAt(dueAt!, timeZone)).toMatch(/10\/10.*15:00/);
  });

  it('parses absolute dates and rejects impossible calendar dates', () => {
    expect(parseExplicitDueAt('截止 2026-10-15 14:30', now, timeZone)).toBe(
      Date.parse('2026-10-15T06:30:00.000Z'),
    );
    expect(parseExplicitDueAt('2026-02-30 交付', now, timeZone)).toBeUndefined();
  });

  it('interprets 下周 as the next calendar week', () => {
    expect(parseExplicitDueAt('下周一下午 2 点交周报', now, timeZone)).toBe(
      Date.parse('2026-10-12T06:00:00.000Z'),
    );
  });
});

