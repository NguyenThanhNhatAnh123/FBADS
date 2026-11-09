// Kiểm tra creative bằng ffprobe và cắt khung hình bằng ffmpeg (cần ffmpeg/ffprobe trong PATH,
// hoặc đặt FFMPEG_PATH / FFPROBE_PATH).

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

export interface ProbeResult {
  width: number;
  height: number;
  durationS: number | null;
  formatName: string;
  codec: string;
}

export async function probe(filePath: string): Promise<ProbeResult> {
  const { stdout } = await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', filePath], {
    maxBuffer: 10 * 1024 * 1024,
  });
  const j = JSON.parse(stdout) as {
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      duration?: string;
      tags?: { rotate?: string };
      side_data_list?: Array<{ rotation?: number }>;
    }>;
    format?: { format_name?: string; duration?: string };
  };
  const v = (j.streams ?? []).find((s) => s.codec_type === 'video');
  if (!v?.width || !v?.height) throw new Error('Không đọc được kích thước khung hình');
  const rot = Math.abs(Number(v.side_data_list?.find((s) => s.rotation !== undefined)?.rotation ?? v.tags?.rotate ?? 0)) % 180;
  const [w, h] = rot === 90 ? [v.height, v.width] : [v.width, v.height];
  const dur = Number(j.format?.duration ?? v.duration);
  return {
    width: w,
    height: h,
    durationS: Number.isFinite(dur) && dur > 0 ? dur : null,
    formatName: j.format?.format_name ?? '',
    codec: v.codec_name ?? '',
  };
}

const STANDARD: Array<[string, number]> = [
  ['9:16', 9 / 16],
  ['4:5', 4 / 5],
  ['1:1', 1],
];

/** Nhãn tỷ lệ khung: 9:16, 4:5, 1:1 (sai lệch ≤ 2%), còn lại ghi w:h. */
export function ratioLabel(w: number, h: number): { label: string; standard: boolean } {
  const r = w / h;
  for (const [label, target] of STANDARD) if (Math.abs(r - target) / target <= 0.02) return { label, standard: true };
  const g = gcd(w, h);
  const rw = w / g;
  const rh = h / g;
  return { label: rw <= 50 && rh <= 50 ? `${rw}:${rh}` : `${(r).toFixed(2)}:1`, standard: false };
}

function gcd(a: number, b: number): number {
  return b ? gcd(b, a % b) : a;
}

export interface MediaCheck {
  errors: string[];
  warnings: string[];
  ratio: string;
}

/** Kiểm tra theo đặc tả: video MP4/MOV 5–60s; ảnh JPG/PNG cạnh ngắn ≥ 1080px; tỷ lệ lạ → cảnh báo. */
export function checkMedia(kind: 'video' | 'image', name: string, mime: string, p: ProbeResult): MediaCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const ext = path.extname(name).toLowerCase();
  if (kind === 'video') {
    const okType = ['.mp4', '.mov', '.m4v'].includes(ext) || ['video/mp4', 'video/quicktime'].includes(mime) || /mov|mp4/.test(p.formatName);
    if (!okType) errors.push(`${name}: video phải là MP4 hoặc MOV`);
    if (p.durationS === null) errors.push(`${name}: không đọc được thời lượng video`);
    else if (p.durationS < 5 || p.durationS > 60) errors.push(`${name}: video dài ${p.durationS.toFixed(1)}s, cần 5–60 giây`);
  } else {
    const okType = ['.jpg', '.jpeg', '.png'].includes(ext) || ['image/jpeg', 'image/png'].includes(mime);
    if (!okType) errors.push(`${name}: ảnh phải là JPG hoặc PNG`);
    if (Math.min(p.width, p.height) < 1080) errors.push(`${name}: ảnh ${p.width}×${p.height}, cạnh ngắn cần ≥ 1080 px`);
  }
  const r = ratioLabel(p.width, p.height);
  if (!r.standard) warnings.push(`${name}: tỷ lệ ${r.label} (${p.width}×${p.height}) khác 9:16, 4:5, 1:1`);
  return { errors, warnings, ratio: r.label };
}

/** Cắt 3 khung hình (15%, 50%, 85% thời lượng) thành JPEG ≤ 1024px để gửi Claude. */
export async function extractFrames(videoPath: string, durationS: number, outDir: string): Promise<string[]> {
  fs.mkdirSync(outDir, { recursive: true });
  const out: string[] = [];
  const base = path.basename(videoPath, path.extname(videoPath));
  for (const [i, frac] of [0.15, 0.5, 0.85].entries()) {
    const t = Math.max(0, durationS * frac).toFixed(2);
    const dest = path.join(outDir, `${base}-f${i + 1}.jpg`);
    await run(FFMPEG, ['-y', '-v', 'error', '-ss', t, '-i', videoPath, '-frames:v', '1', '-vf', "scale='min(1024,iw)':-2", '-q:v', '3', dest]);
    if (fs.existsSync(dest)) out.push(dest);
  }
  return out;
}

/** Thu nhỏ ảnh banner thành JPEG ≤ 1568px (giới hạn hợp lý cho vision). */
export async function shrinkImage(imagePath: string, outDir: string): Promise<string> {
  fs.mkdirSync(outDir, { recursive: true });
  const dest = path.join(outDir, `${path.basename(imagePath, path.extname(imagePath))}-claude.jpg`);
  await run(FFMPEG, [
    '-y',
    '-v',
    'error',
    '-i',
    imagePath,
    '-vf',
    "scale='if(gt(iw,ih),min(1568,iw),-2)':'if(gt(iw,ih),-2,min(1568,ih))'",
    '-q:v',
    '3',
    dest,
  ]);
  return dest;
}

export async function sha256File(filePath: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) h.update(chunk as Buffer);
  return h.digest('hex');
}

export async function checkFfmpeg(): Promise<string | null> {
  try {
    await run(FFPROBE, ['-version']);
    await run(FFMPEG, ['-version']);
    return null;
  } catch (err) {
    return `Không chạy được ffmpeg/ffprobe: ${(err as Error).message}`;
  }
}
