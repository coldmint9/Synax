import { Check, Code2, FileCode2, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import type {
  MergeFile,
  MergeFileSave,
  MergeProposal,
  MergeRequest,
} from "../../../adapters/transport/gitMr";
import { Button } from "../../../shared/ui/ui/Button";
import { hasConflictMarkers } from "../../../shared/ui/file-viewer/mergeModel";
import {
  Tab,
  TabGroup,
  TabList,
  TabPanel,
  TabPanels,
} from "../../../shared/ui/ui/Tabs";

function Code({ children }: { children: string }) {
  const maxCharacters = 16_000;
  return (
    <pre className="conversation-git-code">
      <code>{children.slice(0, maxCharacters) || "（文件不存在或为空）"}</code>
      {children.length > maxCharacters && (
        <span className="conversation-git-truncated">
          已展示前 {maxCharacters.toLocaleString()}{" "}
          个字符；打开编辑器查看完整内容。
        </span>
      )}
    </pre>
  );
}

export function ConflictPreview({
  file,
  mr,
  proposals,
  blocked,
  onSave,
  onEdit,
  onApplyProposal,
  onAsk,
  appliedProposalId,
}: {
  file: MergeFile;
  mr: MergeRequest;
  proposals: MergeProposal[];
  blocked: boolean;
  onSave: (input: MergeFileSave) => void;
  onEdit: () => void;
  onApplyProposal: (proposal: MergeProposal) => void;
  onAsk: () => void;
  appliedProposalId?: string;
}) {
  const editable = !blocked && file.conflicted && mr.status === "conflicted";
  const matchingProposals = proposals
    .filter((item) => item.fileId === file.id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const latestProposal = matchingProposals[matchingProposals.length - 1];
  const proposalCurrent = latestProposal?.revision === file.revision;
  const savedProposal =
    !!latestProposal &&
    latestProposal.id === appliedProposalId &&
    latestProposal.content === file.result;
  const canConfirmResult =
    editable && file.kind === "text" && !hasConflictMarkers(file.result);
  const [selectedTab, setSelectedTab] = useState(savedProposal ? 1 : 0);
  useEffect(() => {
    if (savedProposal) setSelectedTab(1);
  }, [savedProposal]);
  const source =
    mr.steps[mr.currentStep]?.branch ??
    mr.steps[mr.steps.length - 1]?.branch ??
    "来源";
  return (
    <section
      className="conversation-git-file-preview"
      aria-label={`${file.path}方案详情`}
    >
      <div className="conversation-git-file-context">
        <span>
          目标 / 累计结果：<code>{mr.target}</code>
        </span>
        <span>
          来源：<code>{source}</code>
        </span>
      </div>
      {savedProposal && file.conflicted && (
        <p className="conversation-git-proposal-draft-note" role="status">
          建议已保存为草稿；请审阅当前结果并确认，文件尚未标记解决。
        </p>
      )}
      <TabGroup selectedIndex={selectedTab} onChange={setSelectedTab}>
        <TabList className="conversation-git-code-tabs" aria-label="代码视图">
          <Tab>对比两侧</Tab>
          <Tab>当前结果</Tab>
          {latestProposal && <Tab>助手建议</Tab>}
        </TabList>
        <TabPanels>
          <TabPanel>
            <div className="conversation-git-code-columns">
              <div>
                <strong>目标 · {mr.target}</strong>
                <Code>{file.target}</Code>
              </div>
              <div>
                <strong>来源 · {source}</strong>
                <Code>{file.source}</Code>
              </div>
            </div>
          </TabPanel>
          <TabPanel>
            <Code>{file.result}</Code>
          </TabPanel>
          {latestProposal && (
            <TabPanel>
              <div className="conversation-git-proposal-reason">
                <Sparkles size={14} />
                <p>{latestProposal.rationale}</p>
              </div>
              <Code>{latestProposal.content}</Code>
              <p className="conversation-git-proposal-status">
                {proposalCurrent
                  ? "建议基于当前文件版本；采纳只保存草稿，仍需确认解决。"
                  : "此建议依据的文件已变化，请让助手重新生成。"}
              </p>
              <Button
                size="sm"
                disabled={!editable || !proposalCurrent}
                onClick={() => onApplyProposal(latestProposal)}
              >
                <Sparkles size={13} />
                采纳建议到草稿
              </Button>
              <p className="conversation-git-proposal-draft-note">
                采纳只保存草稿；确认后才会标记文件已解决。
              </p>
            </TabPanel>
          )}
        </TabPanels>
      </TabGroup>
      {file.reason && (
        <p className="conversation-git-file-reason">{file.reason}</p>
      )}
      {editable && file.kind === "text" && !canConfirmResult && (
        <p className="conversation-git-file-reason">
          当前结果仍有冲突标记，请先编辑结果或采用完整文件。
        </p>
      )}
      <div className="conversation-git-file-actions">
        <Button size="xs" variant="ghost" onClick={onEdit}>
          <Code2 size={13} />
          {editable ? "编辑结果与逐块合并" : "展开查看"}
        </Button>
        <Button size="xs" variant="ghost" disabled={!editable} onClick={onAsk}>
          <Sparkles size={13} />
          {latestProposal ? "让助手调整" : "生成解决建议"}
        </Button>
        <Button
          size="xs"
          variant="secondary"
          disabled={!canConfirmResult}
          onClick={() =>
            onSave({
              expectedRevision: file.revision,
              content: file.result,
              resolve: true,
            })
          }
        >
          <Check size={12} />
          确认此结果
        </Button>
        {editable && (
          <div className="conversation-git-whole-file">
            <Button
              size="xs"
              disabled={!file.targetExists}
              onClick={() =>
                onSave({
                  expectedRevision: file.revision,
                  choice: "target",
                  resolve: true,
                })
              }
            >
              <FileCode2 size={12} />
              采用目标全文
            </Button>
            <Button
              size="xs"
              disabled={!file.sourceExists}
              onClick={() =>
                onSave({
                  expectedRevision: file.revision,
                  choice: "source",
                  resolve: true,
                })
              }
            >
              <FileCode2 size={12} />
              采用来源全文
            </Button>
          </div>
        )}
        {!file.conflicted && (
          <span className="conversation-git-resolved">
            <Check size={12} />
            此文件已解决
          </span>
        )}
      </div>
    </section>
  );
}
