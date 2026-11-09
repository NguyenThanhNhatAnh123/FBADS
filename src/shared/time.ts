// Đổi khung giờ giữa múi giờ tài khoản quảng cáo (America/Dawson), giờ VN và giờ store (PST).
// Giai đoạn 1 dùng cho start_time của adset; Giai đoạn 2 dùng cho khung báo cáo 07:00 → 07:00 UTC.

export const TZ_ACCOUNT = 'America/Dawson';
export const TZ_VN = 'Asia/Ho_Chi_Minh';
export const TZ_STORE = 'America/Los_Angeles';

/** Offset (phút) của múi giờ `tz` tại thời điểm `at`, ví dụ Dawson = -420. */
export function tzOffsetMinutes(tz: string, at: Date = new Date()): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p = Object.fromEntries(dtf.formatToParts(at).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60000);
}

/** Ngày lịch (y, m, d) ở múi giờ `tz` tại thời điểm `at`. */
export function calendarDate(tz: string, at: Date = new Date()): { y: number; m: number; d: number } {
  const dtf = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const [y, m, d] = dtf.format(at).split('-').map(Number);
  return { y, m, d };
}

/** Thời điểm UTC ứng với 00:00 ngày (y, m, d) ở múi giờ `tz`. */
export function startOfDayUtc(tz: string, y: number, m: number, d: number): Date {
  const guess = new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
  const off = tzOffsetMinutes(tz, guess);
  const first = new Date(guess.getTime() - off * 60000);
  // Hiệu chỉnh lần hai cho trường hợp đổi giờ mùa hè ngay trong ngày.
  const off2 = tzOffsetMinutes(tz, first);
  return off2 === off ? first : new Date(guess.getTime() - off2 * 60000);
}

/** Khung "ngày quảng cáo vừa chốt" theo múi giờ tài khoản: [since, until) dạng UTC. */
export function lastClosedAdDay(at: Date = new Date(), tz = TZ_ACCOUNT): { since: Date; until: Date; label: string } {
  const today = calendarDate(tz, at);
  const until = startOfDayUtc(tz, today.y, today.m, today.d);
  const prev = new Date(until.getTime() - 12 * 3600_000);
  const p = calendarDate(tz, prev);
  const since = startOfDayUtc(tz, p.y, p.m, p.d);
  return { since, until, label: `${pad(p.d)}/${pad(p.m)}/${p.y}` };
}

/** Định dạng dd/MM/yyyy theo múi giờ. */
export function formatDate(at: Date, tz: string): string {
  const { y, m, d } = calendarDate(tz, at);
  return `${pad(d)}/${pad(m)}/${y}`;
}

/** Định dạng HH:mm dd/MM theo múi giờ (dùng trong tin Telegram). */
export function formatDateTime(at: Date, tz = TZ_VN): string {
  const dtf = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
    day: '2-digit',
    month: '2-digit',
  });
  const p = Object.fromEntries(dtf.formatToParts(at).map((x) => [x.type, x.value]));
  return `${p.hour}:${p.minute} ${p.day}/${p.month}`;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
