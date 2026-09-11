import { AgentProvider } from 'agent-sdk';
import { App as AntdApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { AGENT_SERVER_URL, TOKEN_KEY } from './constants';
import { AuthProvider } from './auth/AuthContext';
import './styles/global.css';

// 读取本地 token 作为 agent 请求鉴权头（登录后由 AuthContext 写入 localStorage）
function getAuthHeaders(): Record<string, string> {
  const token = localStorage.getItem(TOKEN_KEY);
  return token ? { Authorization: `Bearer ${token}` } : {};
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <ConfigProvider
    locale={zhCN}
    theme={{
      token: {
        colorPrimary: '#1677ff',
        colorInfo: '#1677ff',
        borderRadius: 8,
        colorBgLayout: '#f5f7fa',
      },
    }}
  >
    <AntdApp>
      <AuthProvider>
        <AgentProvider url={AGENT_SERVER_URL} getAuthHeaders={getAuthHeaders}>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </AgentProvider>
      </AuthProvider>
    </AntdApp>
  </ConfigProvider>
);