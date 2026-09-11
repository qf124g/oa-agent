import { Table } from 'antd';
import type { TableProps } from 'antd';
import type { ReactNode } from 'react';

// 轻量表格通用组件：基于 antd Table，保持列配置化用法
export interface Column<T> {
  key: string;
  title: string;
  render?: (row: T) => ReactNode;
}

export default function DataTable<T extends object>(props: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  loading?: boolean;
  emptyText?: string;
}) {
  const { columns, rows, rowKey, loading, emptyText = '暂无数据' } = props;

  const antdColumns: TableProps<T>['columns'] = columns.map((c) => ({
    key: c.key,
    title: c.title,
    dataIndex: c.key,
    render: (_: unknown, record: T) => {
      if (c.render) return c.render(record);
      const v = (record as Record<string, unknown>)[c.key];
      return v === undefined || v === null || v === '' ? '-' : String(v);
    },
  }));

  return (
    <Table<T>
      columns={antdColumns}
      dataSource={rows}
      rowKey={rowKey}
      loading={loading}
      pagination={false}
      size="middle"
      locale={{ emptyText }}
      scroll={{ x: 'max-content' }}
    />
  );
}