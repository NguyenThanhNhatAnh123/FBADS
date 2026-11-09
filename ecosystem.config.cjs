// pm2: chạy hai tiến trình "bridge" và "agent" (pm2 start ecosystem.config.cjs).
// BRIEF_HANDLER=claude (không dùng key): chỉ chạy bridge — pm2 start ecosystem.config.cjs --only bridge
// Node ≥ 22.18 chạy thẳng file .ts (type stripping), không cần bước build.
module.exports = {
  apps: [
    {
      name: 'bridge',
      script: 'src/bridge/index.ts',
      interpreter: 'node',
      node_args: '--env-file=.env.bridge',
      cwd: __dirname,
      autorestart: true,
      max_restarts: 50,
      restart_delay: 3000,
      time: true,
    },
    {
      name: 'agent',
      script: 'src/agent/index.ts',
      interpreter: 'node',
      node_args: '--env-file=.env.agent',
      cwd: __dirname,
      autorestart: true,
      max_restarts: 50,
      restart_delay: 3000,
      kill_timeout: 15000,
      time: true,
    },
  ],
};
