import {
  AuditOutlined,
  BookOutlined,
  CarryOutOutlined,
  DashboardOutlined,
  LogoutOutlined,
  NotificationOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { Avatar, Button, Dropdown, Layout as AntdLayout, Menu, Space } from 'antd';
import { FloatingAssistant } from 'agent-sdk';
import { Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { ROLE_LABEL } from '../constants';

const { Sider, Header, Content } = AntdLayout;

// 侧边导航配置
const NAV_ITEMS = [
  { to: '/', label: '工作台', icon: <DashboardOutlined /> },
  { to: '/todo', label: '待办任务', icon: <CarryOutOutlined /> },
  { to: '/approval', label: '审批中心', icon: <AuditOutlined /> },
  { to: '/announcement', label: '公告', icon: <NotificationOutlined /> },
  { to: '/directory', label: '通讯录', icon: <TeamOutlined /> },
  { to: '/knowledge', label: '知识库', icon: <BookOutlined /> },
];

// 受保护的全局布局：登录守卫 + 侧边导航 + 顶栏 + 内容区 + 悬浮助手
export default function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  // 未登录跳转登录页
  if (!user) {
    return <Navigate to="/login" replace />;
  }

  const selectedKey = location.pathname === '/' ? '/' : location.pathname;
  const currentTitle = NAV_ITEMS.find((item) => item.to === selectedKey)?.label ?? '';

  const menuItems = NAV_ITEMS.map((item) => ({ key: item.to, icon: item.icon, label: item.label }));

  const userMenu = {
    items: [{ key: 'logout', icon: <LogoutOutlined />, label: '退出登录' }],
    onClick: ({ key }: { key: string }) => {
      if (key === 'logout') {
        logout();
        navigate('/login');
      }
    },
  };

  return (
    <AntdLayout style={{ minHeight: '100vh' }}>
      <Sider theme="light" width={220} style={{ borderRight: '1px solid #f0f0f0' }}>
        <div className="brand">企业协同办公平台</div>
        <Menu
          mode="inline"
          theme="light"
          selectedKeys={[selectedKey]}
          items={menuItems}
          onClick={({ key }) => navigate(key)}
          style={{ borderInlineEnd: 'none' }}
        />
      </Sider>
      <AntdLayout>
        <Header
          style={{
            background: '#fff',
            padding: '0 24px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderBottom: '1px solid #f0f0f0',
            height: 56,
            lineHeight: '56px',
          }}
        >
          <span style={{ fontSize: 16, fontWeight: 600 }}>{currentTitle || '企业协同办公平台'}</span>
          <Dropdown menu={userMenu} placement="bottomRight">
            <Button type="text" style={{ height: 40 }}>
              <Space size={8}>
                <Avatar size="small" style={{ background: '#1677ff' }}>
                  {user.name.charAt(0)}
                </Avatar>
                <span>
                  {user.name} · {ROLE_LABEL[user.role] ?? user.role}
                </span>
              </Space>
            </Button>
          </Dropdown>
        </Header>
        <Content style={{ padding: 24 }}>
          <Outlet />
        </Content>
      </AntdLayout>
      <FloatingAssistant />
    </AntdLayout>
  );
}