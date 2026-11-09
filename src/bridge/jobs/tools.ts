// Server MCP "adsjob" cho tiến trình `claude -p` của MỘT lượt chạy.
// Địa chỉ: POST http://127.0.0.1:<bridge>/job-mcp/<token> — token ngẫu nhiên 256 bit, chỉ hợp lệ khi lượt đó đang chạy.
// Mỗi loại lượt chỉ thấy đúng các tool của nó (JOB_TOOLS); kết quả Claude nộp được bridge soát lại.

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { sleep } from '../../shared/telegram.ts';
import type { ActiveRun, JobManager } from './manager.ts';
import { JOB_TOOLS } from './prompts.ts';
import { activationShape, budgetShape, cancelShape, checkCopyShape, choiceShape, draftsShape, failureShape } from './validate.ts';
import type { ActivationPayload, CancelPayload, DraftsPayload, FailurePayload } from './validate.ts';
import type { CopyVariant } from '../../agent/copy/rules.ts';
import { MediaError } from '../media.ts';

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
const ok = (data: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });
const bad = (data: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(data) }], isError: true });

export function buildJobMcpServer(m: JobManager, a: ActiveRun): McpServer {
  const server = new McpServer({ name: 'adsjob', version: '1.0.0' });
  const allowed = new Set(JOB_TOOLS[a.kind]);
  const reg = (name: string, def: { title: string; description: string; inputSchema: Record<string, z.ZodTypeAny> }, fn: (args: any) => Promise<ToolResult>) => {
    if (!allowed.has(name)) return;
    server.registerTool(name, def, async (args: any) => {
      try {
        return await fn(args);
      } catch (err) {
        return bad({ error: (err as Error).message });
      }
    });
  };

  reg('stage_drive_media', {
    title: 'Stage media từ Drive', description: 'Tải file vào cache bridge, trả link HTTPS tạm và metadata ffprobe; không ghi lên Meta. Chỉ lượt create chạy thật.',
    inputSchema: { file_id: z.string().regex(/^[A-Za-z0-9_-]{10,200}$/), ttl_hours: z.number().positive().max(24).optional() },
  }, async ({ file_id, ttl_hours }) => {
    try { return ok(await m.stageMedia(a, file_id, ttl_hours)); }
    catch (error) { return bad({ error: error instanceof MediaError ? error.code : 'download_failed', message: error instanceof MediaError ? error.message : 'Không tải được media từ Drive.' }); }
  });

  reg(
    'get_job',
    { title: 'Thông tin brief', description: 'Brief, giá trị bắt buộc (tên, budget theo cent, bid), thông tin tài khoản và bản nháp hiện tại của lượt chạy này. Chỉ đọc.', inputSchema: {} },
    async () => ok(m.jobContext(a)),
  );

  reg(
    'wait',
    { title: 'Chờ', description: 'Chờ một lúc (ví dụ chờ Meta xử lý video, chờ publish). Tối đa 60 giây mỗi lần.', inputSchema: { seconds: z.number().int().min(1).max(60) } },
    async ({ seconds }) => {
      await sleep(seconds * 1000);
      return ok({ waited_s: seconds });
    },
  );

  reg(
    'report_progress',
    { title: 'Báo tiến độ', description: 'Cập nhật dòng trạng thái của brief trên Telegram (một câu tiếng Việt ngắn, ví dụ "Đang tải 2 video lên Meta…").', inputSchema: { text: z.string().min(1).max(500) } },
    async ({ text }) => {
      await m.onProgress(a, text);
      return ok({ ok: true });
    },
  );

  reg(
    'check_budget',
    {
      title: 'Kiểm tra trần ngân sách',
      description: 'Gửi daily_budget (cent) và effective_status đọc live của các campaign bridge đang quản lý (danh sách trong prompt). Bridge tính tổng; stop=true nghĩa là vượt trần → dừng ngay, không tạo gì.',
      inputSchema: budgetShape,
    },
    async ({ campaigns }) => {
      const r = await m.onCheckBudget(a, campaigns);
      return r.ok ? ok(r) : bad(r);
    },
  );

  reg(
    'check_copy',
    {
      title: 'Soát copy',
      description: 'Soát 2–3 phương án copy theo quy tắc của shop (từ cấm, tên bộ tộc, ưu đãi không có trên trang, IN HOA, emoji, độ dài headline / hook / description, số dòng). Gọi trước khi tạo creative; còn issues thì viết lại.',
      inputSchema: checkCopyShape,
    },
    async ({ variants, product_page_text }) => {
      const r = m.checkCopy(variants as CopyVariant[], product_page_text);
      return r.ok ? ok(r) : bad(r);
    },
  );

  reg(
    'need_choice',
    {
      title: 'Hỏi chủ shop chọn campaign',
      description: 'Chỉ dùng cho #ADD khi trường Camp khớp nhiều campaign: gửi danh sách (tối đa 8) để chủ shop bấm chọn. Gọi xong thì kết thúc lượt, không tạo gì.',
      inputSchema: choiceShape,
    },
    async ({ question, options }) => {
      const r = await m.onNeedChoice(a, question, options);
      return r.ok ? ok(r) : bad(r);
    },
  );

  reg(
    'submit_drafts',
    {
      title: 'Nộp bản nháp',
      description:
        'Nộp toàn bộ bản nháp đã dựng (campaign, adset, media, các phương án copy, ad, preview). Bridge soát tên, budget, bid, trạng thái và copy; ok=false kèm errors thì sửa đúng chỗ rồi nộp lại. ok=true: tin duyệt đã gửi cho chủ shop → kết thúc lượt.',
      inputSchema: draftsShape,
    },
    async (p) => {
      const r = await m.onSubmitDrafts(a, p as DraftsPayload);
      return r.ok ? ok(r) : bad(r);
    },
  );

  reg(
    'submit_activation',
    { title: 'Nộp kết quả bật', description: 'Báo kết quả bật: trạng thái đọc lại của từng object được duyệt, bản nháp đã bỏ, lỗi Meta nếu có.', inputSchema: activationShape },
    async (p) => {
      const r = await m.onSubmitActivation(a, p as ActivationPayload);
      return r.ok ? ok(r) : bad(r);
    },
  );

  reg(
    'submit_cancel',
    { title: 'Nộp kết quả huỷ', description: 'Báo các object đã xoá và object còn sót.', inputSchema: cancelShape },
    async (p) => {
      const r = await m.onSubmitCancel(a, p as CancelPayload);
      return r.ok ? ok(r) : bad(r);
    },
  );

  reg(
    'report_failure',
    {
      title: 'Báo lỗi',
      description: 'Dừng brief và báo chủ shop: lý do (tiếng Việt), nguyên văn lỗi Meta, ID còn sót. Dọn object nháp do lượt này tạo TRƯỚC khi gọi.',
      inputSchema: failureShape,
    },
    async (p) => {
      const r = await m.onFailure(a, p as FailurePayload);
      return r.ok ? ok(r) : bad(r);
    },
  );

  return server;
}
