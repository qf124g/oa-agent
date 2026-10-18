import { ReloadOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Flex, Select, Tag, Typography } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatDateTime, listTasks } from '../task-api';
import type { AgentTaskSummary } from '../types';
import { TASK_STATUS } from '../constants';
import DataTable, { type Column } from '../components/DataTable';

// 任务中心：Agent 异步任务列表，执行中/待确认任务自动轮询同步状态
export default function Tasks() {
  const navigate = useNavigate();
  const [tasks, setTasks] = useState<AgentTaskSummary[]>([]);
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const data = await listTasks(status || undefined);
      setTasks(data.list);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    load();
  }, [load]);

  // 存在执行中/待确认任务时开启轮询，实时同步任务状态
  const hasActive = tasks.some((t) => t.status === 'RUNNING' || t.status === 'WAITING_CONFIRM');
  useEffect(() => {
    if (!hasActive) return;
    const timer = window.setInterval(load, 2000);
    return () => window.clearInterval(timer);
  }, [hasActive, load]);

  const columns: Column<AgentTaskSummary>[] = [
    { key: 'title', title: '任务意图' },
    { key: 'status', title: '状态', render: (r) => <Tag color={TASK_STATUS[r.status].color}>{TASK_STATUS[r.status].label}</Tag> },
    {
      key: 'tools',
      title: '涉及操作',
      render: (r) =>
        r.toolNames.length ? (
          <Flex gap={4} wrap>
            {r.toolNames.map((n) => (
              <Tag key={n}>{n}</Tag>
            ))}
          </Flex>
        ) : (
          <Typography.Text type="secondary">—</Typography.Text>
        ),
    },
    { key: 'stepCount', title: '执行步骤', render: (r) => `${r.stepCount} 步` },
    { key: 'createdAt', title: '发起时间', render: (r) => formatDateTime(r.createdAt) },
    {
      key: 'action',
      title: '操作',
      render: (r) => (
        <Button type="link" size="small" onClick={() => navigate(`/tasks/${r.id}`)}>
          查看详情
        </Button>
      ),
    },
  ];

  return (
    <Flex vertical gap={16}>
      <Typography.Title level={4} className="page-title">
        任务中心
      </Typography.Title>

      <Card>
        <Flex wrap gap={12} className="mb-12">
          <Select
            value={status || undefined}
            placeholder="全部状态"
            allowClear
            className="w-140"
            onChange={(v) => setStatus(v ?? '')}
            options={[
              { value: 'RUNNING', label: '执行中' },
              { value: 'WAITING_CONFIRM', label: '待确认' },
              { value: 'DONE', label: '已完成' },
              { value: 'FAILED', label: '失败' },
              { value: 'INTERRUPTED', label: '已中断' },
            ]}
          />
          <Button
            icon={<ReloadOutlined />}
            onClick={() => {
              setLoading(true);
              load();
            }}
          >
            刷新
          </Button>
        </Flex>
        {error && <Alert type="error" showIcon title={error} className="mb-12" />}
        <DataTable columns={columns} rows={tasks} rowKey={(r) => r.id} loading={loading} emptyText="暂无任务，试着对悬浮助手说句话" />
      </Card>
    </Flex>
  );
}