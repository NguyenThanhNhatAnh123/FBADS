// Các thao tác Marketing API mà Agent dùng. Mọi object tạo ra đều ở trạng thái PAUSED;
// chỉ `setStatus(..., 'ACTIVE')` bật lên, và chỉ được gọi sau khi chủ shop bấm duyệt.

import { MetaClient } from './graph.ts';
import { sleep } from '../../shared/telegram.ts';

export interface AccountRefs {
  adAccount: string; // act_...
  pageId: string;
  pixelId: string;
}

export type BidStrategy = 'LOWEST_COST_WITHOUT_CAP' | 'COST_CAP' | 'LOWEST_COST_WITH_BID_CAP';

export interface CampaignInfo {
  id: string;
  name: string;
  account_id?: string;
  effective_status?: string;
  configured_status?: string;
  daily_budget?: string;
  bid_strategy?: string;
  objective?: string;
}

export interface AdsetInfo {
  id: string;
  name: string;
  campaign_id?: string;
  effective_status?: string;
  created_time?: string;
  targeting?: Record<string, unknown>;
  promoted_object?: Record<string, unknown>;
  bid_amount?: string | number;
  optimization_goal?: string;
  billing_event?: string;
  destination_type?: string;
  attribution_spec?: unknown;
}

export interface StatusInfo {
  id: string;
  effective_status?: string;
  configured_status?: string;
  status?: string;
  ad_review_feedback?: unknown;
  issues_info?: unknown;
}

export interface CopyFields {
  primary_text: string;
  headline: string;
  description: string;
}

const ADSET_COPY_FIELDS =
  'id,name,campaign_id,effective_status,created_time,targeting,promoted_object,bid_amount,optimization_goal,billing_event,destination_type,attribution_spec';

export class MetaAds {
  readonly api: MetaClient;
  readonly refs: AccountRefs;
  private readonly sleepFn: (ms: number) => Promise<void>;

  constructor(api: MetaClient, refs: AccountRefs, sleepFn: (ms: number) => Promise<void> = sleep) {
    this.api = api;
    this.refs = refs;
    this.sleepFn = sleepFn;
  }

  // ---- Campaign ----
  async createCampaign(o: { name: string; dailyBudgetCents: number; bidStrategy: BidStrategy }): Promise<string> {
    const r = await this.api.post<{ id: string }>(`${this.refs.adAccount}/campaigns`, {
      name: o.name,
      objective: 'OUTCOME_SALES',
      status: 'PAUSED',
      special_ad_categories: [],
      buying_type: 'AUCTION',
      daily_budget: o.dailyBudgetCents,
      bid_strategy: o.bidStrategy,
    });
    return r.id;
  }

  getCampaign(id: string): Promise<CampaignInfo> {
    return this.api.get<CampaignInfo>(id, { fields: 'id,name,account_id,effective_status,configured_status,daily_budget,bid_strategy,objective' });
  }

  async searchCampaigns(term: string): Promise<CampaignInfo[]> {
    const r = await this.api.get<{ data: CampaignInfo[] }>(`${this.refs.adAccount}/campaigns`, {
      fields: 'id,name,effective_status,daily_budget,bid_strategy',
      filtering: [
        { field: 'name', operator: 'CONTAIN', value: term },
        { field: 'effective_status', operator: 'IN', value: ['ACTIVE', 'PAUSED', 'IN_PROCESS', 'WITH_ISSUES'] },
      ],
      limit: 25,
    });
    return r.data ?? [];
  }

  /** Tìm object theo tên chính xác, tạo sau mốc thời gian — dùng khi chạy tiếp sau sự cố để không tạo trùng. */
  async findByExactName(edge: 'campaigns' | 'adsets' | 'ads', name: string, createdAfterIso: string): Promise<string | null> {
    const r = await this.api.get<{ data: Array<{ id: string; name: string; created_time: string }> }>(`${this.refs.adAccount}/${edge}`, {
      fields: 'id,name,created_time',
      filtering: [{ field: 'name', operator: 'EQUAL', value: name }],
      limit: 10,
    });
    const hit = (r.data ?? []).find((x) => x.name === name && new Date(x.created_time).getTime() >= new Date(createdAfterIso).getTime() - 60_000);
    return hit?.id ?? null;
  }

  async campaignBudgets(ids: string[]): Promise<Record<string, { daily_budget?: string; effective_status?: string }>> {
    const out: Record<string, { daily_budget?: string; effective_status?: string }> = {};
    for (let i = 0; i < ids.length; i += 40) {
      const chunk = ids.slice(i, i + 40);
      const r = await this.api.get<Record<string, { daily_budget?: string; effective_status?: string }>>('', {
        ids: chunk.join(','),
        fields: 'daily_budget,effective_status',
      });
      Object.assign(out, r);
    }
    return out;
  }

  // ---- Adset ----
  async createAdset(o: {
    name: string;
    campaignId: string;
    countries?: string[];
    advantageAudience?: 0 | 1;
    bidAmountCents?: number | null;
    startTimeIso?: string | null;
    copyFrom?: AdsetInfo;
  }): Promise<string> {
    const p: Record<string, unknown> = {
      name: o.name,
      campaign_id: o.campaignId,
      status: 'PAUSED',
    };
    if (o.copyFrom) {
      // #ADD với Adset = mới: sao chép target, pixel, bid từ adset đang chạy đầu tiên của camp.
      const src = o.copyFrom;
      p.optimization_goal = src.optimization_goal ?? 'OFFSITE_CONVERSIONS';
      p.billing_event = src.billing_event ?? 'IMPRESSIONS';
      p.promoted_object = src.promoted_object ?? { pixel_id: this.refs.pixelId, custom_event_type: 'PURCHASE' };
      p.targeting = src.targeting;
      if (src.bid_amount !== undefined && src.bid_amount !== null && src.bid_amount !== '') p.bid_amount = Number(src.bid_amount);
      if (src.destination_type) p.destination_type = src.destination_type;
      if (src.attribution_spec) p.attribution_spec = src.attribution_spec;
    } else {
      p.optimization_goal = 'OFFSITE_CONVERSIONS';
      p.billing_event = 'IMPRESSIONS';
      p.promoted_object = { pixel_id: this.refs.pixelId, custom_event_type: 'PURCHASE' };
      p.targeting = {
        geo_locations: { countries: o.countries ?? [] },
        targeting_automation: { advantage_audience: o.advantageAudience ?? 1 },
      };
      if (o.bidAmountCents) p.bid_amount = o.bidAmountCents;
    }
    if (o.startTimeIso) p.start_time = o.startTimeIso;
    const r = await this.api.post<{ id: string }>(`${this.refs.adAccount}/adsets`, p as Record<string, string | number | object>);
    return r.id;
  }

  getAdset(id: string): Promise<AdsetInfo> {
    return this.api.get<AdsetInfo>(id, { fields: ADSET_COPY_FIELDS });
  }

  async listAdsetsOfCampaign(campaignId: string): Promise<AdsetInfo[]> {
    const r = await this.api.get<{ data: AdsetInfo[] }>(`${campaignId}/adsets`, { fields: ADSET_COPY_FIELDS, limit: 100 });
    return (r.data ?? []).sort((a, b) => String(a.created_time).localeCompare(String(b.created_time)));
  }

  // ---- Media ----
  async uploadImage(filePath: string): Promise<string> {
    const r = await this.api.upload<{ images: Record<string, { hash: string }> }>(`${this.refs.adAccount}/adimages`, 'filename', filePath);
    const first = Object.values(r.images ?? {})[0];
    if (!first?.hash) throw new Error('Meta không trả image_hash');
    return first.hash;
  }

  async uploadVideo(filePath: string, name: string): Promise<string> {
    const r = await this.api.upload<{ id: string }>(`${this.refs.adAccount}/advideos`, 'source', filePath, { name }, 'video');
    if (!r.id) throw new Error('Meta không trả video_id');
    return r.id;
  }

  /** Hỏi trạng thái mỗi `intervalMs` đến khi video_status = ready (tối đa `timeoutMs`). */
  async waitVideoReady(videoId: string, timeoutMs = 10 * 60_000, intervalMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const r = await this.api.get<{ status?: { video_status?: string; processing_progress?: number } }>(videoId, { fields: 'status' });
      const st = r.status?.video_status;
      if (st === 'ready') return;
      if (st === 'error') throw new VideoProcessingError(videoId, 'Meta báo lỗi xử lý video');
      if (Date.now() + intervalMs > deadline) throw new VideoProcessingError(videoId, `Video xử lý quá ${Math.round(timeoutMs / 60000)} phút`);
      await this.sleepFn(intervalMs);
    }
  }

  async videoThumbnail(videoId: string): Promise<string> {
    const r = await this.api.get<{ data: Array<{ uri: string; is_preferred?: boolean }> }>(`${videoId}/thumbnails`, { fields: 'uri,is_preferred' });
    const list = r.data ?? [];
    const pick = list.find((t) => t.is_preferred) ?? list[0];
    if (!pick?.uri) throw new Error(`Video ${videoId} chưa có thumbnail`);
    return pick.uri;
  }

  // ---- Creative / Post ----
  async createCreative(o: {
    name: string;
    link: string;
    copy: CopyFields;
    video?: { videoId: string; thumbnailUrl: string };
    imageHash?: string;
  }): Promise<string> {
    const cta = { type: 'SHOP_NOW', value: { link: o.link } };
    const spec: Record<string, unknown> = { page_id: this.refs.pageId };
    if (o.video) {
      spec.video_data = {
        video_id: o.video.videoId,
        image_url: o.video.thumbnailUrl,
        message: o.copy.primary_text,
        title: o.copy.headline,
        link_description: o.copy.description,
        call_to_action: cta,
      };
    } else if (o.imageHash) {
      spec.link_data = {
        image_hash: o.imageHash,
        link: o.link,
        message: o.copy.primary_text,
        name: o.copy.headline,
        description: o.copy.description,
        call_to_action: cta,
      };
    } else throw new Error('createCreative cần video hoặc image_hash');
    const r = await this.api.post<{ id: string }>(`${this.refs.adAccount}/adcreatives`, { name: o.name, object_story_spec: spec });
    return r.id;
  }

  /** Dùng lại bài có sẵn: like, comment, share dồn về một bài. */
  async createCreativeFromPost(postId: string, name: string): Promise<string> {
    const r = await this.api.post<{ id: string }>(`${this.refs.adAccount}/adcreatives`, { name, object_story_id: postId });
    return r.id;
  }

  /** Đọc Post ID ({page_id}_{post_id}) của creative; hỏi lại mỗi 5 giây, tối đa 2 phút. */
  async waitPostId(creativeId: string, timeoutMs = 120_000, intervalMs = 5_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const r = await this.api.get<{ effective_object_story_id?: string }>(creativeId, { fields: 'effective_object_story_id' });
      if (r.effective_object_story_id) return r.effective_object_story_id;
      if (Date.now() + intervalMs > deadline) throw new Error(`Creative ${creativeId} chưa có Post ID sau ${Math.round(timeoutMs / 1000)} giây`);
      await this.sleepFn(intervalMs);
    }
  }

  async getPost(postId: string): Promise<{ id: string; permalink_url?: string }> {
    return this.api.get(postId, { fields: 'id,permalink_url' });
  }

  // ---- Ad ----
  async createAd(o: { name: string; adsetId: string; creativeId: string }): Promise<string> {
    const r = await this.api.post<{ id: string }>(`${this.refs.adAccount}/ads`, {
      name: o.name,
      adset_id: o.adsetId,
      creative: { creative_id: o.creativeId },
      status: 'PAUSED',
    });
    return r.id;
  }

  async updateAdCreative(adId: string, creativeId: string): Promise<void> {
    await this.api.post(adId, { creative: { creative_id: creativeId } });
  }

  /** Link preview của ad; trả về null nếu Meta không cho preview định dạng đó. */
  async preview(adId: string, format: 'MOBILE_FEED_STANDARD' | 'INSTAGRAM_REELS' | 'INSTAGRAM_STANDARD'): Promise<string | null> {
    const r = await this.api.get<{ data: Array<{ body: string }> }>(`${adId}/previews`, { ad_format: format });
    const body = r.data?.[0]?.body;
    return body ? extractIframeSrc(body) : null;
  }

  // ---- Trạng thái ----
  async setStatus(id: string, status: 'ACTIVE' | 'PAUSED'): Promise<void> {
    await this.api.post(id, { status });
  }

  async deleteObject(id: string): Promise<void> {
    await this.api.delete(id);
  }

  async readStatuses(ids: string[], withReview = false): Promise<Record<string, StatusInfo>> {
    if (!ids.length) return {};
    const fields = withReview ? 'effective_status,configured_status,ad_review_feedback,issues_info' : 'effective_status,configured_status';
    const out: Record<string, StatusInfo> = {};
    for (let i = 0; i < ids.length; i += 40) {
      const r = await this.api.get<Record<string, StatusInfo>>('', { ids: ids.slice(i, i + 40).join(','), fields });
      Object.assign(out, r);
    }
    return out;
  }

  // ---- Thanh toán (Giai đoạn 2, bridge bọc thành tool get_billing_status) ----
  async billingStatus(): Promise<Record<string, unknown>> {
    const acct = await this.api.get<Record<string, unknown>>(this.refs.adAccount, {
      fields: 'name,currency,account_status,disable_reason,balance,amount_spent,spend_cap,funding_source_details',
    });
    let threshold: unknown = null;
    try {
      const cyc = await this.api.get<{ data?: Array<Record<string, unknown>> }>(`${this.refs.adAccount}/adspaymentcycle`);
      threshold = cyc.data?.[0] ?? null;
    } catch (err) {
      threshold = { error: (err as Error).message };
    }
    return { account: acct, payment_cycle: threshold };
  }
}

export class VideoProcessingError extends Error {
  readonly videoId: string;
  constructor(videoId: string, msg: string) {
    super(msg);
    this.videoId = videoId;
  }
}

export function extractIframeSrc(html: string): string | null {
  const m = /src="([^"]+)"/.exec(html);
  if (!m) return null;
  return m[1].replace(/&amp;/g, '&');
}

export function bidStrategyFor(runType: 'Auto' | 'CC' | 'BidCap'): BidStrategy {
  return runType === 'CC' ? 'COST_CAP' : runType === 'BidCap' ? 'LOWEST_COST_WITH_BID_CAP' : 'LOWEST_COST_WITHOUT_CAP';
}

export function usdToCents(usd: number): number {
  return Math.round(usd * 100);
}
