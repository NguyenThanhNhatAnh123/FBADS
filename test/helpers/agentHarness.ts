// Dựng Agent đầy đủ với Telegram + Meta giả, Drive/Shopify/Claude giả, ffmpeg thật.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentConfig } from '../../src/agent/config.ts';
import { AgentStore } from '../../src/agent/db.ts';
import { TelegramApi, type TgUpdate } from '../../src/shared/telegram.ts';
import { MetaClient } from '../../src/agent/meta/graph.ts';
import { MetaAds } from '../../src/agent/meta/ads.ts';
import type { DriveFile, DriveService } from '../../src/agent/drive.ts';
import { DriveAccessError } from '../../src/agent/drive.ts';
import type { ProductInfo, ShopifyService } from '../../src/agent/shopify.ts';
import type { CopyInput, CopyResult, CopyWriter } from '../../src/agent/copy/writer.ts';
import * as media from '../../src/agent/media.ts';
import { Runner } from '../../src/agent/pipeline/runner.ts';
import { AgentApp } from '../../src/agent/app.ts';
import type { Deps } from '../../src/agent/pipeline/types.ts';
import { startFakeMeta, type FakeMeta } from './fakeMeta.ts';
import { startFakeTelegram, type FakeTelegram } from './fakeTelegram.ts';

export const OWNER = 555001;
export const PAGE = '101065259399535';
export const ACCT = 'act_25496622559924808';

export function testConfig(tmp: string): AgentConfig {
  return {
    port: 0,
    bridgeKey: 'bridge-key-0123456789abcdefghij',
    callbackSecret: 'bridge-key-0123456789abcdefghij',
    dbFile: ':memory:',
    tmpDir: path.join(tmp, 'work'),
    backupDir: path.join(tmp, 'backups'),
    driveBackupFolderId: '',
    tgBotToken: 'TEST',
    tgAllowedChatIds: [OWNER],
    meta: { token: 't', apiVersion: 'v26.0', graphBase: '', videoBase: '', adAccount: ACCT, pixelId: '625569536048355', pageId: PAGE, advantageAudience: 1 },
    account: { name: 'H3', pixelName: 'Native Pixel', pageName: 'Native Heritage Store', timezone: 'America/Dawson', currency: 'USD' },
    shopify: { domain: 'xzvd1h-0b.myshopify.com', publicDomain: 'firstnationslegacy.com', token: 'x', clientId: '', clientSecret: '', apiVersion: '2026-10' },
    google: { serviceAccountJson: '{}', roasSheetId: '' },
    claude: { apiKey: 'x', model: 'claude-sonnet-5-5', fallbacks: true },
    naming: { ownerPrefix: 'Dân' },
    limits: {
      budgetConfirmUsd: 300,
      totalBudgetUsd: 1500,
      capMinUsd: 5,
      capMaxUsd: 150,
      maxFilesPerBrief: 10,
      duplicateWindowMin: 10,
      remindAfterH: 24,
      autoCancelAfterH: 72,
    },
  };
}

export class FakeDrive implements DriveService {
  readonly serviceAccountEmail = 'ads-agent@project.iam.gserviceaccount.com';
  files = new Map<string, Array<DriveFile & { local: string }>>();
  denied = new Set<string>();
  async listCreatives(ref: { id: string }): Promise<DriveFile[]> {
    if (this.denied.has(ref.id)) throw new DriveAccessError(ref.id, 'Không truy cập được Drive (404)');
    const list = this.files.get(ref.id);
    if (!list) throw new DriveAccessError(ref.id, 'Không truy cập được Drive (404)');
    return list.map(({ local: _l, ...f }) => f);
  }
  async download(file: DriveFile, destDir: string): Promise<string> {
    for (const list of this.files.values()) {
      const hit = list.find((f) => f.id === file.id);
      if (hit) {
        fs.mkdirSync(destDir, { recursive: true });
        const dest = path.join(destDir, `${file.id}${path.extname(file.name)}`);
        fs.copyFileSync(hit.local, dest);
        return dest;
      }
    }
    throw new DriveAccessError(file.id, 'không có');
  }
}

export class FakeShopify implements ShopifyService {
  status = 'ACTIVE';
  async getProduct(handle: string, url: string): Promise<ProductInfo> {
    return {
      id: 'gid://shopify/Product/1',
      title: 'Raven Spirit 3D Hoodie',
      handle,
      status: this.status,
      description: 'All-over print hoodie with a black and red raven, printed front and back.',
      productType: 'Hoodie',
      tags: ['raven', 'hoodie'],
      variants: [{ title: 'S', price: '49.95', compareAtPrice: null }],
      priceRange: '$49.95',
      url,
      pageText: 'Raven Spirit 3D Hoodie $49.95 Buy 5 Get 2 Free',
    };
  }
}

export class FakeCopy implements CopyWriter {
  calls: CopyInput[] = [];
  gate: Promise<void> | null = null;
  async write(input: CopyInput): Promise<CopyResult> {
    this.calls.push(input);
    if (this.gate) await this.gate;
    const twoSided = input.editFeedback ? ' Printed on both sides, front and back.' : '';
    const n = this.calls.length;
    return {
      variants: [
        {
          style: 'first_person_story',
          headline: 'For the Man Drawn to the Wild',
          primary_text: `People think I'm crazy for wearing my Native hoodie everywhere…\nThe red raven wraps around the back.${twoSided}\nIt turns heads every single time.\nTap to pick your size (v${n})`,
          description: 'Printed front and back',
          reason: 'Video có người mặc thật.',
        },
        {
          style: 'gift_giver',
          headline: 'For the Man Who Has Everything',
          primary_text: `He says he doesn't need anything…\nBut this black-and-red raven hoodie?${twoSided}\nHe'll wear it all winter.\nTake a look before it's gone (v${n})`,
          description: 'Soft fleece inside',
          reason: 'Góc quà tặng mùa lễ.',
        },
      ],
      warnings: [],
    };
  }
}

export interface Harness {
  tmp: string;
  cfg: AgentConfig;
  store: AgentStore;
  tg: FakeTelegram;
  meta: FakeMeta;
  drive: FakeDrive;
  shopify: FakeShopify;
  copy: FakeCopy;
  deps: Deps;
  runner: Runner;
  app: AgentApp;
  send(text: string, extra?: Record<string, unknown>, chatId?: number): Promise<{ handled: boolean }>;
  press(label: RegExp): Promise<void>;
  reply(toMessageId: number, text: string): Promise<{ handled: boolean }>;
  restart(): Harness;
  close(): Promise<void>;
}

let updateSeq = 1;
let messageSeq = 1;

export function makeVideo(dir: string, name: string, w = 540, h = 960, seconds = 6): string {
  const file = path.join(dir, name);
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc=size=${w}x${h}:rate=10:duration=${seconds}`, '-c:v', 'mpeg4', file]);
  return file;
}

export function makeImage(dir: string, name: string, w = 1080, h = 1080): string {
  const file = path.join(dir, name);
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc=size=${w}x${h}`, '-frames:v', '1', file]);
  return file;
}

export async function startHarness(): Promise<Harness> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ads-e2e-'));
  const cfg = testConfig(tmp);
  const tg = await startFakeTelegram();
  const meta = await startFakeMeta({ adAccount: ACCT, pageId: PAGE, version: 'v26.0' });
  cfg.meta.graphBase = meta.base;
  cfg.meta.videoBase = meta.base;
  const store = new AgentStore(':memory:');
  store.upsertAccountFromConfig(cfg);
  const drive = new FakeDrive();
  const shopify = new FakeShopify();
  const copy = new FakeCopy();
  return build({ tmp, cfg, tg, meta, store, drive, shopify, copy });
}

function build(p: { tmp: string; cfg: AgentConfig; tg: FakeTelegram; meta: FakeMeta; store: AgentStore; drive: FakeDrive; shopify: FakeShopify; copy: FakeCopy }): Harness {
  const noSleep = async () => {};
  const deps: Deps = {
    cfg: p.cfg,
    store: p.store,
    tg: new TelegramApi('TEST', p.tg.base),
    meta: new MetaAds(new MetaClient({ token: 't', version: 'v26.0', graphBase: p.meta.base, videoBase: p.meta.base, sleepFn: noSleep }), {
      adAccount: ACCT,
      pageId: PAGE,
      pixelId: p.cfg.meta.pixelId,
    }, noSleep),
    drive: p.drive,
    shopify: p.shopify,
    copy: p.copy,
    media,
  };
  const runner = new Runner(deps);
  const app = new AgentApp(deps, runner);
  const h: Harness = {
    ...p,
    deps,
    runner,
    app,
    async send(text, extra = {}, chatId = OWNER) {
      const r = await app.handleUpdate({
        update_id: updateSeq++,
        message: { message_id: messageSeq++, date: 0, chat: { id: chatId, type: 'private' }, from: { id: chatId, is_bot: false }, text, ...extra },
      } as TgUpdate);
      await runner.idle();
      return r;
    },
    async press(label) {
      const b = p.tg.findButton(label);
      if (!b) throw new Error(`Không thấy nút ${label}`);
      await app.handleUpdate({
        update_id: updateSeq++,
        callback_query: { id: `cq${updateSeq}`, from: { id: OWNER, is_bot: false }, data: b.data, message: { message_id: b.messageId, date: 0, chat: { id: OWNER, type: 'private' } } },
      });
      await runner.idle();
    },
    async reply(toMessageId, text) {
      return h.send(text, { reply_to_message: { message_id: toMessageId, date: 0, chat: { id: OWNER, type: 'private' }, from: { id: 1, is_bot: true } } });
    },
    restart() {
      return build(p);
    },
    async close() {
      await runner.idle();
      await p.tg.close();
      await p.meta.close();
      p.store.close();
      fs.rmSync(p.tmp, { recursive: true, force: true });
    },
  };
  return h;
}

export function newBrief(o: { product?: string; budget?: string | number; run?: string; cap?: string; creative?: string; countries?: string } = {}): string {
  return [
    '#NEW',
    'TK: H3',
    `Kiểu chạy: ${o.run ?? 'Auto'}`,
    `Mức cap ($): ${o.cap ?? ''}`,
    `Sản phẩm: ${o.product ?? '3D Hoodie Raven'}`,
    'Link SP: https://firstnationslegacy.com/products/raven-spirit-3d-hoodie',
    (o.creative ?? 'FILE_ONE_VIDEO').startsWith('FOLDER')
      ? `Creative: https://drive.google.com/drive/folders/${o.creative}`
      : `Creative: https://drive.google.com/file/d/${o.creative ?? 'FILE_ONE_VIDEO'}/view`,
    `Quốc gia: ${o.countries ?? 'US'}`,
    `Budget/ngày ($): ${o.budget ?? 10}`,
    'Ngày chạy: hôm nay',
    'Ghi chú copy:',
  ].join('\n');
}
