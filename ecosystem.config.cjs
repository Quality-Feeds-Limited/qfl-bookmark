/*
 * PM2 process file for QFL Extension Finder.
 *
 *   pm2 start ecosystem.config.cjs
 *   pm2 logs qfl-ext
 *   pm2 restart qfl-ext
 *   pm2 save && pm2 startup      <- survive a reboot
 *
 * NOTE: fork mode with exactly one instance, on purpose. See "instances" below.
 */

module.exports = {
  apps: [
    {
      name: 'qfl-ext',
      script: 'server.js',
      cwd: __dirname,

      // Admin logins, the forgot-password code and the rate-limit counters all
      // live in plain variables inside the process, and data.json is saved with
      // a read-then-write. A second copy of the app would hand out sessions the
      // other copy does not know about and the two would overwrite each other's
      // saves. Keep this at 1 fork - do not switch to cluster.
      instances: 1,
      exec_mode: 'fork',

      env: {
        NODE_ENV: 'production',
        PORT: 6000
      },

      // Restart if it ever crashes, but give up if it is crash-looping
      autorestart: true,
      max_restarts: 10,
      min_uptime: '20s',
      restart_delay: 2000,

      // Do not restart when data.json / config.json are written by the app itself
      watch: false,

      max_memory_restart: '256M',

      // Ctrl+C equivalent, then hard kill - long enough to finish a save
      kill_timeout: 5000,

      out_file: 'logs/out.log',
      error_file: 'logs/error.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss'
    }
  ]
};
