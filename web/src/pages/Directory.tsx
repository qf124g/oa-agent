import {
  App,
  Alert,
  Avatar,
  Button,
  Card,
  Drawer,
  Descriptions,
  Flex,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Tag,
  Typography,
} from 'antd';
import { EditOutlined, MailOutlined, PhoneOutlined, UserOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useState } from 'react';
import { apiGet, apiPatch, apiPost } from '../api';
import type { Department, Employee, Paged } from '../types';
import { ROLE_LABEL } from '../constants';
import { useAuth } from '../auth/AuthContext';
import DataTable, { type Column } from '../components/DataTable';

// 人员管理：部门筛选 + 员工列表，管理员可新建/编辑员工
export default function Directory() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';
  const [departments, setDepartments] = useState<Department[]>([]);
  const [rows, setRows] = useState<Employee[]>([]);
  const [departmentId, setDepartmentId] = useState('');
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [detailId, setDetailId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const loadDepartments = useCallback(async () => {
    try {
      const data = await apiGet<Department[]>('/api/departments');
      setDepartments(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载部门失败');
    }
  }, []);

  const loadEmployees = useCallback(async () => {
    setLoading(true);
    try {
      const q = new URLSearchParams({ pageSize: '100' });
      if (departmentId) q.set('departmentId', departmentId);
      if (name.trim()) q.set('name', name.trim());
      const data = await apiGet<Paged<Employee>>(`/api/employees?${q.toString()}`);
      setRows(data.list);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载员工失败');
    } finally {
      setLoading(false);
    }
  }, [departmentId, name]);

  useEffect(() => {
    loadDepartments();
  }, [loadDepartments]);

  useEffect(() => {
    loadEmployees();
  }, [loadEmployees]);

  const columns: Column<Employee>[] = [
    {
      key: 'name',
      title: '姓名',
      render: (r) => (
        <Space size={8}>
          <Avatar size="small" className={r.role === 'ADMIN' ? 'avatar-admin' : 'avatar-muted'}>
            {r.name.charAt(0)}
          </Avatar>
          <span>{r.name}</span>
        </Space>
      ),
    },
    { key: 'userNo', title: '工号' },
    { key: 'departmentName', title: '部门' },
    { key: 'title', title: '职位' },
    { key: 'role', title: '角色', render: (r) => <Tag color={r.role === 'ADMIN' ? 'blue' : 'default'}>{ROLE_LABEL[r.role] ?? r.role}</Tag> },
    {
      key: 'action',
      title: '操作',
      render: (r) => (
        <Button type="link" size="small" className="p-0" onClick={() => setDetailId(r.id)}>
          详情
        </Button>
      ),
    },
  ];

  return (
    <Flex vertical gap={16}>
      <Flex align="center" justify="space-between">
        <Typography.Title level={4} className="page-title">
          人员管理
        </Typography.Title>
        {isAdmin && (
          <Button type="primary" icon={<EditOutlined />} onClick={() => setShowCreate(true)}>
            新建员工
          </Button>
        )}
      </Flex>

      <Card>
        <Flex wrap gap={12} className="mb-12">
          <Select
            value={departmentId || undefined}
            placeholder="全部部门"
            allowClear
            className="w-160"
            onChange={(v) => setDepartmentId(v ?? '')}
            options={departments.map((d) => ({ value: d.id, label: d.name }))}
          />
          <Input.Search
            placeholder="按姓名搜索"
            allowClear
            className="w-220"
            onSearch={(v) => setName(v)}
          />
        </Flex>
        {error && <Alert type="error" showIcon title={error} className="mb-12" />}
        <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} loading={loading} emptyText="暂无员工" />
      </Card>

      {detailId && (
        <EmployeeDrawer
          employeeId={detailId}
          departments={departments}
          isAdmin={isAdmin}
          onClose={() => setDetailId(null)}
          onUpdated={loadEmployees}
        />
      )}
      {showCreate && (
        <CreateEmployeeModal departments={departments} onClose={() => setShowCreate(false)} onCreated={loadEmployees} />
      )}
    </Flex>
  );
}

// 员工详情抽屉：顶部信息卡 + 详情展示，管理员可切换编辑模式更新信息
function EmployeeDrawer(props: {
  employeeId: string;
  departments: Department[];
  isAdmin: boolean;
  onClose: () => void;
  onUpdated: () => void;
}) {
  const { employeeId, departments, isAdmin, onClose, onUpdated } = props;
  const { message } = App.useApp();
  const [detail, setDetail] = useState<Employee | null>(null);
  const [editing, setEditing] = useState(false);
  const [form] = Form.useForm();

  const load = useCallback(async () => {
    setDetail(null);
    try {
      const data = await apiGet<Employee>(`/api/employees/${employeeId}`);
      setDetail(data);
      form.setFieldsValue(data);
    } catch (err) {
      message.error(err instanceof Error ? err.message : '加载员工详情失败');
    }
  }, [employeeId, form, message]);

  useEffect(() => {
    load();
  }, [load]);

  const handleSave = async () => {
    const values = await form.validateFields();
    setDetail(null);
    try {
      await apiPatch(`/api/employees/${employeeId}`, values);
      message.success('员工信息已更新');
      setEditing(false);
      await load();
      onUpdated();
    } catch (err) {
      message.error(err instanceof Error ? err.message : '更新失败');
    }
  };

  return (
    <Drawer
      open
      onClose={onClose}
      title={null}
      className="employee-drawer"
      width={480}
      extra={
        editing ? (
          <Space>
            <Button onClick={() => { setEditing(false); form.setFieldsValue(detail); }}>取消</Button>
            <Button type="primary" onClick={handleSave}>保存</Button>
          </Space>
        ) : isAdmin ? (
          <Button type="primary" icon={<EditOutlined />} onClick={() => setEditing(true)}>
            编辑
          </Button>
        ) : null
      }
    >
      {detail ? (
        <Flex vertical>
          {/* 头部信息卡 */}
          <Flex align="center" gap={16} className="directory-drawer-head">
            <Avatar size={64} className={detail.role === 'ADMIN' ? 'avatar-admin avatar-lg' : 'avatar-muted avatar-lg'}>
              {detail.name.charAt(0)}
            </Avatar>
            <Flex vertical gap={6} className="directory-drawer-info">
              <Space size={8}>
                <span className="directory-drawer-name">{detail.name}</span>
                <Tag color={detail.role === 'ADMIN' ? 'blue' : 'default'}>{ROLE_LABEL[detail.role] ?? detail.role}</Tag>
              </Space>
              <Typography.Text type="secondary">{detail.title} · {detail.departmentName}</Typography.Text>
            </Flex>
          </Flex>

          {editing ? (
            <Form form={form} layout="vertical" className="directory-drawer-body" initialValues={detail}>
              <Form.Item name="userNo" label="工号（登录账号）" rules={[{ required: true, message: '请输入工号' }]}>
                <Input />
              </Form.Item>
              <Form.Item name="name" label="姓名" rules={[{ required: true, message: '请输入姓名' }]}>
                <Input />
              </Form.Item>
              <Form.Item name="departmentId" label="部门" rules={[{ required: true, message: '请选择部门' }]}>
                <Select options={departments.map((d) => ({ value: d.id, label: d.name }))} />
              </Form.Item>
              <Form.Item name="title" label="职位" rules={[{ required: true, message: '请输入职位' }]}>
                <Input />
              </Form.Item>
              <Form.Item name="phone" label="手机">
                <Input />
              </Form.Item>
              <Form.Item name="email" label="邮箱">
                <Input placeholder="留空则重置为 工号@oa.local" />
              </Form.Item>
              <Form.Item name="role" label="角色" rules={[{ required: true }]}>
                <Select options={[{ value: 'EMPLOYEE', label: '员工' }, { value: 'ADMIN', label: '管理员' }]} />
              </Form.Item>
              <Form.Item name="password" label="重置密码">
                <Input.Password placeholder="留空则不修改密码" autoComplete="new-password" />
              </Form.Item>
            </Form>
          ) : (
            <Flex vertical gap={20} className="directory-drawer-body">
              <Descriptions column={1} size="small" colon={false}>
                <Descriptions.Item label={<Space size={4}><UserOutlined />工号</Space>}>{detail.userNo}</Descriptions.Item>
                <Descriptions.Item label={<Space size={4}><PhoneOutlined />手机</Space>}>{detail.phone || '-'}</Descriptions.Item>
                <Descriptions.Item label={<Space size={4}><MailOutlined />邮箱</Space>}>{detail.email || '-'}</Descriptions.Item>
              </Descriptions>
            </Flex>
          )}
        </Flex>
      ) : (
        <Flex align="center" justify="center" className="directory-drawer-empty">
          <Typography.Text type="secondary">加载中...</Typography.Text>
        </Flex>
      )}
    </Drawer>
  );
}

// 新建员工弹窗（仅管理员可见入口）：工号即登录账号，初始密码默认 123456
function CreateEmployeeModal(props: { departments: Department[]; onClose: () => void; onCreated: () => void }) {
  const { departments, onClose, onCreated } = props;
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    const values = await form.validateFields();
    setSubmitting(true);
    try {
      await apiPost('/api/employees', values);
      message.success('员工创建成功');
      onCreated();
      onClose();
    } catch (err) {
      message.error(err instanceof Error ? err.message : '创建失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal title="新建员工" open onCancel={onClose} onOk={handleSubmit} confirmLoading={submitting} okText="创建" cancelText="取消" width={480}>
      <Form form={form} layout="vertical" initialValues={{ role: 'EMPLOYEE', password: '123456' }}>
        <Form.Item name="userNo" label="工号（即登录账号）" rules={[{ required: true, message: '请输入工号' }]}>
          <Input placeholder="如 zhaoliu" />
        </Form.Item>
        <Form.Item name="name" label="姓名" rules={[{ required: true, message: '请输入姓名' }]}>
          <Input placeholder="如 赵六" />
        </Form.Item>
        <Form.Item name="departmentId" label="部门" rules={[{ required: true, message: '请选择部门' }]}>
          <Select placeholder="选择部门" options={departments.map((d) => ({ value: d.id, label: d.name }))} />
        </Form.Item>
        <Form.Item name="title" label="职位" rules={[{ required: true, message: '请输入职位' }]}>
          <Input placeholder="如 前端工程师" />
        </Form.Item>
        <Form.Item name="phone" label="手机">
          <Input placeholder="选填" />
        </Form.Item>
        <Form.Item name="email" label="邮箱">
          <Input placeholder="选填，默认为 工号@oa.local" />
        </Form.Item>
        <Form.Item name="role" label="角色" rules={[{ required: true }]}>
          <Select options={[{ value: 'EMPLOYEE', label: '员工' }, { value: 'ADMIN', label: '管理员' }]} />
        </Form.Item>
        <Form.Item name="password" label="初始密码">
          <Input.Password placeholder="默认 123456" />
        </Form.Item>
      </Form>
    </Modal>
  );
}