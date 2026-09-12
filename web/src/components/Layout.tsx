import {
  AuditOutlined,
  BookOutlined,
  CarryOutOutlined,
  DashboardOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  NotificationOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { Avatar, Button, Dropdown, Layout as AntdLayout, Menu, Space } from 'antd';
import { useState } from 'react';
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
  { to: '/directory', label: '人员管理', icon: <TeamOutlined /> },
  { to: '/knowledge', label: '知识库', icon: <BookOutlined /> },
];

// 受保护的全局布局：登录守卫 + 侧边导航 + 顶栏 + 内容区 + 悬浮助手
export default function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(false);

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
      <Sider
        theme="light"
        width={220}
        collapsible
        collapsed={collapsed}
        onCollapse={setCollapsed}
        breakpoint="lg"
        trigger={null}
        style={{ borderRight: '1px solid var(--color-border)' }}
      >
        <div className="brand">
          <span className="brand-icon">OA</span>
          {!collapsed && <span className="brand-text">企业协同办公平台</span>}
        </div>
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
            padding: '0 20px',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            borderBottom: '1px solid var(--color-border)',
            height: 56,
            lineHeight: '56px',
          }}
        >
          <Button
            type="text"
            aria-label={collapsed ? '展开菜单' : '收起菜单'}
            icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
            onClick={() => setCollapsed((v) => !v)}
          />
          <span style={{ fontSize: 16, fontWeight: 600 }}>{currentTitle || '企业协同办公平台'}</span>
          <div style={{ marginLeft: 'auto' }}>
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
          </div>
        </Header>
        <Content style={{ padding: 24 }}>
          <Outlet />
        </Content>
      </AntdLayout>
      <FloatingAssistant />
    </AntdLayout>
  );
}