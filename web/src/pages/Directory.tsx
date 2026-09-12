import { Alert, App, Button, Card, Descriptions, Flex, Form, Input, Modal, Select, Tag, Typography } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { apiGet, apiPost } from '../api';
import type { Department, Employee, Paged } from '../types';
import { ROLE_LABEL } from '../constants';
import { useAuth } from '../auth/AuthContext';
import DataTable, { type Column } from '../components/DataTable';

// 通讯录：部门筛选 + 员工列表 / 详情，管理员可新建员工
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
  const [detail, setDetail] = useState<Employee | null>(null);
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

  const openDetail = async (id: string) => {
    setDetailId(id);
    setDetail(null);
    try {
      const data = await apiGet<Employee>(`/api/employees/${id}`);
      setDetail(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载员工详情失败');
    }
  };

  const columns: Column<Employee>[] = [
    { key: 'name', title: '姓名' },
    { key: 'userNo', title: '工号' },
    { key: 'departmentName', title: '部门' },
    { key: 'title', title: '职位' },
    { key: 'role', title: '角色', render: (r) => <Tag color={r.role === 'ADMIN' ? 'blue' : 'default'}>{ROLE_LABEL[r.role] ?? r.role}</Tag> },
    {
      key: 'action',
      title: '操作',
      render: (r) => (
        <a onClick={() => openDetail(r.id)} style={{ color: '#1677ff' }}>
          详情
        </a>
      ),
    },
  ];

  return (
    <Flex vertical gap={16}>
      <Typography.Title level={4} style={{ margin: 0 }}>
        通讯录
      </Typography.Title>

      <Card>
        <Flex wrap gap={12} style={{ marginBottom: 12 }}>
          <Select
            value={departmentId || undefined}
            placeholder="全部部门"
            allowClear
            style={{ width: 160 }}
            onChange={(v) => setDepartmentId(v ?? '')}
            options={departments.map((d) => ({ value: d.id, label: d.name }))}
          />
          <Input.Search
            placeholder="按姓名搜索"
            allowClear
            style={{ width: 220 }}
            onSearch={(v) => setName(v)}
          />
          {isAdmin && (
            <Button type="primary" style={{ marginLeft: 'auto' }} onClick={() => setShowCreate(true)}>
              新建员工
            </Button>
          )}
        </Flex>
        {error && <Alert type="error" showIcon title={error} style={{ marginBottom: 12 }} />}
        <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} loading={loading} emptyText="暂无员工" />
      </Card>

      {detailId && <DetailModal detail={detail} onClose={() => setDetailId(null)} />}
      {showCreate && (
        <CreateEmployeeModal departments={departments} onClose={() => setShowCreate(false)} onCreated={loadEmployees} />
      )}
    </Flex>
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

// 员工详情弹窗
function DetailModal(props: { detail: Employee | null; onClose: () => void }) {
  const { detail, onClose } = props;
  return (
    <Modal title={detail ? detail.name : '员工详情'} open onCancel={onClose} footer={null} width={520}>
      {detail ? (
        <Descriptions column={1} size="small">
          <Descriptions.Item label="工号">{detail.userNo}</Descriptions.Item>
          <Descriptions.Item label="部门">{detail.departmentName}</Descriptions.Item>
          <Descriptions.Item label="职位">{detail.title}</Descriptions.Item>
          <Descriptions.Item label="角色">{ROLE_LABEL[detail.role] ?? detail.role}</Descriptions.Item>
          <Descriptions.Item label="手机">{detail.phone || '-'}</Descriptions.Item>
          <Descriptions.Item label="邮箱">{detail.email || '-'}</Descriptions.Item>
        </Descriptions>
      ) : (
        <Typography.Text type="secondary">加载中...</Typography.Text>
      )}
    </Modal>
  );
}