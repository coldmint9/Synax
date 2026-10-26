import { History } from 'lucide-react';
import './conversationGit.css';

export function ExpiredMergeTask({ title }: { title: string }) {
  return (
    <div className="conversation-git-expired" role="note" aria-label="已过期的合并任务卡片">
      <History size={18} aria-hidden="true" />
      <div>
        <strong>{title}</strong>
        <span>已过期 · 此任务已恢复，请在最新时间线查看进度和操作。</span>
      </div>
    </div>
  );
}
