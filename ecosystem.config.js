module.exports = {
  apps: [{
    name: 'discord-bot',
    script: 'index.js',
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'development'
    },
    env_production: {
      NODE_ENV: 'production'
    },
    error_file: './logs/err.log',
    out_file: './logs/out.log',
    log_file: './logs/combined.log',
    time: true,
    instances: 1,
    exec_mode: 'fork',
    restart_delay: 5000,
    max_restarts: 10,
    min_uptime: '10s'
  }]
};