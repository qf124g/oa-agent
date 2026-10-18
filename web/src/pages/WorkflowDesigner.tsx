import { Alert, App, Button, Card, Flex, Input, Space, Spin, Tag, Typography } from 'antd';
import { ArrowLeftOutlined, DeleteOutlined, SaveOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { apiGet, apiPatch } from '../api';
import type { WorkflowDefinition, WorkflowEdge, WorkflowNode, WorkflowNodeType } from '../types';
import { APPROVAL_TYPE, WORKFLOW_NODE_TYPE } from '../constants';
import { useAuth } from '../auth/AuthContext';
import WorkflowCanvas, { type WorkflowSelection } from '../components/WorkflowCanvas';

const NODE_TYPES: WorkflowNodeType[] = ['START', 'APPROVAL', 'CONDITION', 'END'];

// 生成新节点：置于画布中部附近，按已有节点数错位避免重叠
function makeNode(type: WorkflowNodeType, index: number): WorkflowNode {
  return {
    id: crypto.randomUUID(),
    type,
    title: `${WORKFLOW_NODE_TYPE[type].label}节点`,
    x: 240 + (index % 4) * 180,
    y: 120 + (index % 4) * 140,
  };
}

// 流程设计器：左侧节点面板 + 中央自研 SVG 画布，管理员可编辑保存
export default function WorkflowDesigner() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { message } = App.useApp();
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';

  const [wf, setWf] = useState<WorkflowDefinition | null>(null);
  const [name, setName] = useState('');
  const [nodes, setNodes] = useState<WorkflowNode[]>([]);
  const [edges, setEdges] = useState<WorkflowEdge[]>([]);
  const [selected, setSelected] = useState<WorkflowSelection>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    try {
      const data = await apiGet<WorkflowDefinition>(`/api/workflows/${id}`);
      setWf(data);
      setName(data.name);
      setNodes(data.nodes);
      setEdges(data.edges);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载流程失败');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const selectedNode = useMemo(
    () => (selected?.kind === 'node' ? nodes.find((n) => n.id === selected.id) ?? null : null),
    [selected, nodes],
  );

  const addNode = (type: WorkflowNodeType) => {
    const node = makeNode(type, nodes.length);
    setNodes((prev) => [...prev, node]);
    setSelected({ kind: 'node', id: node.id });
  };

  const updateNodeTitle = (title: string) => {
    if (selected?.kind !== 'node') return;
    setNodes((prev) => prev.map((n) => (n.id === selected.id ? { ...n, title } : n)));
  };

  const deleteSelected = useCallback(() => {
    if (!selected) return;
    if (selected.kind === 'node') {
      setNodes((prev) => prev.filter((n) => n.id !== selected.id));
      setEdges((prev) => prev.filter((e) => e.from !== selected.id && e.to !== selected.id));
    } else {
      setEdges((prev) => prev.filter((e) => e.id !== selected.id));
    }
    setSelected(null);
  }, [selected]);

  // 键盘删除选中项（输入框中输入时不响应）
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const tag = (ev.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (ev.key === 'Delete' || ev.key === 'Backspace') {
        ev.preventDefault();
        deleteSelected();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [deleteSelected]);

  const save = async () => {
    if (!id) return;
    if (!name.trim()) {
      message.warning('流程名称不能为空');
      return;
    }
    setSaving(true);
    try {
      await apiPatch(`/api/workflows/${id}`, { name: name.trim(), nodes, edges });
      message.success('已保存');
      setWf((prev) => (prev ? { ...prev, name: name.trim(), nodes, edges } : prev));
    } catch (err) {
      message.error(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <Flex align="center" justify="center" className="wf-loading">
        <Spin />
      </Flex>
    );
  }

  if (error || !wf) {
    return <Alert type="error" showIcon title={error || '流程不存在'} />;
  }

  return (
    <Flex vertical gap={16}>
      <Flex align="center" justify="space-between">
        <Space size={12}>
          <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/workflow')}>
            返回
          </Button>
          <Input value={name} onChange={(e) => setName(e.target.value)} readOnly={!isAdmin} className="wf-name-input" />
          {wf.approvalType && <Tag color={APPROVAL_TYPE[wf.approvalType]?.color}>{APPROVAL_TYPE[wf.approvalType]?.label}</Tag>}
        </Space>
        {isAdmin && (
          <Space size={12}>
            <Button danger icon={<DeleteOutlined />} disabled={!selected} onClick={deleteSelected}>
              删除选中
            </Button>
            <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={save}>
              保存
            </Button>
          </Space>
        )}
      </Flex>

      <Flex gap={16} className="wf-main">
        <Card title="节点面板" className="wf-panel">
          <Flex vertical gap={8}>
            {NODE_TYPES.map((t) => (
              <Button key={t} block disabled={!isAdmin} onClick={() => addNode(t)}>
                {WORKFLOW_NODE_TYPE[t].label}节点
              </Button>
            ))}
          </Flex>
          {selectedNode && (
            <Flex vertical gap={8} className="mt-16">
              <Typography.Text type="secondary">选中节点标题</Typography.Text>
              <Input value={selectedNode.title} onChange={(e) => updateNodeTitle(e.target.value)} readOnly={!isAdmin} />
            </Flex>
          )}
        </Card>
        <Card className="wf-canvas-card">
          <WorkflowCanvas
            nodes={nodes}
            edges={edges}
            selected={selected}
            onSelect={setSelected}
            onChange={(ns, es) => {
              setNodes(ns);
              setEdges(es);
            }}
          />
        </Card>
      </Flex>
    </Flex>
  );
}