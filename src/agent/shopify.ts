// Đọc sản phẩm từ Shopify Admin GraphQL theo handle, và đọc chữ trên trang sản phẩm công khai
// (để biết ưu đãi thật đang hiển thị, ví dụ "Buy 5 Get 2" — copy chỉ được nhắc ưu đãi có trên trang).

export interface ProductInfo {
  id: string;
  title: string;
  handle: string;
  status: string; // ACTIVE | DRAFT | ARCHIVED
  description: string;
  productType: string;
  tags: string[];
  variants: Array<{ title: string; price: string; compareAtPrice: string | null }>;
  priceRange: string;
  url: string;
  pageText: string;
}

export class ShopifyError extends Error {}

export interface ShopifyService {
  getProduct(handle: string, publicUrl: string): Promise<ProductInfo>;
}

export interface ShopifyOpts {
  domain: string; // xxx.myshopify.com
  apiVersion: string;
  token?: string; // Admin API access token (custom app cũ, shpat_...)
  clientId?: string; // app Dev Dashboard: client credentials grant, token sống 24 giờ
  clientSecret?: string;
}

const QUERY = `
query ProductByHandle($q: String!) {
  products(first: 5, query: $q) {
    nodes {
      id title handle status descriptionHtml productType tags onlineStoreUrl
      variants(first: 50) { nodes { title price compareAtPrice } }
    }
  }
}`;

export class Shopify implements ShopifyService {
  private readonly o: ShopifyOpts;
  private cached: { token: string; exp: number } | null = null;

  constructor(o: ShopifyOpts) {
    this.o = o;
  }

  private async accessToken(): Promise<string> {
    if (this.o.token) return this.o.token;
    if (this.cached && this.cached.exp > Date.now()) return this.cached.token;
    const res = await fetch(`https://${this.o.domain}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'client_credentials', client_id: this.o.clientId, client_secret: this.o.clientSecret }),
      signal: AbortSignal.timeout(30_000),
    });
    const j = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (!res.ok || !j.access_token) throw new ShopifyError(`Không lấy được token Shopify: ${j.error_description ?? j.error ?? res.status}`);
    this.cached = { token: j.access_token, exp: Date.now() + Math.max(60, (j.expires_in ?? 86400) - 300) * 1000 };
    return j.access_token;
  }

  private async gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await fetch(`https://${this.o.domain}/admin/api/${this.o.apiVersion}/graphql.json`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Shopify-Access-Token': await this.accessToken() },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30_000),
    });
    const j = (await res.json().catch(() => ({}))) as { data?: T; errors?: unknown };
    if (!res.ok || j.errors) throw new ShopifyError(`Shopify Admin API lỗi (HTTP ${res.status}): ${JSON.stringify(j.errors ?? '').slice(0, 300)}`);
    return j.data as T;
  }

  async getProduct(handle: string, publicUrl: string): Promise<ProductInfo> {
    const data = await this.gql<{
      products: {
        nodes: Array<{
          id: string;
          title: string;
          handle: string;
          status: string;
          descriptionHtml: string;
          productType: string;
          tags: string[];
          onlineStoreUrl: string | null;
          variants: { nodes: Array<{ title: string; price: string; compareAtPrice: string | null }> };
        }>;
      };
    }>(QUERY, { q: `handle:${handle}` });
    const p = data.products.nodes.find((n) => n.handle === handle);
    if (!p) throw new ShopifyError(`Không tìm thấy sản phẩm có handle "${handle}" trên Shopify`);
    const variants = p.variants.nodes.map((v) => ({ title: v.title, price: v.price, compareAtPrice: v.compareAtPrice }));
    const prices = variants.map((v) => Number(v.price)).filter(Number.isFinite);
    const priceRange = prices.length
      ? Math.min(...prices) === Math.max(...prices)
        ? `$${Math.min(...prices).toFixed(2)}`
        : `$${Math.min(...prices).toFixed(2)}–$${Math.max(...prices).toFixed(2)}`
      : '';
    const pageText = p.status === 'ACTIVE' ? await fetchPageText(publicUrl) : '';
    return {
      id: p.id,
      title: p.title,
      handle: p.handle,
      status: p.status,
      description: htmlToText(p.descriptionHtml).slice(0, 4000),
      productType: p.productType,
      tags: p.tags,
      variants,
      priceRange,
      url: publicUrl,
      pageText,
    };
  }
}

/** Đọc trang sản phẩm công khai; trang lỗi → ném lỗi (brief dừng). */
export async function fetchPageText(url: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; ads-agent/1.0)', accept: 'text/html' },
      redirect: 'follow',
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new ShopifyError(`Không mở được trang sản phẩm ${url}: ${(err as Error).message}`);
  }
  if (!res.ok) throw new ShopifyError(`Trang sản phẩm trả lỗi HTTP ${res.status}: ${url}`);
  const html = await res.text();
  return htmlToText(html).slice(0, 6000);
}

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h\d)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&rsquo;|&lsquo;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}
