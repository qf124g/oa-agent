import { Alert, App, Button, Card, Descriptions, Flex, Form, Input, InputNumber, Modal, Select, Tabs, Tag, Typography } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { apiGet, apiPost } from '../api';
import type { ApprovalRequest, ApprovalType, Paged } from '../types';
import { APPROVAL_STATUS, APPROVAL_TYPE } from '../constants';
import { useAuth } from '../auth/AuthContext';
import DataTable, { type Column } from '../components/DataTable';

// 时间格式化（epoch 毫秒 → 本地时间）
function fmtTime(ts: number): string {
  return ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '-';
}

// 审批中心：我发起的 / 待我审批 / 发起申请
export default function Approval() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';
  const [activeKey, setActiveKey] = useState('mine');
  const [refresh, setRefresh] = useState(0);

  const items = [
    { key: 'mine', label: '我发起的', children: <MineTab refresh={refresh} /> },
    { key: 'pending', label: '待我审批', children: <PendingTab isAdmin={isAdmin} /> },
    {
      key: 'create',
      label: '发起申请',
      children: (
        <CreateForm
          onCreated={() => {
            setRefresh((v) => v + 1);
            setActiveKey('mine');
          }}
        />
      ),
    },
  ];

  return (
    <Flex vertical gap={16}>
      <Typography.Title level={4} className="page-title">
        审批中心
      </Typography.Title>
      <Card>
        <Tabs activeKey={activeKey} onChange={setActiveKey} items={items} />
      </Card>
    </Flex>
  );
}

// 我发起的申请列表
function MineTab({ refresh }: { refresh: number }) {
  const [rows, setRows] = useState<ApprovalRequest[]>([]);
  const [type, setType] = useState('');
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const q = new URLSearchParams({ pageSize: '100' });
      if (type) q.set('type', type);
      if (status) q.set('status', status);
      const data = await apiGet<Paged<ApprovalRequest>>(`/api/approvals/mine?${q.toString()}`);
      setRows(data.list);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [type, status]);

  useEffect(() => {
    load();
  }, [load, refresh]);

  const columns: Column<ApprovalRequest>[] = [
    { key: 'title', title: '申请标题' },
    { key: 'type', title: '类型', render: (r) => <Tag color={APPROVAL_TYPE[r.type].color}>{APPROVAL_TYPE[r.type].label}</Tag> },
    { key: 'amount', title: '金额', render: (r) => (r.amount != null ? `¥${r.amount}` : '-') },
    { key: 'status', title: '状态', render: (r) => <Tag color={APPROVAL_STATUS[r.status].color}>{APPROVAL_STATUS[r.status].label}</Tag> },
    { key: 'createdAt', title: '发起时间', render: (r) => fmtTime(r.createdAt) },
  ];

  return (
    <Flex vertical gap={12}>
      <Flex wrap gap={12}>
        <Select
          value={type || undefined}
          placeholder="全部类型"
          allowClear
          className="w-140"
          onChange={(v) => setType(v ?? '')}
          options={[
            { value: 'LEAVE', label: '请假' },
            { value: 'EXPENSE', label: '报销' },
            { value: 'PURCHASE', label: '采购' },
          ]}
        />
        <Select
          value={status || undefined}
          placeholder="全部状态"
          allowClear
          className="w-140"
          onChange={(v) => setStatus(v ?? '')}
          options={[
            { value: 'PENDING', label: '待审批' },
            { value: 'APPROVED', label: '已通过' },
            { value: 'REJECTED', label: '已驳回' },
          ]}
        />
      </Flex>
      {error && <Alert type="error" showIcon title={error} />}
      <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} loading={loading} emptyText="暂无发起的申请" />
    </Flex>
  );
}

// 待我审批列表（仅管理员）
function PendingTab({ isAdmin }: { isAdmin: boolean }) {
  const { message } = App.useApp();
  const [rows, setRows] = useState<ApprovalRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [review, setReview] = useState<{ target: ApprovalRequest; approve: boolean } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiGet<Paged<ApprovalRequest>>('/api/approvals/pending?pageSize=100');
      setRows(data.list);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isAdmin) load();
    else setLoading(false);
  }, [isAdmin, load]);

  if (!isAdmin) {
    return <Typography.Text type="secondary">仅管理员可进行审批操作。</Typography.Text>;
  }

  const columns: Column<ApprovalRequest>[] = [
    { key: 'title', title: '申请标题' },
    { key: 'type', title: '类型', render: (r) => <Tag color={APPROVAL_TYPE[r.type].color}>{APPROVAL_TYPE[r.type].label}</Tag> },
    { key: 'applicantName', title: '申请人' },
    { key: 'amount', title: '金额', render: (r) => (r.amount != null ? `¥${r.amount}` : '-') },
    { key: 'createdAt', title: '发起时间', render: (r) => fmtTime(r.createdAt) },
    {
      key: 'action',
      title: '操作',
      render: (r) => (
        <Flex gap={8}>
          <Button type="link" size="small" onClick={() => setReview({ target: r, approve: true })}>
            通过
          </Button>
          <Button type="link" size="small" danger onClick={() => setReview({ target: r, approve: false })}>
            驳回
          </Button>
        </Flex>
      ),
    },
  ];

  return (
    <Flex vertical gap={12}>
      {error && <Alert type="error" showIcon title={error} />}
      <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} loading={loading} emptyText="暂无待审批申请" />
      {review && (
        <ReviewModal
          target={review.target}
          approve={review.approve}
          onClose={() => setReview(null)}
          onDone={(approved) => {
            setReview(null);
            load();
            message.success(approved ? '已通过' : '已驳回');
          }}
        />
      )}
    </Flex>
  );
}

// 审批通过/驳回弹窗（带可选意见）
function ReviewModal(props: { target: ApprovalRequest; approve: boolean; onClose: () => void; onDone: (approved: boolean) => void }) {
  const { target, approve, onClose, onDone } = props;
  const [comment, setComment] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleOk = async () => {
    setSubmitting(true);
    try {
      const path = approve ? `/api/approvals/${target.id}/approve` : `/api/approvals/${target.id}/reject`;
      await apiPost(path, { comment });
      onDone(approve);
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title={approve ? '通过审批' : '驳回审批'}
      open
      onOk={handleOk}
      onCancel={onClose}
      confirmLoading={submitting}
      okText={approve ? '确认通过' : '确认驳回'}
      cancelText="取消"
      okButtonProps={{ danger: !approve }}
    >
      {error && <Alert type="error" showIcon title={error} className="mb-16" />}
      <Descriptions column={1} size="small" className="mb-16">
        <Descriptions.Item label="申请标题">{target.title}</Descriptions.Item>
        <Descriptions.Item label="申请类型">{APPROVAL_TYPE[target.type]?.label ?? target.type}</Descriptions.Item>
        {target.amount != null && <Descriptions.Item label="金额">¥{target.amount}</Descriptions.Item>}
        {Object.keys(target.detail ?? {}).length > 0 && (
          <Descriptions.Item label="详情">
            <pre className="pre-wrap">{JSON.stringify(target.detail, null, 2)}</pre>
          </Descriptions.Item>
        )}
      </Descriptions>
      <Input.TextArea
        rows={3}
        value={comment}
        placeholder={approve ? '审批意见（可选）' : '驳回理由（可选）'}
        onChange={(e) => setComment(e.target.value)}
      />
    </Modal>
  );
}

// 发起申请表单
function CreateForm({ onCreated }: { onCreated: () => void }) {
  const { message } = App.useApp();
  const [type, setType] = useState<ApprovalType>('LEAVE');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm();

  const needAmount = type === 'EXPENSE' || type === 'PURCHASE';

  const handleSubmit = async () => {
    let values: { title?: string; amount?: number; detail?: string };
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    const payload: Record<string, unknown> = { type, title: (values.title ?? '').trim() };
    if (needAmount && values.amount != null) payload.amount = values.amount;
    if (values.detail && values.detail.trim() !== '') {
      try {
        payload.detail = JSON.parse(values.detail.trim());
      } catch {
        setError('补充详情需为合法 JSON');
        return;
      }
    }
    setSubmitting(true);
    try {
      await apiPost('/api/approvals', payload);
      message.success('提交成功');
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : '提交失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Flex vertical gap={16} className="approval-form">
      {error && <Alert type="error" showIcon title={error} />}
      <Form form={form} layout="vertical" requiredMark={false}>
        <Form.Item label="审批类型">
          <Select
            value={type}
            onChange={(v) => setType(v)}
            options={[
              { value: 'LEAVE', label: '请假' },
              { value: 'EXPENSE', label: '报销' },
              { value: 'PURCHASE', label: '采购' },
            ]}
          />
        </Form.Item>
        <Form.Item name="title" label="申请标题" rules={[{ required: true, message: '请输入申请标题' }]}>
          <Input placeholder="如：请假两天" />
        </Form.Item>
        {needAmount && (
          <Form.Item name="amount" label="金额">
            <InputNumber min={0} className="w-full" placeholder="如：1500" />
          </Form.Item>
        )}
        <Form.Item name="detail" label="补充详情（JSON，可选）">
          <Input.TextArea rows={3} placeholder={'如：{"startDate":"2026-09-12","endDate":"2026-09-13"}'} />
        </Form.Item>
      </Form>
      <Flex>
        <Button type="primary" loading={submitting} onClick={handleSubmit}>
          提交申请
        </Button>
      </Flex>
    </Flex>
  );
}