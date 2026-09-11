import { Card, Statistic } from 'antd';

// 工作台统计卡片
export default function StatCard(props: { label: string; value: number | string; suffix?: string }) {
  const { label, value, suffix } = props;
  return (
    <Card size="small">
      <Statistic title={label} value={value} suffix={suffix} styles={{ value: { color: '#1677ff' } }} />
    </Card>
  );
}