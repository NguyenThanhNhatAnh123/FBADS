// callback_data của nút Agent: `ag:{request_id}:{action}:{version}:{chữ ký}`.
// Chữ ký = HMAC-SHA256 rút gọn; version tăng mỗi lần gửi tin duyệt mới nên nút của tin cũ hết hiệu lực.
// Telegram giới hạn callback_data 64 byte.

import { createHmac, timingSafeEqual } from 'node:crypto';

export type Action =
  | 'ok' // Duyệt & chạy
  | 'v1'
  | 'v2'
  | 'v3' // Chỉ V1 / V2 / V3
  | 'ed' // Sửa copy
  | 'cx' // Huỷ
  | 'cf' // Xác nhận tạo (budget lớn / cap lạ / brief trùng)
  | 'cn' // Không tạo
  | `c${number}`; // chọn campaign thứ n trong danh sách (#ADD)

export interface ParsedCallback {
  requestId: number;
  action: Action;
  version: number;
}

function sig(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url').slice(0, 12);
}

export function signCallback(secret: string, requestId: number, action: Action, version: number): string {
  const payload = `${requestId}:${action}:${version}`;
  const data = `ag:${payload}:${sig(secret, payload)}`;
  if (Buffer.byteLength(data) > 64) throw new Error('callback_data dài quá 64 byte');
  return data;
}

export function verifyCallback(secret: string, data: string): ParsedCallback | null {
  const m = /^ag:(\d+):([a-z]\w{0,3}):(\d+):([A-Za-z0-9_-]{12})$/.exec(data);
  if (!m) return null;
  const payload = `${m[1]}:${m[2]}:${m[3]}`;
  const expected = Buffer.from(sig(secret, payload));
  const got = Buffer.from(m[4]);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null;
  return { requestId: Number(m[1]), action: m[2] as Action, version: Number(m[3]) };
}
