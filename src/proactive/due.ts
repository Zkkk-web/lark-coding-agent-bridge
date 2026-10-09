const DAY_MS = 24 * 60 * 60 * 1_000;

/** Parse only dates that are explicitly present in the message. */
export function parseExplicitDueAt(text: string, now: number): number | undefined {
  const relative = text.match(/([一二三四五六七八九十\d]{1,3})\s*天后/);
  if (relative?.[1]) {
    const days = parseDayCount(relative[1]);
    if (days !== undefined) return endOfWorkday(addDays(now, days));
  }

  if (/大后天/.test(text)) return endOfWorkday(addDays(now, 3));
  if (/后天/.test(text)) return endOfWorkday(addDays(now, 2));
  if (/明天|明日/.test(text)) return endOfWorkday(addDays(now, 1));
  if (/今天|今日|今晚/.test(text)) return endOfWorkday(now);

  const iso = text.match(/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})(?:\s+(\d{1,2}):?(\d{2})?)?/);
  if (iso) {
    return localDate(Number(iso[1]), Number(iso[2]), Number(iso[3]), iso[4], iso[5]);
  }

  const monthDay = text.match(/(?:(20\d{2})年)?(\d{1,2})月(\d{1,2})[日号]?(?:\s*(\d{1,2})(?::|点)(\d{1,2})?分?)?/);
  if (monthDay) {
    const base = new Date(now);
    let year = monthDay[1] ? Number(monthDay[1]) : base.getFullYear();
    let candidate = localDate(
      year,
      Number(monthDay[2]),
      Number(monthDay[3]),
      monthDay[4],
      monthDay[5],
    );
    if (candidate === undefined) return undefined;
    if (!monthDay[1] && candidate < now) {
      year += 1;
      candidate = localDate(year, Number(monthDay[2]), Number(monthDay[3]), monthDay[4], monthDay[5]);
    }
    return candidate;
  }

  const weekday = text.match(/(?:本|这|下)?(?:周|星期)([一二三四五六日天])/);
  if (weekday) {
    const captured = weekday[1];
    if (!captured) return undefined;
    const wanted = '日一二三四五六'.indexOf(captured === '天' ? '日' : captured);
    const today = new Date(now).getDay();
    let delta = (wanted - today + 7) % 7;
    if (/下(?:周|星期)/.test(text)) delta += delta === 0 ? 7 : 7;
    else if (delta === 0 && endOfWorkday(now) <= now) delta = 7;
    return endOfWorkday(addDays(now, delta));
  }

  return undefined;
}

function addDays(timestamp: number, days: number): number {
  const date = new Date(timestamp);
  date.setDate(date.getDate() + days);
  return date.getTime();
}

function endOfWorkday(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(18, 0, 0, 0);
  return date.getTime();
}

function localDate(
  year: number,
  month: number,
  day: number,
  hour?: string,
  minute?: string,
): number | undefined {
  const date = new Date(
    year,
    month - 1,
    day,
    hour === undefined ? 18 : Number(hour),
    minute === undefined ? 0 : Number(minute),
    0,
    0,
  );
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return undefined;
  }
  return date.getTime();
}

export function formatDueAt(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(timestamp));
}

export { DAY_MS };

function parseDayCount(value: string): number | undefined {
  if (/^\d+$/.test(value)) {
    const parsed = Number(value);
    return parsed >= 1 && parsed <= 99 ? parsed : undefined;
  }
  const digits: Record<string, number> = {
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  if (value === '十') return 10;
  if (value.startsWith('十')) return 10 + (digits[value[1] ?? ''] ?? 0);
  if (value.endsWith('十')) return (digits[value[0] ?? ''] ?? 0) * 10;
  if (value.includes('十')) {
    const [tens, ones] = value.split('十');
    return (digits[tens ?? ''] ?? 0) * 10 + (digits[ones ?? ''] ?? 0);
  }
  return digits[value];
}
