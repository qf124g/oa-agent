import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // agent-sdk 以 TS 源码形式被 workspace 链接引用，排除出预构建，让 Vite 直接编译其源码
  optimizeDeps: {
    exclude: ['agent-sdk'],
  },
});
