// Deliberately separate from the ads writer: only fixed GET endpoints on H3.
export interface BillingConfig { token: string; apiVersion: string }
export class BillingError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
export const H3_ACCOUNT_ID = '25496622559924808';
export const BILLING_FIELDS = 'name,currency,account_status,disable_reason,balance,amount_spent,spend_cap,is_prepay_account,funding_source_details';
const STATUS: Record<number, string> = { 1: 'ACTIVE', 2: 'DISABLED', 3: 'UNSETTLED', 7: 'PENDING_RISK_REVIEW', 8: 'PENDING_SETTLEMENT', 9: 'IN_GRACE_PERIOD', 100: 'PENDING_CLOSURE', 101: 'CLOSED', 201: 'ANY_ACTIVE', 202: 'ANY_CLOSED' };
const cents = (v: unknown): number | null => {
  if (typeof v !== 'number' && (typeof v !== 'string' || !/^-?\d+$/.test(v))) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : null;
};
function funding(details: unknown): string | null {
  if (!details || typeof details !== 'object') return null;
  const d = details as Record<string, unknown>;
  const text = [d.display_string, d.brand, d.type].filter(v => typeof v === 'string').join(' ');
  const brand = /visa/i.test(text) ? 'Visa' : /master\s*card/i.test(text) ? 'Mastercard' : /amex|american express/i.test(text) ? 'Amex' : /paypal/i.test(text) ? 'PayPal' : /discover/i.test(text) ? 'Discover' : /union\s*pay/i.test(text) ? 'UnionPay' : /\bjcb\b/i.test(text) ? 'JCB' : 'Payment method';
  const digits = String(d.last4 ?? d.last_four ?? d.display_string ?? '').replace(/\D/g, '');
  return brand + (digits.length >= 4 ? ` ••${digits.slice(-4)}` : '');
}
export class ReadonlyBilling {
  private readonly cfg: BillingConfig;
  private readonly request: typeof fetch;
  constructor(cfg: BillingConfig, request: typeof fetch = fetch) { this.cfg = cfg; this.request = request; }
  get configured(): boolean { return !!this.cfg.token; }
  private async get(edge: '' | '/adspaymentcycle', fields: string): Promise<Record<string, unknown>> {
    if (!this.configured) throw new BillingError('not_configured', 'Chưa cấu hình META_READ_TOKEN (ads_read trên H3); không thể đọc số dư thật.');
    if (!/^v\d+\.\d+$/.test(this.cfg.apiVersion)) throw new BillingError('invalid_config', 'META_API_VERSION không hợp lệ.');
    const url = new URL(`https://graph.facebook.com/${this.cfg.apiVersion}/act_${H3_ACCOUNT_ID}${edge}`);
    url.searchParams.set('fields', fields);
    if (edge) url.searchParams.set('limit', '100');
    let response: Response;
    try { response = await this.request(url, { method: 'GET', headers: { authorization: `Bearer ${this.cfg.token}` }, redirect: 'error', signal: AbortSignal.timeout(30_000) }); }
    catch { throw new BillingError('meta_unavailable', 'Không kết nối được Graph API để đọc thanh toán.'); }
    let body: Record<string, unknown>;
    try { body = await response.json() as Record<string, unknown>; }
    catch { throw new BillingError('meta_unavailable', 'Graph API không trả JSON hợp lệ.'); }
    if (!response.ok || body.error) {
      const code = (body.error as { code?: number } | undefined)?.code;
      // Never echo Graph response text: it can include payment details or URLs.
      throw new BillingError(code === 190 ? 'invalid_token' : 'meta_read_failed', `Graph API từ chối đọc dữ liệu thanh toán (HTTP ${response.status}, mã ${code ?? 'unknown'}). Kiểm tra quyền ads_read và quyền trên H3.`);
    }
    return body;
  }
  async read(): Promise<Record<string, unknown>> {
    let account: Record<string, unknown>;
    const warnings: string[] = [];
    try { account = await this.get('', BILLING_FIELDS); }
    catch (error) {
      if (!(error instanceof BillingError) || error.code !== 'meta_read_failed') throw error;
      account = await this.get('', 'name,currency,account_status,disable_reason,balance,amount_spent,spend_cap');
      warnings.push('Meta không cho đọc thông tin nguồn tiền hoặc is_prepay_account với token hiện tại.');
    }
    let threshold: number | null = null;
    try {
      const cycles = await this.get('/adspaymentcycle', 'threshold_amount,updated_time');
      const rows = Array.isArray(cycles.data) ? cycles.data as Array<Record<string, unknown>> : [];
      const newest = rows.sort((a, b) => (Date.parse(String(b.updated_time)) || 0) - (Date.parse(String(a.updated_time)) || 0))[0];
      threshold = cents(newest?.threshold_amount);
      if (threshold === null || threshold <= 0) { threshold = null; warnings.push('Meta không trả ngưỡng thanh toán hiện tại.'); }
    } catch { warnings.push('Không đọc được adspaymentcycle; threshold_cents để null, không suy đoán.'); }
    const balance = cents(account.balance);
    const cap = cents(account.spend_cap);
    return {
      account_id: H3_ACCOUNT_ID,
      currency: typeof account.currency === 'string' ? account.currency : null,
      account_status: STATUS[Number(account.account_status)] ?? 'UNKNOWN',
      disable_reason: cents(account.disable_reason),
      balance_cents: balance,
      amount_spent_cents: cents(account.amount_spent),
      spend_cap_cents: cap === 0 ? null : cap,
      threshold_cents: threshold,
      percent_of_threshold: balance !== null && threshold ? Math.round(balance / threshold * 1000) / 10 : null,
      is_prepay: typeof account.is_prepay_account === 'boolean' ? account.is_prepay_account : null,
      funding_source: funding(account.funding_source_details),
      read_at: new Date().toISOString(),
      ...(warnings.length ? { warnings } : {}),
    };
  }
}
