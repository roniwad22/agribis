module.exports = {
  apps: [{
    name: 'agribis',
    script: 'src/app.js',
    instances: 1,               // SQLite = single writer, no cluster
    exec_mode: 'fork',
    autorestart: true,
    watch: false,
    max_memory_restart: '256M',
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    },
    // Graceful shutdown (matches SIGTERM handler in app.js)
    kill_timeout: 5000,
    listen_timeout: 10000,
    // Logs
    error_file: './logs/err.log',
    out_file: './logs/out.log',
    merge_logs: true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    // Restart backoff on crash loops
    exp_backoff_restart_delay: 100,
    max_restarts: 10,
    min_uptime: '5s'
  }]
};
