import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: string }> {
  state = { error: '' };
  static getDerivedStateFromError(error: Error) { return { error: error.message }; }
  render() {
    if (this.state.error) return <main className="fatal-error"><h1>页面暂时无法显示</h1><p>模拟交易仍由后台处理。刷新页面重新读取账本。</p><pre>{this.state.error}</pre><button className="button primary" onClick={() => window.location.reload()}>重新加载</button></main>;
    return this.props.children;
  }
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><ErrorBoundary><App/></ErrorBoundary></React.StrictMode>);
