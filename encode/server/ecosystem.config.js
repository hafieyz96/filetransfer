module.exports = {
  apps: [
    {
      name: 'encode-server',
      script: 'index.js',
      node_args: '--env-file-if-exists=.env',
      max_memory_restart: '300M', // droplet 512MB
      env: { NODE_ENV: 'production' },
    },
  ],
};
