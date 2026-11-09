// Graph API giả trong bộ nhớ: đủ các endpoint Agent dùng để test luồng 11 bước.

import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

export interface MetaObj {
  id: string;
  type: 'campaign' | 'adset' | 'ad' | 'creative' | 'video' | 'post';
  status?: string;
  effective_status?: string;
  deleted?: boolean;
  [k: string]: any;
}

export interface FakeMeta {
  base: string;
  objects: Map<string, MetaObj>;
  requests: Array<{ method: string; path: string; params: Record<string, any> }>;
  /** Trả về body lỗi để giả lập Meta từ chối; null = chạy bình thường. */
  failWith: ((method: string, path: string, params: Record<string, any>) => any | null) | null;
  of(type: MetaObj['type'], includeDeleted?: boolean): MetaObj[];
  seedCampaign(o: Partial<MetaObj> & { name: string }): MetaObj;
  seedAdset(o: Partial<MetaObj> & { campaign_id: string; name: string }): MetaObj;
  close(): Promise<void>;
}

export async function startFakeMeta(opts: { adAccount: string; pageId: string; version: string }): Promise<FakeMeta> {
  const objects = new Map<string, MetaObj>();
  const requests: FakeMeta['requests'] = [];
  let seq = 120000000000000;
  const newId = () => String(++seq);
  let postSeq = 900000;
  const acct = opts.adAccount;
  const acctNum = acct.replace('act_', '');
  const fake: FakeMeta = {
    base: '',
    objects,
    requests,
    failWith: null,
    of: (type, includeDeleted = false) => [...objects.values()].filter((o) => o.type === type && (includeDeleted || !o.deleted)),
    seedCampaign(o) {
      const id = o.id ?? newId();
      const c: MetaObj = { type: 'campaign', status: 'ACTIVE', effective_status: 'ACTIVE', account_id: acctNum, daily_budget: '5000', bid_strategy: 'LOWEST_COST_WITHOUT_CAP', created_time: new Date().toISOString(), ...o, id };
      objects.set(id, c);
      return c;
    },
    seedAdset(o) {
      const id = o.id ?? newId();
      const a: MetaObj = { type: 'adset', status: 'ACTIVE', effective_status: 'ACTIVE', created_time: new Date(Date.now() - 86400_000).toISOString(), ...o, id };
      objects.set(id, a);
      return a;
    },
    close: async () => {},
  };

  const parse = (v: any) => {
    if (typeof v !== 'string') return v;
    if (/^[[{]/.test(v)) {
      try {
        return JSON.parse(v);
      } catch {
        return v;
      }
    }
    return v;
  };
  const view = (o: MetaObj, fields?: string) => {
    if (!fields) return { id: o.id };
    const out: Record<string, any> = { id: o.id };
    for (const f of fields.split(',').map((s) => s.replace(/\{.*$/, '').trim())) if (o[f] !== undefined) out[f] = o[f];
    return out;
  };
  const err = (res: express.Response, status: number, body: any) => res.status(status).json({ error: body });

  const app = express();
  app.use(express.urlencoded({ extended: false, limit: '10mb' }));
  app.use(async (req, res) => {
    let params: Record<string, any> = {};
    const ct = String(req.headers['content-type'] ?? '');
    if (ct.includes('multipart/form-data')) {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const fd = await new Response(new Uint8Array(Buffer.concat(chunks)), { headers: { 'content-type': ct } }).formData();
      for (const [k, v] of fd.entries()) params[k] = typeof v === 'string' ? v : { file: (v as File).name, size: (v as File).size };
    } else params = { ...(req.query as Record<string, any>), ...(req.body ?? {}) };
    for (const k of Object.keys(params)) params[k] = parse(params[k]);
    delete params.access_token;
    const p = req.path.replace(`/${opts.version}`, '').replace(/^\//, '');
    requests.push({ method: req.method, path: p, params });

    const injected = fake.failWith?.(req.method, p, params);
    if (injected) return err(res, 400, injected);

    const segs = p.split('/').filter(Boolean);
    // ---- GET /?ids=
    if (req.method === 'GET' && segs.length === 0 && params.ids) {
      const out: Record<string, any> = {};
      for (const id of String(params.ids).split(',')) {
        const o = objects.get(id);
        if (o) out[id] = view(o, params.fields);
      }
      return res.json(out);
    }
    // ---- account edges
    if (segs[0] === acct) {
      const edge = segs[1];
      if (req.method === 'GET' && edge === 'campaigns') {
        const filt = (params.filtering ?? []) as Array<{ field: string; operator: string; value: any }>;
        let list = fake.of('campaign');
        for (const f of filt) {
          if (f.field === 'name' && f.operator === 'CONTAIN') list = list.filter((c) => c.name.toLowerCase().includes(String(f.value).toLowerCase()));
          if (f.field === 'name' && f.operator === 'EQUAL') list = list.filter((c) => c.name === f.value);
        }
        return res.json({ data: list.map((c) => view(c, params.fields)) });
      }
      if (req.method === 'GET' && (edge === 'adsets' || edge === 'ads')) {
        const type = edge === 'adsets' ? 'adset' : 'ad';
        const filt = (params.filtering ?? []) as Array<{ field: string; operator: string; value: any }>;
        let list = fake.of(type);
        for (const f of filt) if (f.field === 'name' && f.operator === 'EQUAL') list = list.filter((c) => c.name === f.value);
        return res.json({ data: list.map((c) => view(c, params.fields)) });
      }
      if (req.method === 'GET' && edge === 'adspaymentcycle') return res.json({ data: [{ threshold_amount: 50000 }] });
      if (req.method === 'POST') {
        const id = newId();
        const now = new Date().toISOString();
        if (edge === 'campaigns') {
          objects.set(id, { id, type: 'campaign', ...params, effective_status: params.status, account_id: acctNum, created_time: now });
          return res.json({ id });
        }
        if (edge === 'adsets') {
          if (!params.targeting) return err(res, 400, { message: 'Invalid parameter', code: 100, error_user_msg: 'Thiếu targeting' });
          objects.set(id, { id, type: 'adset', ...params, effective_status: params.status, created_time: now });
          return res.json({ id });
        }
        if (edge === 'ads') {
          objects.set(id, { id, type: 'ad', ...params, effective_status: params.status, created_time: now });
          return res.json({ id });
        }
        if (edge === 'adcreatives') {
          const story = params.object_story_id ?? `${opts.pageId}_${++postSeq}`;
          objects.set(id, { id, type: 'creative', ...params, effective_object_story_id: story, _polls: params.object_story_id ? 1 : 0 });
          if (!params.object_story_id) objects.set(story, { id: story, type: 'post', permalink_url: `https://facebook.com/${story}` });
          return res.json({ id });
        }
        if (edge === 'adimages') return res.json({ images: { [params.filename?.file ?? 'img']: { hash: `hash_${id}` } } });
        if (edge === 'advideos') {
          objects.set(id, { id, type: 'video', name: params.name, _polls: 0 });
          return res.json({ id });
        }
      }
    }
    // ---- object edges
    const obj = objects.get(segs[0]);
    if (segs.length === 2 && obj) {
      if (segs[1] === 'thumbnails') return res.json({ data: [{ uri: `https://cdn.example/thumb_${obj.id}.jpg`, is_preferred: true }] });
      if (segs[1] === 'previews') return res.json({ data: [{ body: `<iframe src="https://www.facebook.com/ads/api/preview_iframe.php?d=${obj.id}&amp;t=${params.ad_format}" width="320"></iframe>` }] });
      if (segs[1] === 'adsets') return res.json({ data: fake.of('adset').filter((a) => a.campaign_id === obj.id).map((a) => view(a, params.fields)) });
    }
    if (segs.length === 1) {
      if (!obj || obj.deleted) return err(res, 400, { message: `Unsupported get request. Object with ID '${segs[0]}' does not exist`, code: 100, error_subcode: 33 });
      if (req.method === 'GET') {
        if (obj.type === 'video') {
          obj._polls++;
          return res.json({ id: obj.id, status: { video_status: obj._polls >= 2 ? 'ready' : 'processing' } });
        }
        if (obj.type === 'creative' && params.fields === 'effective_object_story_id') {
          obj._polls++;
          return res.json(obj._polls >= 2 ? { id: obj.id, effective_object_story_id: obj.effective_object_story_id } : { id: obj.id });
        }
        return res.json(view(obj, params.fields));
      }
      if (req.method === 'POST') {
        for (const [k, v] of Object.entries(params)) obj[k] = v;
        if (params.status) obj.effective_status = params.status;
        return res.json({ success: true });
      }
      if (req.method === 'DELETE') {
        obj.deleted = true;
        obj.effective_status = 'DELETED';
        return res.json({ success: true });
      }
    }
    return err(res, 400, { message: `Fake Meta: không hỗ trợ ${req.method} ${p}`, code: 100 });
  });
  const server: Server = await new Promise((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s));
  });
  fake.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.close = () => new Promise((r) => server.close(() => r()));
  return fake;
}
