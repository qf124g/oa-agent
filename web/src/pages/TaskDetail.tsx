import { ArrowLeftOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Flex, Tag, Timeline, Typography } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { formatDateTime, getTask } from '../task-api';
import type { AgentTask, TaskStep } from '../types';
import { TASK_STATUS } from '../constants';

// 时间线节点颜色：按步骤类型区分
const STEP_COLOR: Record<TaskStep['kind'], string> = {
  log: 'gray',
  tool: 'blue',
  result: 'green',
  confirm: 'orange',
  error: 'red',
};

// 任务详情：执行时间线 + 最终结果，运行中/待确认任务自动轮询刷新
export default function TaskDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [task, setTask] = useState<AgentTask | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const data = await getTask(id);
      setTask(data);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const active = task !== null && (task.status === 'RUNNING' || task.status === 'WAITING_CONFIRM');
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(load, 2000);
    return () => window.clearInterval(timer);
  }, [active, load]);

  return (
    <Flex vertical gap={16}>
      <Flex align="center" gap={12}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/tasks')}>
          返回
        </Button>
        <Typography.Title level={4} className="page-title">
          任务详情
        </Typography.Title>
      </Flex>

      {error && <Alert type="error" showIcon title={error} />}
      {loading && !task && <Card loading />}

      {task && (
        <>
          <Card title={task.title} extra={<Tag color={TASK_STATUS[task.status].color}>{TASK_STATUS[task.status].label}</Tag>}>
            <Flex vertical gap={8}>
              <Typography.Text type="secondary">发起时间：{formatDateTime(task.createdAt)}</Typography.Text>
              <Flex gap={4} wrap>
                {task.toolNames.map((n) => (
                  <Tag key={n}>{n}</Tag>
                ))}
              </Flex>
            </Flex>
          </Card>

          <Card title="执行过程">
            <Timeline>
              {task.steps.map((s) => (
                <Timeline.Item key={s.id} color={STEP_COLOR[s.kind]}>
                  <Typography.Text strong>{s.title}</Typography.Text>
                  {s.detail && (
                    <div>
                      <Typography.Text type="secondary">{s.detail}</Typography.Text>
                    </div>
                  )}
                </Timeline.Item>
              ))}
            </Timeline>
          </Card>

          {task.result && (
            <Card title="最终结果">
              <div className="pre-wrap">{task.result}</div>
            </Card>
          )}
        </>
      )}
    </Flex>
  );
}