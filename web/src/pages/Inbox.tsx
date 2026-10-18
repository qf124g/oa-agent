import { CheckOutlined, ReloadOutlined } from '@ant-design/icons';
import { Alert, Badge, Button, Card, Empty, Flex, List, Space, Typography } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { formatDateTime } from '../agent-api';
import { listInbox, markInboxRead } from '../inbox-api';
import { useInbox } from '../inbox/InboxContext';
import type { InboxNotification } from '../types';

// 收件箱：助手主动推送消息列表，支持全部已读 / 单条已读
export default function Inbox() {
  const { setUnreadCount } = useInbox();
  const [items, setItems] = useState<InboxNotification[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const data = await listInbox();
      setItems(data.list);
      setUnread(data.unreadCount);
      setUnreadCount(data.unreadCount);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [setUnreadCount]);

  useEffect(() => {
    load();
  }, [load]);

  const markRead = useCallback(
    async (id?: string) => {
      try {
        await markInboxRead(id);
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : '标记失败');
      }
    },
    [load],
  );

  return (
    <Flex vertical gap={16}>
      <Typography.Title level={4} className="page-title">
        收件箱
      </Typography.Title>

      <Card>
        <Flex justify="space-between" align="center" className="mb-12">
          <Typography.Text type="secondary">共 {items.length} 条消息</Typography.Text>
          <Space>
            <Button
              icon={<ReloadOutlined />}
              onClick={() => {
                setLoading(true);
                load();
              }}
            >
              刷新
            </Button>
            <Button icon={<CheckOutlined />} disabled={unread === 0} onClick={() => markRead()}>
              全部已读
            </Button>
          </Space>
        </Flex>

        {error && <Alert type="error" showIcon title={error} className="mb-12" />}

        <List
          loading={loading}
          dataSource={items}
          locale={{ emptyText: <Empty description="暂无消息" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
          renderItem={(n) => (
            <List.Item
              actions={
                n.read
                  ? []
                  : [
                      <Button key="read" type="link" size="small" onClick={() => markRead(n.id)}>
                        标为已读
                      </Button>,
                    ]
              }
            >
              <List.Item.Meta
                avatar={<Badge dot={!n.read} />}
                title={<Typography.Text strong={!n.read}>{n.title}</Typography.Text>}
                description={
                  <Flex vertical gap={4}>
                    <span>{n.content}</span>
                    <Typography.Text type="secondary">{formatDateTime(n.createdAt)}</Typography.Text>
                  </Flex>
                }
              />
            </List.Item>
          )}
        />
      </Card>
    </Flex>
  );
}