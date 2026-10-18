# SVG 审批工作流画布 — 实现方案

## 一、背景与目标

OA 演示项目当前审批是「单步」模型（申请人 → 一个审批人），没有流程定义概念。本次新增一个**自研 SVG 的审批流程设计器**：用纯 SVG + React 手绘节点/连线画布（不引入 React Flow / X6 等图形库），支持拖拽节点、拖拽连线、画布平移与缩放，并把流程定义持久化到 backend 落盘 store。

**本期范围**：流程定义的 CRUD + 可视化设计器 + 后端落库。运行期「审批按流程多级流转/条件路由」的引擎不在本期实现（后续可在此数据结构上扩展）。

## 二、数据模型（backend）

复用 `backend/src/types.ts` 与 `backend/src/store.ts` 的 `PersistentMap` 落盘机制（与 todo/approval 一致）。

新增类型（`backend/src/types.ts`）：

```ts
export type WorkflowNodeType = 'START' | 'APPROVAL' | 'CONDITION' | 'END';

export interface WorkflowNode {
  id: string;
  type: WorkflowNodeType;
  title: string;                    // 节点显示名
  x: number;                        // 画布世界坐标
  y: number;
  config?: Record<string, unknown>; // 预留（审批人/条件表达式，本期可空）
}

export interface WorkflowEdge {
  id: string;
  from: string;                     // 源节点 id
  to: string;                       // 目标节点 id
  label?: string;                   // 分支标签（条件分支用）
}

export interface WorkflowDefinition {
  id: string;
  name: string;                     // 流程名称
  approvalType: ApprovalType | null;// 关联审批类型（LEAVE/EXPENSE/PURCHASE），可空
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  createdBy: string;
  createdByName: string;
  createdAt: number;
  updatedAt: number;
}
```

`store.ts` 变更（与现有实体完全同构，仅列差异点）：
- 新增 `workflows = new PersistentMap<string, WorkflowDefinition>()`
- `SnapshotData` / `persist()` / `load()` / `arm()` / `maxExistingNumber()` 增加 `workflows` 字段
- `initSeedData()` 写入一条默认「请假审批流程」（START → APPROVAL → CONDITION → APPROVAL → END 的示例节点坐标与连线），避免画布首屏为空

## 三、后端接口（`backend/src/index.ts`）

沿用现有 `ok/fail` 信封与 `authMiddleware`；写操作走 `requireRole('ADMIN')`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/workflows` | 流程列表（登录可见），按 `updatedAt` 倒序 |
| GET | `/api/workflows/:id` | 流程详情（含 nodes/edges） |
| POST | `/api/workflows` | 新建流程（管理员），body: `{ name, approvalType, nodes, edges }` |
| PATCH | `/api/workflows/:id` | 保存流程（管理员），更新 name/approvalType/nodes/edges |
| DELETE | `/api/workflows/:id` | 删除流程（管理员） |

校验：`name` 非空；`nodes`/`edges` 为数组；`id` 用 `store.nextId('W')`。

## 四、前端

### 4.1 类型与文案
- `web/src/types.ts`：新增 `WorkflowNodeType/WorkflowNode/WorkflowEdge/WorkflowDefinition`
- `web/src/constants.ts`：新增 `WORKFLOW_NODE_TYPE`（label + antd 色值 + 形状标识）映射

### 4.2 自研 SVG 画布（核心）
新增 `web/src/components/WorkflowCanvas.tsx`，受控组件：

```ts
interface WorkflowCanvasProps {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  onChange: (nodes: WorkflowNode[], edges: WorkflowEdge[]) => void;
  onSelect: (sel: { kind: 'node' | 'edge'; id: string } | null) => void;
}
```

实现要点：
- **视口**：内部 state `viewport = { x, y, zoom }`；`<svg>` 内用 `<g transform="translate(x,y) scale(zoom)">` 包裹世界内容；`defs` 定义箭头 `marker`
- **坐标换算**：节点 x/y 存「世界坐标」，鼠标屏幕增量需 `÷ zoom` 换算成世界增量
- **渲染节点**：圆角矩形 + 图标/标题，按 `type` 套 CSS 类（`wf-node`、`wf-node-start/approval/condition/end`），几何属性用 SVG 属性（x/y/width/height/fill 仅通过 CSS 类，不用内联 style）
- **渲染连线**：每个 edge 取两端锚点，画三次贝塞尔 `<path>` + `marker-end` 箭头；条件分支的 label 用 `<text>` 显示
- **交互（用 Pointer 事件 + `setPointerCapture`，兼容鼠标/触控）**：
  - 拖拽节点：在节点上按下拖动 → 更新该节点 x/y → `onChange`
  - 拖拽连线：从节点**输出端口**（右侧小圆）按下，拖到目标节点**输入端口**（左侧小圆）松开 → 新增 edge；拖拽过程画橡皮筋虚线
  - 平移画布：在空白背景按下拖动 → 更新 viewport.x/y
  - 缩放：滚轮 `onWheel`（以光标为中心缩放，夹在 0.4~1.6）
  - 选择/删除：单击选中节点或连线（高亮描边），按 `Delete`/`Backspace` 删除选中项；选中态通过 `onSelect` 上抛

### 4.3 页面
- 新增 `web/src/pages/Workflow.tsx`：流程列表页，复用 `DataTable`；管理员可「新建流程」（Modal 填名称+审批类型，创建后跳转设计器）、「删除」、「编辑」
- 新增 `web/src/pages/WorkflowDesigner.tsx`：设计器页
  - 左侧**节点面板**（点击「开始/审批/条件/结束」在画布中心附近新增节点）
  - 顶部工具栏：返回、流程名（可改名）、保存（`PATCH /api/workflows/:id`）、删除选中、缩放重置
  - 中央 `<WorkflowCanvas>`，持有 nodes/edges state，`onChange` 更新本地，`onSelect` 驱动工具按钮可用态
  - 双击节点重命名（轻量：参考 Approval 页改内联输入，或点击工具栏「重命名」）

### 4.4 接入
- `web/src/App.tsx`：新增路由 `/workflow`、`/workflow/:id`
- `web/src/components/Layout.tsx`：侧边菜单新增「流程设计」项（图标 `PartitionOutlined`）
- `web/src/styles/global.css`：新增画布相关类（节点/连线/端口/选中态/面板），遵循「React 组件不用内联样式」约定

## 五、复用的现有设施
- 后端落盘：`backend/src/store.ts` 的 `PersistentMap` + `nextId` + seed 快照
- 信封与鉴权：`backend/src/common.ts` 的 `ok/fail`、`backend/src/index.ts` 的 `authMiddleware/requireRole`
- 前端请求：`web/src/api.ts` 的 `apiGet/apiPost/apiPatch/apiDelete`（流程接口走 backend 同源）
- 列表页：`web/src/components/DataTable.tsx`（与 Tasks/Approval 一致）
- 通用类：`global.css` 的 `page-title/mb-12/w-*` 等

## 六、验证方式
1. `nvm use 20 && npm run dev` 启动三服务
2. 登录 admin/123456 → 侧边「流程设计」→ 列表应显示种子「请假审批流程」
3. 进入设计器：拖拽移动节点、从输出端口拖到输入端口新增连线、Delete 删除、滚轮缩放/拖拽平移
4. 保存后刷新页面，改动仍存在（落盘验证：`backend/data/store.json` 出现 `workflows` 段）
5. 新建一条流程（选审批类型）→ 添加节点连线 → 保存 → 列表中可见
6. 非管理员（如 zhangwei）只能查看，不能新建/保存/删除
7. `npx tsc --noEmit`（web + backend）通过