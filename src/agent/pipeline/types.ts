import type { AgentConfig } from '../config.ts';
import type { AgentStore, RequestRow } from '../db.ts';
import type { TelegramApi } from '../../shared/telegram.ts';
import type { MetaAds } from '../meta/ads.ts';
import type { DriveService } from '../drive.ts';
import type { ShopifyService, ProductInfo } from '../shopify.ts';
import type { CopyWriter } from '../copy/writer.ts';
import type { Brief } from '../brief/parse.ts';
import type * as mediaTools from '../media.ts';

export type MediaTools = Pick<typeof mediaTools, 'probe' | 'checkMedia' | 'extractFrames' | 'shrinkImage' | 'sha256File'>;

export interface Deps {
  cfg: AgentConfig;
  store: AgentStore;
  tg: TelegramApi;
  meta: MetaAds;
  drive: DriveService;
  shopify: ShopifyService;
  copy: CopyWriter;
  media: MediaTools;
  now?: () => Date;
}

/** Dữ liệu trung gian của một brief, lưu trong requests.context_json. */
export interface RequestContext {
  brief?: Brief;
  warnings?: string[];
  product?: ProductInfo;
  productName?: string;
  campaign?: { id: string; name: string; owned: boolean; bidStrategy?: string; dailyBudget?: string };
  adset?: { id: string; name: string; owned: boolean; copiedFrom?: string };
  campaignCandidates?: Array<{ id: string; name: string; status?: string }>;
  pendingConfirm?: string[];
  confirmMessageId?: number;
  editPromptMessageId?: number;
  editFeedback?: string | null;
  approvalText?: string;
  waitingReason?: 'drive' | 'token' | 'confirm' | 'campaign_choice' | null;
  failedStep?: string;
  dateLabel?: string;
  resumed?: boolean;
}

/** Dừng brief và báo lỗi cho chủ shop (sau khi dọn object Meta của brief). */
export class StopError extends Error {}

/** Brief chờ chủ shop làm gì đó (share Drive, chọn camp...) — không dọn gì, chạy tiếp bằng /retry hoặc nút. */
export class WaitError extends Error {
  readonly reason: NonNullable<RequestContext['waitingReason']>;
  constructor(reason: NonNullable<RequestContext['waitingReason']>, msg: string) {
    super(msg);
    this.reason = reason;
  }
}

export interface StepEnv {
  deps: Deps;
  req: RequestRow;
  ctx: RequestContext;
  /** Đọc lại request + context từ DB (sau khi bước trước đã ghi). */
  reload(): void;
  patch(p: Partial<RequestContext>): void;
  warn(msg: string): void;
}
