import { Navigate, Route, Routes } from 'react-router-dom';
import Layout from './components/Layout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Todo from './pages/Todo';
import Approval from './pages/Approval';
import Announcement from './pages/Announcement';
import Directory from './pages/Directory';
import Knowledge from './pages/Knowledge';

// 路由表：/login 公开，其余页面在 Layout（含登录守卫）内
export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<Layout />}>
        <Route index element={<Dashboard />} />
        <Route path="todo" element={<Todo />} />
        <Route path="approval" element={<Approval />} />
        <Route path="announcement" element={<Announcement />} />
        <Route path="directory" element={<Directory />} />
        <Route path="knowledge" element={<Knowledge />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}