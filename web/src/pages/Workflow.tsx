import { Alert, App, Button, Card, Flex, Form, Input, Modal, Select, Space, Tag, Typography } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiDelete, apiGet, apiPost } from '../api';
import type { WorkflowDefinition } from '../types';
import { APPROVAL_TYPE } from '../constants';
import { useAuth } from '../auth/AuthContext';
import DataTable, { type Column } from '../components/DataTable';

// 时间格式化（epoch 毫秒 → 本地时间）
function fmtTime(ts: number): string {
  return ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '-';
}

// 流程设计列表：展示所有流程定义，管理员可新建/删除
export default function Workflow() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';
  const navigate = useNavigate();
  const { message } = App.useApp();
  const [rows, setRows] = useState<WorkflowDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showCreate, setShowCreate] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiGet<WorkflowDefinition[]>('/api/workflows');
      setRows(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载流程失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleDelete = async (wf: WorkflowDefinition) => {
    try {
      await apiDelete(`/api/workflows/${wf.id}`);
      message.success('流程已删除');
      load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : '删除失败');
    }
  };

  const columns: Column<WorkflowDefinition>[] = [
    { key: 'name', title: '流程名称' },
    {
      key: 'approvalType',
      title: '审批类型',
      render: (r) =>
        r.approvalType ? (
          <Tag color={APPROVAL_TYPE[r.approvalType]?.color}>{APPROVAL_TYPE[r.approvalType]?.label}</Tag>
        ) : (
          '-'
        ),
    },
    { key: 'nodes', title: '节点数', render: (r) => r.nodes.length },
    { key: 'updatedAt', title: '更新时间', render: (r) => fmtTime(r.updatedAt) },
    {
      key: 'action',
      title: '操作',
      render: (r) => (
        <Space size={8}>
          <Button type="link" size="small" className="p-0" onClick={() => navigate(`/workflow/${r.id}`)}>
            编辑
          </Button>
          {isAdmin && (
            <Button type="link" size="small" danger className="p-0" onClick={() => handleDelete(r)}>
              删除
            </Button>
          )}
        </Space>
      ),
    },
  ];

  return (
    <Flex vertical gap={16}>
      <Flex align="center" justify="space-between">
        <Typography.Title level={4} className="page-title">
          流程设计
        </Typography.Title>
        {isAdmin && (
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setShowCreate(true)}>
            新建流程
          </Button>
        )}
      </Flex>

      <Card>
        {error && <Alert type="error" showIcon title={error} className="mb-12" />}
        <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} loading={loading} emptyText="暂无流程" />
      </Card>

      {showCreate && (
        <CreateWorkflowModal
          onClose={() => setShowCreate(false)}
          onCreated={(id) => {
            setShowCreate(false);
            navigate(`/workflow/${id}`);
          }}
        />
      )}
    </Flex>
  );
}

// 新建流程弹窗（仅管理员入口）：填写名称与关联审批类型，创建后跳转设计器
function CreateWorkflowModal(props: { onClose: () => void; onCreated: (id: string) => void }) {
  const { onClose, onCreated } = props;
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    const values = await form.validateFields();
    setSubmitting(true);
    try {
      const wf = await apiPost<WorkflowDefinition>('/api/workflows', {
        name: values.name,
        approvalType: values.approvalType ?? null,
        nodes: [],
        edges: [],
      });
      message.success('流程已创建');
      onCreated(wf.id);
    } catch (err) {
      message.error(err instanceof Error ? err.message : '创建失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title="新建流程"
      open
      onCancel={onClose}
      onOk={handleSubmit}
      confirmLoading={submitting}
      okText="创建"
      cancelText="取消"
      width={480}
    >
      <Form form={form} layout="vertical">
        <Form.Item name="name" label="流程名称" rules={[{ required: true, message: '请输入流程名称' }]}>
          <Input placeholder="如 请假审批流程" />
        </Form.Item>
        <Form.Item name="approvalType" label="关联审批类型">
          <Select
            allowClear
            placeholder="选择审批类型"
            options={Object.entries(APPROVAL_TYPE).map(([value, v]) => ({ value, label: v.label }))}
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}