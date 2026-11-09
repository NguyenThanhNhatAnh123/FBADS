// Đọc biến môi trường có kiểm tra. Lỗi cấu hình được gom lại và báo một lần khi khởi động.

export class EnvReader {
  readonly missing: string[] = [];
  readonly invalid: string[] = [];
  private readonly src: NodeJS.ProcessEnv;

  constructor(src: NodeJS.ProcessEnv = process.env) {
    this.src = src;
  }

  str(name: string): string {
    const v = this.src[name]?.trim();
    if (!v) {
      this.missing.push(name);
      return '';
    }
    return v;
  }

  opt(name: string, def = ''): string {
    const v = this.src[name]?.trim();
    return v ? v : def;
  }

  num(name: string, def: number): number {
    const raw = this.src[name]?.trim();
    if (!raw) return def;
    const n = Number(raw.replace(',', '.'));
    if (!Number.isFinite(n)) {
      this.invalid.push(`${name}=${raw} (không phải số)`);
      return def;
    }
    return n;
  }

  bool(name: string, def: boolean): boolean {
    const raw = this.src[name]?.trim().toLowerCase();
    if (!raw) return def;
    return ['1', 'true', 'yes', 'on'].includes(raw);
  }

  list(name: string, required = true): string[] {
    const raw = this.src[name]?.trim();
    if (!raw) {
      if (required) this.missing.push(name);
      return [];
    }
    return raw
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  /** Ném lỗi nếu thiếu hoặc sai biến bắt buộc. */
  assertOk(processName: string): void {
    const problems: string[] = [];
    if (this.missing.length) problems.push(`thiếu: ${[...new Set(this.missing)].join(', ')}`);
    if (this.invalid.length) problems.push(`sai: ${this.invalid.join('; ')}`);
    if (problems.length) {
      throw new Error(`[${processName}] Cấu hình .env chưa đủ — ${problems.join(' · ')}`);
    }
  }
}
