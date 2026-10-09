import { describe, expect, it } from 'vitest';
import { parseExplicitDueAt } from '../../../src/proactive/due';

describe('explicit due parser', () => {
  const now = new Date(2026, 9, 9, 10, 30).getTime();

  it('parses explicit relative dates and rejects messages without a date', () => {
    expect(new Date(parseExplicitDueAt('我明天把报告发出来', now)!).getDate()).toBe(10);
    expect(new Date(parseExplicitDueAt('这个三天后再跟进', now)!).getDate()).toBe(12);
    expect(parseExplicitDueAt('我晚点把报告发出来', now)).toBeUndefined();
  });

  it('parses absolute dates and rejects impossible calendar dates', () => {
    expect(new Date(parseExplicitDueAt('截止 2026-10-15 14:30', now)!).getHours()).toBe(14);
    expect(parseExplicitDueAt('2026-02-30 交付', now)).toBeUndefined();
  });
});

