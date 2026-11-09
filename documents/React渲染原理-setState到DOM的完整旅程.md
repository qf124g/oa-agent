# React 渲染原理：从 setState 到 DOM 渲染的完整旅程

> 配套《面试题-高级前端（UIUX-Electron-AI智能体）·参考答案版》Q1/Q3 的底层原理补充。
> 本文用通俗比喻 + 机制拆解讲清三件事：setState 的完整流程、Hooks 的底层工作原理、Fiber 双树 diff 如何保留 DOM 只增量更新。

---

## 一、全流程总览：一次「装修」的五个阶段

**核心比喻**：`setState` 不是「立刻改页面」，而是提交一张「变更申请单」——

| 阶段 | 比喻 | 干什么 | 是否碰真实 DOM | 可否中断 |
|------|------|--------|---------------|---------|
| ① setState | 提交变更申请单 | 把更新对象挂进 Fiber 上对应 Hook 的更新队列 | 否 | — |
| ② 调度 | 物业排期 | 标记优先级、批量合并多次更新，安排渲染 | 否 | — |
| ③ render | 设计师画新图纸、列变更清单 | 组件函数重跑、Hooks 取数、产出新元素树并与旧树 diff | **否（纯内存）** | **可中断** |
| ④ commit | 工人按清单进场施工 | 按变更清单一次性执行 DOM 增删改 | **是（唯一时刻）** | **不可中断** |
| ⑤ 绘制 | 刷漆上屏 | 浏览器 paint；useEffect 在此之后异步执行 | 浏览器负责 | — |

一句话主线：

```
setState（登记更新）→ 调度（批量+优先级）→ render（内存画新图纸、diff 出变更清单）
→ commit（照单施工到 DOM，原子完成）→ 浏览器绘制（useEffect 异步执行）
```

**两个关键设计动机**：

- render 只动内存里的 workInProgress 树，所以**可中断**——扔了重来屏幕也无感知；
- commit 动真实 DOM，做一半用户会看到「半渲染」的撕裂界面——所以**必须原子完成**。

---

## 二、Hooks 的底层原理：挂在 Fiber 上的链表

### 2.1 问题：组件函数每次渲染都从头重跑，state 凭什么不丢？

答案：**Hooks 的数据根本不在函数里**，它挂在组件对应的 Fiber 节点上，是一条**链表**。

每个 Fiber 节点有个 `memoizedState` 字段，指向该组件的 Hook 链表：

```
Fiber 节点（组件在内存中的档案）
  └─ memoizedState → Hook① → Hook② → Hook③ → null
                      │         │         │
                      state: 0  deps:[n]  缓存值 v
                      更新队列   effect fn  deps 比对
```

源码中的每次 Hook 调用，按**调用顺序**一一对应链表节点：

```tsx
function Counter() {
  const [n, setN] = useState(0);     // ① → 链表第 1 个节点：state + 更新队列
  useEffect(fn, [n]);                // ② → 链表第 2 个节点：deps + effect 函数
  const v = useMemo(calc, [n]);      // ③ → 链表第 3 个节点：缓存值 + deps
}
```

### 2.2 渲染时 Hooks 各自干什么

- **useState**：按顺序找到 Hook① → 消费更新队列（可能攒了多个更新，依次计算）→ 返回最新 state；
- **useEffect**：对比新旧 deps 数组 → 变了则把 effect 函数登记为「待执行」（commit 后异步跑）；
- **useMemo**：对比 deps → 没变直接返回链表里的缓存值。**记忆化的本质不是「不渲染」，而是「重渲染时跳过重算」**。

### 2.3 为什么 Hooks 不能写在 if / 循环里

比喻：**更衣柜**——你每次来（每次渲染）都按同样顺序开 1 号、2 号、3 号柜；哪天把 2 号柜写进 `if` 跳过了，后面所有人取的东西全错位。

React 靠**调用序号**而不是变量名来对齐 Hook 和数据。条件调用会让序号错位，取到别的 Hook 的数据——**这不是语法限制，是数据结构限制**。

---

## 三、Fiber 双树 diff：如何保留已有 DOM 只追加新行

### 3.1 双缓冲结构

内存里始终有**两棵树**：

- `current` 树：屏幕上正在显示的那棵；
- `workInProgress`（wip）树：render 阶段在后台新搭的那棵。

比喻：**画展换展**——旧展照常开放，新展在隔壁仓库搭；搭好后两馆对照列出施工单「这幅不动、那幅换标签、门口加一幅」；开幕日按单施工，游客只看到变化的三幅，整馆从不推倒重来。

每个 Fiber 节点的 `stateNode` 字段**直接持有真实 DOM 节点的引用**——Fiber 不销毁，DOM 就不动，这是「保留 DOM」的物理基础。

### 3.2 diff 的核心规则

逐位置对比「旧 Fiber」和「新元素」，规则只有一条：**type 相同 → 复用；type 不同 → 销毁重建**。

- 复用：连带复用 stateNode 指向的真实 DOM，只检查 props 是否变化，没变则零 DOM 操作；
- 子元素列表：无 key 按 index 一一配对；有 key 按 key 建哈希表匹配（允许乱序复用）。

diff 的产出是**变更清单（effect list）**：`Update`（改属性/文本）、`Placement`（插入新节点）、`Deletion`（删除节点）。**没变的部分在清单里根本不出现**。

### 3.3 流式表格实例（逐行填充的精确过程）

帧 N 表格有 2 行，帧 N+1 多出第 3 行、且第 2 行某单元格文本变化：

```
新元素树                     旧 Fiber 树              判定
<table>                      <table> fiber           type 同 → 复用 DOM
 ├ <thead>                    ├ <thead> fiber         复用，零操作
 └ <tbody>                    └ <tbody> fiber         复用
    ├ <tr>行1                    ├ <tr> fiber          index 0 配对，内容同 → 零操作
    ├ <tr>行2'                   ├ <tr> fiber(行2)     index 1 配对 → 复用 <tr>
    │                                                   └ 文本不同 → 打 Update 标记
    └ <tr>行3  ← 新增                                     无配对 → 打 Placement 标记
```

整棵树 diff 完，变更清单只有两条：

1. `Update`：第 2 行 `<td>` 的 textContent 改掉；
2. `Placement`：新建一个 `<tr>` DOM，appendChild 到 `<tbody>`。

commit 阶段只执行这两条——`<table>`、`<thead>`、第 1 行、其余单元格的 DOM **一个都没碰**。这就是「只追加新行」的精确含义。

### 3.4 为什么视觉上不闪

- 已有节点是**同一个 DOM 对象**，浏览器不需要移除再插入，不会闪；
- 唯一结构变更是 append 一行，只有新行区域触发重绘；
- 对比反例：`element.innerHTML = fullText` 每帧销毁整个表格再整体重建——全量重排、闪烁、滚动位置丢失。React 的 reconcile 正是为了消灭这种写法。

### 3.5 无 key 为什么也能正常工作

流式追加场景下 index 配对就是最优匹配。但若**中途插入**一行，index 配对会把插入点之后所有行判定为「内容变化的复用」——DOM 节点仍复用（不重建），只是逐个 Update 文本，功能正确但指令偏多。动态列表要 key 的意义：按「身份」而非「位置」匹配，把 O(n) 个 Update 优化成一次移动。

---

## 四、完整时间线（把三张图串起来）

```
setState({n: n+1})
   │
   │  ① 更新对象挂进该组件 Fiber 上对应 Hook 的「更新队列」
   │     （不是立刻算 n+1，只是登记：有人要改）
   ▼
② 调度器：标记优先级，安排一次渲染
   │     同一事件里的多个 setState 在这里被合并（批处理）——
   │     这就是"连续 setState 三次只渲染一次"的原因
   ▼
③ render 阶段（纯内存，可中断）
   │  a. 组件函数从头重跑
   │  b. 跑到 useState → 按顺序找到 Hook① → 消费更新队列 → 算出 n=1 返回
   │  c. 跑到 useEffect → 对比 deps [n]：变了 → 登记 effect 为"待执行"
   │  d. 跑到 useMemo → deps 没变 → 直接返回链表缓存值
   │  e. JSX 返回新元素树 → 与 current 树逐位置 diff（type 同则复用 Fiber 和 DOM）
   │  f. 差异打标记（Update/Placement/Deletion），攒成变更清单
   │     —— 期间有更高优先级更新进来，这棵树可以扔掉重来，屏幕毫无感知
   ▼
④ commit 阶段（动真 DOM，不可中断，一鼓作气）
   │  a. beforeMutation：getSnapshotBeforeUpdate
   │  b. mutation：按清单执行 DOM 增删改（唯一碰真实 DOM 的时刻）
   │  c. layout：同步执行 useLayoutEffect + ref 挂载
   │  d. workInProgress 树转正为 current（指针切换，双缓冲交换）
   ▼
⑤ 浏览器绘制 + useEffect 异步执行
        commit 结束后、paint 之后才跑登记的 useEffect
        —— effect 里读到的 DOM 已是最新，且不阻塞绘制
```

---

## 五、三个最容易被追问的底层点

1. **为什么 Hooks 不能放条件里**：state 存在 Fiber 的 Hook 链表上，不靠变量名靠调用序号对齐。条件调用让序号错位，React 取到别的 Hook 的数据——数据结构限制，不是语法限制。
2. **为什么 setState 是异步批量的**：它只登记更新 + 触发调度，渲染由调度器统一安排，同批多次 setState 合并成一次 render——性能设计，不是缺陷；所以要用函数式更新 `setN(n => n+1)` 从队列取最新值。
3. **为什么 commit 不可中断而 render 可以**：render 只动内存 wip 树，扔了屏幕无感知；commit 动真实 DOM，做一半会出现撕裂界面，必须原子完成。

---

## 六、面试浓缩版（60 秒口述）

> 「setState 只是往 Fiber 的 Hook 更新队列里登记一个更新，然后触发调度；调度器批量处理后进入 render 阶段——组件函数重跑，Hooks 按调用顺序从 Fiber 的 memoizedState 链表上取数、算新 state，产出新元素树并与 current 树 diff 出变更清单，这阶段纯内存可中断；commit 阶段按清单一次性改真实 DOM，跑 layout effects，然后 wip 树转正；浏览器绘制后再异步跑 useEffect。Hooks 的本质就是挂在 Fiber 上、按调用序号对齐的链表节点——这同时解释了状态为什么不丢、为什么不能条件调用、以及 useMemo 的缓存存在哪。」

---

## 附：三组比喻速查

| 概念 | 比喻 |
|------|------|
| 全流程 | 装修：申请单 → 物业排期 → 画图纸列清单 → 工人施工 → 刷漆 |
| Hooks 链表 | 更衣柜：每次按同样顺序开柜取物，跳号全错位 |
| Fiber 双树 | 画展换展：旧展开放、新展后台搭、按施工单换三幅 |
