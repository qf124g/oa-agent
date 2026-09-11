import { Column as PlotColumn } from '@ant-design/plots';
import { Card, Col, Flex, Row, Tag, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { apiGet } from '../api';
import type { ApprovalRequest, DashboardStats, TodoTask } from '../types';
import { APPROVAL_STATUS, APPROVAL_TYPE, TODO_PRIORITY, TODO_STATUS } from '../constants';
import StatCard from '../components/StatCard';
import DataTable, { type Column } from '../components/DataTable';

// 工作台：统计卡片 + AntV 数据概览 + 我的待办速览 + 我的审批速览
export default function Dashboard() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    apiGet<DashboardStats>('/api/dashboard/stats')
      .then(setStats)
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const todoColumns: Column<TodoTask>[] = [
    { key: 'title', title: '待办' },
    { key: 'priority', title: '优先级', render: (r) => <Tag color={TODO_PRIORITY[r.priority].color}>{TODO_PRIORITY[r.priority].label}</Tag> },
    { key: 'status', title: '状态', render: (r) => <Tag color={TODO_STATUS[r.status].color}>{TODO_STATUS[r.status].label}</Tag> },
    { key: 'dueDate', title: '截止日期', render: (r) => r.dueDate || '-' },
  ];

  const approvalColumns: Column<ApprovalRequest>[] = [
    { key: 'title', title: '申请' },
    { key: 'type', title: '类型', render: (r) => <Tag color={APPROVAL_TYPE[r.type].color}>{APPROVAL_TYPE[r.type].label}</Tag> },
    { key: 'status', title: '状态', render: (r) => <Tag color={APPROVAL_STATUS[r.status].color}>{APPROVAL_STATUS[r.status].label}</Tag> },
  ];

  const chartData = [
    { name: '我的待办', value: stats?.todoCount ?? 0 },
    { name: '待我审批', value: stats?.pendingApprovalCount ?? 0 },
    { name: '公告', value: stats?.announcementCount ?? 0 },
    { name: '员工', value: stats?.employeeCount ?? 0 },
    { name: '部门', value: stats?.departmentCount ?? 0 },
    { name: '知识库文档', value: stats?.knowledgeCount ?? 0 },
  ];

  return (
    <Flex vertical gap={16}>
      <Typography.Title level={4} style={{ margin: 0 }}>
        工作台
      </Typography.Title>

      {error && (
        <Card>
          <Typography.Text type="danger">数据加载失败：{error}</Typography.Text>
        </Card>
      )}

      <Row gutter={[16, 16]}>
        <Col xs={12} sm={8} lg={4}>
          <StatCard label="我的待办" value={stats?.todoCount ?? '-'} suffix="项" />
        </Col>
        <Col xs={12} sm={8} lg={4}>
          <StatCard label="待我审批" value={stats?.pendingApprovalCount ?? '-'} suffix="项" />
        </Col>
        <Col xs={12} sm={8} lg={4}>
          <StatCard label="公告" value={stats?.announcementCount ?? '-'} suffix="条" />
        </Col>
        <Col xs={12} sm={8} lg={4}>
          <StatCard label="员工" value={stats?.employeeCount ?? '-'} suffix="人" />
        </Col>
        <Col xs={12} sm={8} lg={4}>
          <StatCard label="部门" value={stats?.departmentCount ?? '-'} suffix="个" />
        </Col>
        <Col xs={12} sm={8} lg={4}>
          <StatCard label="知识库文档" value={stats?.knowledgeCount ?? '-'} suffix="篇" />
        </Col>
      </Row>

      <Card title="数据概览" loading={loading}>
        <PlotColumn
          data={chartData}
          xField="name"
          yField="value"
          height={280}
          style={{ fill: '#1677ff', radiusTopLeft: 6, radiusTopRight: 6 }}
        />
      </Card>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Card title="我的待办速览" loading={loading}>
            <DataTable columns={todoColumns} rows={stats?.myTodos ?? []} rowKey={(r) => r.id} />
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card title="我的审批速览" loading={loading}>
            <DataTable columns={approvalColumns} rows={stats?.myApprovals ?? []} rowKey={(r) => r.id} />
          </Card>
        </Col>
      </Row>
    </Flex>
  );
}