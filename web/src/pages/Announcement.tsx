import { PlusOutlined } from '@ant-design/icons';
import { Alert, App, Button, Card, Checkbox, Flex, Form, Input, Modal, Tag, Typography } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { apiGet, apiPost } from '../api';
import type { Announcement, Paged } from '../types';
import { useAuth } from '../auth/AuthContext';
import DataTable, { type Column } from '../components/DataTable';

// 时间格式化（epoch 毫秒 → 本地时间）
function fmtTime(ts: number): string {
  return ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '-';
}

// 公告：列表 / 详情 / 发布（管理员）
export default function AnnouncementPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';
  const [rows, setRows] = useState<Announcement[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Announcement | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiGet<Paged<Announcement>>('/api/announcements?pageSize=100');
      setRows(data.list);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const openDetail = async (id: string) => {
    setDetailId(id);
    setDetail(null);
    try {
      const data = await apiGet<Announcement>(`/api/announcements/${id}`);
      setDetail(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载详情失败');
    }
  };

  const columns: Column<Announcement>[] = [
    {
      key: 'title',
      title: '标题',
      render: (r) => (
        <>
          {r.pinned && (
            <Tag color="red" className="mr-8">
              置顶
            </Tag>
          )}
          {r.title}
        </>
      ),
    },
    { key: 'authorName', title: '发布人' },
    { key: 'publishedAt', title: '发布时间', render: (r) => fmtTime(r.publishedAt) },
    {
      key: 'action',
      title: '操作',
      render: (r) => (
        <Button type="link" size="small" onClick={() => openDetail(r.id)}>
          查看
        </Button>
      ),
    },
  ];

  return (
    <Flex vertical gap={16}>
      <Flex justify="space-between" align="center">
        <Typography.Title level={4} className="page-title">
          公告
        </Typography.Title>
        {isAdmin && (
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setShowCreate(true)}>
            发布公告
          </Button>
        )}
      </Flex>

      <Card>
        {error && <Alert type="error" showIcon title={error} className="mb-12" />}
        <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} loading={loading} emptyText="暂无公告" />
      </Card>

      {detailId && <DetailModal detail={detail} onClose={() => setDetailId(null)} />}
      {showCreate && <CreateModal onClose={() => setShowCreate(false)} onCreated={load} />}
    </Flex>
  );
}

// 公告详情弹窗
function DetailModal(props: { detail: Announcement | null; onClose: () => void }) {
  const { detail, onClose } = props;
  return (
    <Modal title={detail ? detail.title : '公告详情'} open onCancel={onClose} footer={null} width={560}>
      {detail ? (
        <Flex vertical gap={12}>
          <Typography.Text type="secondary">
            {detail.authorName} · {fmtTime(detail.publishedAt)}
          </Typography.Text>
          <pre className="pre-wrap">{detail.content}</pre>
        </Flex>
      ) : (
        <Typography.Text type="secondary">加载中...</Typography.Text>
      )}
    </Modal>
  );
}

// 发布公告弹窗
function CreateModal(props: { onClose: () => void; onCreated: () => void }) {
  const { onClose, onCreated } = props;
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleOk = async () => {
    let values: { title: string; content: string; pinned?: boolean };
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    setSubmitting(true);
    try {
      await apiPost('/api/announcements', {
        title: values.title.trim(),
        content: values.content.trim(),
        pinned: values.pinned ?? false,
      });
      message.success('发布成功');
      onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '发布失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal title="发布公告" open onOk={handleOk} onCancel={onClose} confirmLoading={submitting} okText="发布" cancelText="取消">
      {error && <Alert type="error" showIcon title={error} className="mb-16" />}
      <Form form={form} layout="vertical" requiredMark={false}>
        <Form.Item name="title" label="标题" rules={[{ required: true, message: '请输入公告标题' }]}>
          <Input />
        </Form.Item>
        <Form.Item name="content" label="正文" rules={[{ required: true, message: '请输入公告正文' }]}>
          <Input.TextArea rows={5} />
        </Form.Item>
        <Form.Item name="pinned" valuePropName="checked">
          <Checkbox>置顶公告</Checkbox>
        </Form.Item>
      </Form>
    </Modal>
  );
}