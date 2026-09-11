// pm2 生产进程配置：在项目根目录执行 pm2 start ecosystem.config.js
// backend 监听 8080，agent-server 监听 3002（读取同目录下 .env，含大模型密钥，需手动创建）
module.exports = {
  apps: [
    {
      name: 'oa-backend',
      cwd: './backend',
      script: 'npm',
      args: 'run start',
      env: { NODE_ENV: 'production', PORT: '8080' },
    },
    {
      name: 'oa-agent-server',
      cwd: './agent-server',
      script: 'npm',
      args: 'run start',
      env: { NODE_ENV: 'production' },
    },
  ],
};
