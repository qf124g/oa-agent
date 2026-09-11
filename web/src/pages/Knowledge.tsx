import { PlusOutlined } from '@ant-design/icons';
import { Alert, App, Button, Card, Flex, Form, Input, Modal, Popconfirm, Tag, Typography } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { apiDelete, apiGet, apiPost } from '../api';
import type { KnowledgeDocument, Paged } from '../types';
import { useAuth } from '../auth/AuthContext';
import DataTable, { type Column } from '../components/DataTable';

// 时间格式化（epoch 毫秒 → 本地时间）
function fmtTime(ts: number): string {
  return ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '-';
}

// 知识库：文档列表 / 详情 / 新增 / 删除（管理员）
export default function Knowledge() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';
  const [rows, setRows] = useState<KnowledgeDocument[]>([]);
  const [category, setCategory] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<KnowledgeDocument | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const q = new URLSearchParams({ pageSize: '100' });
      if (category) q.set('category', category);
      const data = await apiGet<Paged<KnowledgeDocument>>(`/api/knowledge?${q.toString()}`);
      setRows(data.list);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [category]);

  useEffect(() => {
    load();
  }, [load]);

  const openDetail = async (id: string) => {
    setDetailId(id);
    setDetail(null);
    try {
      const data = await apiGet<KnowledgeDocument>(`/api/knowledge/${id}`);
      setDetail(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载详情失败');
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await apiDelete(`/api/knowledge/${id}`);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败');
    }
  };

  const columns: Column<KnowledgeDocument>[] = [
    { key: 'title', title: '文档标题' },
    { key: 'category', title: '分类', render: (r) => (r.category ? <Tag color="blue">{r.category}</Tag> : <Tag>未分类</Tag>) },
    { key: 'uploadedByName', title: '上传人' },
    { key: 'updatedAt', title: '更新时间', render: (r) => fmtTime(r.updatedAt) },
    {
      key: 'action',
      title: '操作',
      render: (r) => (
        <Flex gap={8}>
          <Button type="link" size="small" onClick={() => openDetail(r.id)}>
            查看
          </Button>
          {isAdmin && (
            <Popconfirm title="确认删除该文档？删除后将从知识库与向量索引中移除。" onConfirm={() => handleDelete(r.id)} okText="删除" cancelText="取消" okButtonProps={{ danger: true }}>
              <Button type="link" size="small" danger>
                删除
              </Button>
            </Popconfirm>
          )}
        </Flex>
      ),
    },
  ];

  return (
    <Flex vertical gap={16}>
      <Flex justify="space-between" align="center">
        <Typography.Title level={4} style={{ margin: 0 }}>
          知识库
        </Typography.Title>
        {isAdmin && (
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setShowCreate(true)}>
            新增文档
          </Button>
        )}
      </Flex>

      <Card>
        <Flex gap={12} style={{ marginBottom: 12 }}>
          <Input.Search placeholder="按分类筛选，如 制度" allowClear style={{ width: 240 }} onSearch={(v) => setCategory(v)} />
        </Flex>
        {error && <Alert type="error" showIcon title={error} style={{ marginBottom: 12 }} />}
        <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} loading={loading} emptyText="暂无文档" />
      </Card>

      {detailId && <DetailModal detail={detail} onClose={() => setDetailId(null)} />}
      {showCreate && <CreateModal onClose={() => setShowCreate(false)} onCreated={load} />}
    </Flex>
  );
}

// 文档详情弹窗
function DetailModal(props: { detail: KnowledgeDocument | null; onClose: () => void }) {
  const { detail, onClose } = props;
  return (
    <Modal title={detail ? detail.title : '文档详情'} open onCancel={onClose} footer={null} width={560}>
      {detail ? (
        <Flex vertical gap={12}>
          <Typography.Text type="secondary">
            分类：{detail.category || '未分类'} · 更新：{fmtTime(detail.updatedAt)}
          </Typography.Text>
          <pre className="pre-wrap">{detail.content}</pre>
        </Flex>
      ) : (
        <Typography.Text type="secondary">加载中...</Typography.Text>
      )}
    </Modal>
  );
}

// 新增文档弹窗（管理员）
function CreateModal(props: { onClose: () => void; onCreated: () => void }) {
  const { onClose, onCreated } = props;
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleOk = async () => {
    let values: { title: string; category?: string; content: string };
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    setSubmitting(true);
    try {
      await apiPost('/api/knowledge', {
        title: values.title.trim(),
        content: values.content.trim(),
        category: values.category?.trim() ?? '',
      });
      message.success('保存成功');
      onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '新增失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal title="新增知识库文档" open onOk={handleOk} onCancel={onClose} confirmLoading={submitting} okText="保存" cancelText="取消">
      {error && <Alert type="error" showIcon title={error} style={{ marginBottom: 16 }} />}
      <Form form={form} layout="vertical" requiredMark={false}>
        <Form.Item name="title" label="标题" rules={[{ required: true, message: '请输入文档标题' }]}>
          <Input />
        </Form.Item>
        <Form.Item name="category" label="分类">
          <Input placeholder="如 制度 / FAQ / 操作手册" />
        </Form.Item>
        <Form.Item name="content" label="正文" rules={[{ required: true, message: '请输入文档正文' }]}>
          <Input.TextArea rows={5} />
        </Form.Item>
      </Form>
    </Modal>
  );
}