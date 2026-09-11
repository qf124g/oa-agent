import { PlusOutlined } from '@ant-design/icons';
import { Alert, App, Button, Card, DatePicker, Flex, Form, Input, Modal, Select, Tag, Typography } from 'antd';
import type { Dayjs } from 'dayjs';
import { useCallback, useEffect, useState } from 'react';
import { apiGet, apiPatch, apiPost } from '../api';
import type { TodoTask } from '../types';
import { TODO_PRIORITY, TODO_STATUS } from '../constants';
import DataTable, { type Column } from '../components/DataTable';

// 待办任务：列表/筛选/新建/标记完成
export default function Todo() {
  const { message } = App.useApp();
  const [todos, setTodos] = useState<TodoTask[]>([]);
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showCreate, setShowCreate] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiGet<{ list: TodoTask[] }>(`/api/todos?pageSize=100${status ? `&status=${status}` : ''}`);
      setTodos(data.list);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    load();
  }, [load]);

  const handleComplete = async (id: string) => {
    try {
      await apiPatch(`/api/todos/${id}/complete`);
      message.success('已标记完成');
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败');
    }
  };

  const columns: Column<TodoTask>[] = [
    { key: 'title', title: '待办事项' },
    { key: 'ownerName', title: '归属人' },
    { key: 'priority', title: '优先级', render: (r) => <Tag color={TODO_PRIORITY[r.priority].color}>{TODO_PRIORITY[r.priority].label}</Tag> },
    { key: 'status', title: '状态', render: (r) => <Tag color={TODO_STATUS[r.status].color}>{TODO_STATUS[r.status].label}</Tag> },
    { key: 'dueDate', title: '截止日期', render: (r) => r.dueDate || '-' },
    {
      key: 'action',
      title: '操作',
      render: (r) =>
        r.status === 'PENDING' ? (
          <Button type="link" size="small" onClick={() => handleComplete(r.id)}>
            完成
          </Button>
        ) : (
          <Typography.Text type="secondary">—</Typography.Text>
        ),
    },
  ];

  return (
    <Flex vertical gap={16}>
      <Flex justify="space-between" align="center">
        <Typography.Title level={4} style={{ margin: 0 }}>
          待办任务
        </Typography.Title>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setShowCreate(true)}>
          新建待办
        </Button>
      </Flex>

      <Card>
        <Flex wrap gap={12} style={{ marginBottom: 12 }}>
          <Select
            value={status || undefined}
            placeholder="全部状态"
            allowClear
            style={{ width: 140 }}
            onChange={(v) => setStatus(v ?? '')}
            options={[
              { value: 'PENDING', label: '待处理' },
              { value: 'DONE', label: '已完成' },
            ]}
          />
        </Flex>
        {error && <Alert type="error" showIcon title={error} style={{ marginBottom: 12 }} />}
        <DataTable columns={columns} rows={todos} rowKey={(r) => r.id} loading={loading} />
      </Card>

      {showCreate && <CreateTodoModal onClose={() => setShowCreate(false)} onCreated={load} />}
    </Flex>
  );
}

// 新建待办弹窗
function CreateTodoModal(props: { onClose: () => void; onCreated: () => void }) {
  const { onClose, onCreated } = props;
  const [form] = Form.useForm();
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleOk = async () => {
    let values: { title: string; description?: string; priority: string; dueDate?: Dayjs };
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    setSubmitting(true);
    try {
      const dueDate = values.dueDate ? values.dueDate.format('YYYY-MM-DD') : '';
      await apiPost('/api/todos', {
        title: values.title.trim(),
        description: values.description?.trim() ?? '',
        priority: values.priority,
        dueDate,
      });
      onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '新建失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal title="新建待办" open onOk={handleOk} onCancel={onClose} confirmLoading={submitting} okText="提交" cancelText="取消">
      {error && <Alert type="error" showIcon title={error} style={{ marginBottom: 16 }} />}
      <Form form={form} layout="vertical" initialValues={{ priority: 'MEDIUM' }} requiredMark={false}>
        <Form.Item name="title" label="标题" rules={[{ required: true, message: '请输入待办标题' }]}>
          <Input placeholder="如：提交周报" />
        </Form.Item>
        <Form.Item name="description" label="描述">
          <Input.TextArea rows={3} placeholder="补充说明（可选）" />
        </Form.Item>
        <Form.Item name="priority" label="优先级">
          <Select
            options={[
              { value: 'HIGH', label: '高' },
              { value: 'MEDIUM', label: '中' },
              { value: 'LOW', label: '低' },
            ]}
          />
        </Form.Item>
        <Form.Item name="dueDate" label="截止日期">
          <DatePicker style={{ width: '100%' }} />
        </Form.Item>
      </Form>
    </Modal>
  );
}