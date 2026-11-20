module.exports = {
  apps: [
    {
      name: 'status-bot',
      script: 'index.js',
      cwd: '/opt/status-bot',
      max_memory_restart: '300M', // droplet 512MB
      env: { NODE_ENV: 'production' },
    },
  ],
};
