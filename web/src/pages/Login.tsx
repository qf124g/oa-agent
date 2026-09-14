import { LockOutlined, UserOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Form, Input, Typography } from 'antd';
import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

// 登录页：账号密码登录，成功后写入 token 并进入工作台
export default function Login() {
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // 已登录则直接进入
  if (user) {
    return <Navigate to="/" replace />;
  }

  const handleSubmit = async (values: { username: string; password: string }) => {
    setError('');
    setLoading(true);
    try {
      await login(values.username.trim(), values.password);
      navigate('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      <Card className="login-card">
        <Typography.Title level={3} className="login-title">
          企业协同办公平台
        </Typography.Title>
        <Typography.Text type="secondary" className="login-subtitle">
          请使用平台账号登录
        </Typography.Text>
        {error && <Alert type="error" showIcon title={error} className="mb-16" />}
        <Form layout="vertical" onFinish={handleSubmit} requiredMark={false}>
          <Form.Item name="username" label="账号" rules={[{ required: true, message: '请输入账号' }]}>
            <Input prefix={<UserOutlined />} placeholder="如 admin / zhangwei" size="large" />
          </Form.Item>
          <Form.Item name="password" label="密码" rules={[{ required: true, message: '请输入密码' }]}>
            <Input.Password prefix={<LockOutlined />} placeholder="默认 123456" size="large" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block size="large" loading={loading}>
            登录
          </Button>
        </Form>
        <Typography.Text type="secondary" className="login-hint">
          固定账号：admin / zhangwei / lina，密码均为 123456
        </Typography.Text>
      </Card>
    </div>
  );
}