// Chạy một lượt `claude -p` (Claude Code headless, đăng nhập bằng tài khoản claude.ai của chủ shop).
//
//   claude -p --restricted --permission-mode dontAsk --output-format json
//          --mcp-config <file: server "adsjob" → http://127.0.0.1:<bridge>/job-mcp/<token một lần>>
//          --allowedTools <đúng các tool của loại lượt này> --disallowedTools <...>
//
// --restricted: không có Bash / PowerShell / WebFetch, bỏ qua settings của user / project.
// --permission-mode dontAsk: tool ngoài allowedTools bị từ chối, không hỏi.
// Prompt đi qua stdin. Thư mục làm việc là thư mục rỗng riêng của lượt chạy.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ClaudeJobsConfig } from './config.ts';
import type { RunKind } from './store.ts';
import { allowedToolsFor, disallowedToolsFor, JOB_SERVER } from './prompts.ts';
import { logger } from '../../shared/log.ts';

const log = logger('claude-run');

// Không truyền bí mật của bridge sang tiến trình con. ANTHROPIC_API_KEY bị bỏ để Claude Code luôn dùng
// phiên đăng nhập claude.ai (connector + gói của chủ shop), không chuyển sang tính tiền API.
const STRIP_ENV = ['TG_BOT_TOKEN', 'TG_WEBHOOK_SECRET', 'MCP_TOKEN', 'BRIDGE_KEY', 'CALLBACK_SECRET', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'META_TOKEN', 'META_READ_TOKEN', 'SHOPIFY_TOKEN', 'SHOPIFY_CLIENT_SECRET', 'GOOGLE_SA_JSON', 'DRIVE_SERVICE_ACCOUNT_JSON', 'GOOGLE_SERVICE_ACCOUNT_JSON'];

export interface RunSpec {
  runId: number;
  jobId: number;
  kind: RunKind;
  prompt: string;
  token: string;
  mcpUrl: string; // http://127.0.0.1:<port>/job-mcp/<token>
  dry?: boolean; // chạy thử: chỉ cấp tool đọc
}

export interface RunResult {
  exitCode: number | null;
  timedOut: boolean;
  killed: boolean;
  json: {
    result?: string;
    session_id?: string;
    total_cost_usd?: number;
    num_turns?: number;
    is_error?: boolean;
    subtype?: string;
    permission_denials?: Array<{ tool_name: string }>;
  } | null;
  stderrTail: string;
  logFile: string;
}

export interface Runner {
  run(spec: RunSpec): Promise<RunResult>;
  /** Dừng lượt đang chạy (khi bridge tắt). */
  abort(): void;
}

export class ClaudeCliRunner implements Runner {
  private readonly cfg: ClaudeJobsConfig;
  private child: ReturnType<typeof spawn> | null = null;

  constructor(cfg: ClaudeJobsConfig) {
    this.cfg = cfg;
  }

  args(spec: RunSpec, mcpFile: string): string[] {
    const maxTurns = spec.kind === 'create' || spec.kind === 'edit' ? this.cfg.maxTurnsCreate : this.cfg.maxTurnsOther;
    const a = [
      ...this.cfg.binArgs,
      '-p',
      '--output-format',
      'json',
      '--restricted',
      '--permission-mode',
      'dontAsk',
      '--mcp-config',
      mcpFile,
      '--allowedTools',
      allowedToolsFor(spec.kind, !!spec.dry).join(','),
      '--disallowedTools',
      disallowedToolsFor(spec.kind, !!spec.dry).join(','),
      '--max-turns',
      String(maxTurns),
      '--name',
      `ads-brief-${spec.jobId}-${spec.kind}-${spec.runId}`,
    ];
    if (this.cfg.model) a.push('--model', this.cfg.model);
    if (this.cfg.effort) a.push('--effort', this.cfg.effort);
    return a;
  }

  run(spec: RunSpec): Promise<RunResult> {
    fs.mkdirSync(this.cfg.runDir, { recursive: true });
    const workDir = path.join(this.cfg.runDir, `run-${spec.runId}`);
    fs.mkdirSync(workDir, { recursive: true });
    // File MCP config nằm NGOÀI thư mục làm việc (chứa token một lần của lượt này).
    const mcpFile = path.join(this.cfg.runDir, `run-${spec.runId}.mcp.json`);
    fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: { [JOB_SERVER]: { type: 'http', url: spec.mcpUrl } } }, null, 2));
    const logFile = path.join(this.cfg.runDir, `run-${spec.runId}.log`);
    const logStream = fs.createWriteStream(logFile, { flags: 'a' });
    const args = this.args(spec, mcpFile);
    logStream.write(`# ${new Date().toISOString()} brief #${spec.jobId} ${spec.kind} run ${spec.runId}\n# ${this.cfg.bin} ${args.map((x) => (x.includes(' ') ? JSON.stringify(x) : x)).join(' ')}\n\n# PROMPT\n${spec.prompt}\n\n# STDERR\n`);

    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const k of STRIP_ENV) delete env[k];

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;
      const child = spawn(this.cfg.bin, args, { cwd: workDir, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      this.child = child;
      const timer = setTimeout(() => {
        timedOut = true;
        log.warn(`Lượt ${spec.runId} quá ${this.cfg.timeoutMin} phút — dừng tiến trình claude`);
        child.kill();
      }, this.cfg.timeoutMin * 60_000);

      child.stdout!.on('data', (d: Buffer) => {
        stdout += d.toString();
        if (stdout.length > 4_000_000) stdout = stdout.slice(-2_000_000);
      });
      child.stderr!.on('data', (d: Buffer) => {
        const s = d.toString();
        stderr = (stderr + s).slice(-20_000);
        logStream.write(s);
      });
      const finish = (exitCode: number | null, err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.child = null;
        if (err) stderr += `\n${err.message}`;
        const json = parseResult(stdout);
        logStream.write(`\n# STDOUT\n${stdout.slice(-200_000)}\n# EXIT ${exitCode}${timedOut ? ' (timeout)' : ''}\n`);
        logStream.end();
        fs.rmSync(mcpFile, { force: true });
        resolve({ exitCode, timedOut, killed: child.killed && !timedOut, json, stderrTail: stderr.slice(-2000), logFile });
      };
      child.on('error', (err) => finish(null, err));
      child.on('close', (code) => finish(code));
      child.stdin!.on('error', () => {});
      child.stdin!.end(spec.prompt);
    });
  }

  abort(): void {
    this.child?.kill();
  }
}

/** --output-format json in ra một object JSON khi xong; lấy object cuối có type=result. */
export function parseResult(stdout: string): RunResult['json'] {
  const text = stdout.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // Có dòng rác phía trước → thử từng dòng từ cuối lên.
    for (const line of text.split(/\r?\n/).reverse()) {
      try {
        const j = JSON.parse(line);
        if (j && typeof j === 'object' && 'type' in j) return j;
      } catch {
        /* bỏ qua */
      }
    }
    return null;
  }
}
