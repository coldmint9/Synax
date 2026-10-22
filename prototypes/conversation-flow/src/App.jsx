import { useEffect, useReducer, useRef, useState } from "react";
import {
  ArrowUp,
  ArrowUpRight,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Code2,
  FileCode2,
  Folder,
  GitBranch,
  GitMerge,
  GitPullRequest,
  History,
  LoaderCircle,
  Maximize2,
  MessageSquare,
  Minimize2,
  Moon,
  PanelLeft,
  Plus,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Sparkles,
  Sun,
  Terminal,
  TestTube2,
  X,
} from "lucide-react";
import { files, flowReducer, initialState } from "./flow-model.js";
import GitGraph from "./GitGraph.jsx";

const stepLabels = ["分析变更", "解决冲突", "验证结果", "完成合并"];
const titles = {
  scanning: "正在分析",
  conflict: "等待你的决定",
  testing: "正在验证",
  failed: "测试未通过",
  ready: "可以合并",
  merging: "正在合并",
  merged: "已合并",
  stale: "主分支已更新",
};
const choiceLabels = {
  local: "保留当前 feature",
  incoming: "采用 main",
  combined: "智能组合",
};
const stageStep = {
  scanning: 0,
  conflict: 1,
  testing: 2,
  failed: 2,
  ready: 3,
  merging: 3,
  merged: 4,
  stale: 1,
};

function IconButton({ label, children, onClick, active }) {
  return (
    <button
      className={`icon-button ${active ? "active" : ""}`}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
function CodeBlock({ code, tone = "result" }) {
  return (
    <pre className={`code-block ${tone}`}>
      <code>
        {code.split("\n").map((line, index) => (
          <span className="code-line" key={index}>
            <span className="line-number" aria-hidden="true">
              {index + 1}
            </span>
            <span>{line}</span>
          </span>
        ))}
      </code>
    </pre>
  );
}

export function App() {
  const [state, dispatch] = useReducer(flowReducer, initialState);
  const [dark, setDark] = useState(false);
  const [expanded, setExpanded] = useState(null);
  const [codeTab, setCodeTab] = useState("compare");
  const [focus, setFocus] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [selectedCommit, setSelectedCommit] = useState(null);
  const [showDetails, setShowDetails] = useState(false);
  const [demoMenu, setDemoMenu] = useState(false);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState([]);
  const [replay, setReplay] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [toast, setToast] = useState("");
  const cardRef = useRef(null);
  const scrollRef = useRef(null);
  const inputRef = useRef(null);
  const latestReplyRef = useRef(null);
  const done = state.stage === "merged";
  const editable = state.stage === "conflict";
  const allConfirmed = state.confirmed.length === files.length;
  const busy = ["scanning", "testing", "merging"].includes(state.stage);
  const showToast = (text) => setToast(text);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 3500);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  }, [dark]);
  useEffect(() => {
    if (messages.length)
      latestReplyRef.current?.scrollIntoView({
        behavior: reducedMotion ? "instant" : "smooth",
        block: "end",
      });
  }, [messages.length, reducedMotion]);
  useEffect(() => {
    let timer;
    if (state.stage === "testing")
      timer = setInterval(
        () => dispatch({ type: "TICK_TESTS", amount: 7 }),
        550,
      );
    if (state.stage === "merging")
      timer = setTimeout(() => dispatch({ type: "MERGE_DONE" }), 1400);
    if (state.stage === "scanning")
      timer = setTimeout(() => dispatch({ type: "SCAN_DONE" }), 1300);
    return () => {
      clearTimeout(timer);
      clearInterval(timer);
    };
  }, [state.stage]);
  useEffect(() => {
    if (!replay) return;
    const timer = setTimeout(() => {
      if (state.stage === "conflict") {
        files.forEach((file) =>
          dispatch({ type: "CONFIRM_FILE", fileId: file.id }),
        );
        dispatch({ type: "RUN_TESTS" });
        setExpanded(null);
      } else if (state.stage === "ready") dispatch({ type: "MERGE" });
      else if (
        state.stage === "merged" ||
        state.stage === "failed" ||
        state.stage === "stale"
      )
        setReplay(false);
    }, 1600);
    return () => clearTimeout(timer);
  }, [replay, state.stage]);
  const reset = () => {
    setReplay(false);
    dispatch({ type: "RESET" });
    setExpanded(null);
    setCollapsed(false);
    setMessages([]);
    setSelectedCommit(null);
    setDemoMenu(false);
    scrollRef.current?.scrollTo({ top: 0 });
  };
  const review = (fileId) => {
    setExpanded(expanded === fileId ? null : fileId);
    setCodeTab("compare");
  };
  const run = () => {
    files.forEach((file) =>
      dispatch({ type: "CONFIRM_FILE", fileId: file.id }),
    );
    dispatch({ type: "RUN_TESTS" });
    setExpanded(null);
  };
  const retry = () => {
    dispatch({ type: "SET_SIMULATE_FAILURE", value: false });
    dispatch({ type: "RETRY_TESTS" });
  };
  const send = (raw = input) => {
    const text = raw.trim();
    if (!text) return;
    let response;
    if (/不要|别|取消|先不|暂停/.test(text)) {
      response =
        "收到，保持当前方案，不启动新的测试或合并。原型正在运行的步骤可用顶部“重置演示”结束。";
    } else if (/为什么|解释/.test(text)) {
      setExpanded(/第二|middleware/.test(text) ? "middleware" : "auth");
      setCodeTab("result");
      setCollapsed(false);
      response =
        "两边修改的是不同意图：feature 处理过期会话，main 处理密钥轮换。组合方案先轮换密钥，再判断过期状态。上方任务卡已展开代码，验证后也可以只读回看。";
    } else if (
      /^(第二个文件保留 main|middleware 采用 main|middleware.ts 采用 main)[。！!]?$/i.test(
        text,
      )
    ) {
      if (editable) {
        dispatch({ type: "CHOOSE", fileId: "middleware", choice: "incoming" });
        setExpanded("middleware");
        setCodeTab("result");
        setCollapsed(false);
        response =
          "已把 middleware.ts 改为采用 main 的登录保护，并更新上面的同一张任务卡。请确认结果后再验证。";
      } else
        response =
          "当前方案已进入验证或完成阶段。你可以回看已锁定的代码；如需调整，请先重置演示。";
    } else if (
      /^(运行测试|运行验证|确认并验证)[。！!]?$/i.test(text) &&
      editable
    ) {
      run();
      response = "已确认当前两项选择，任务卡正在原位显示测试进度。";
    } else
      response =
        "这是本地交互原型，尚未连接模型。可用示例指令：“第二个文件保留 main”“解释组合方案”“运行验证”。你也可以直接操作任务卡。";
    setMessages((prev) => [...prev, { id: Date.now(), text, response }]);
    setInput("");
    setToast("已回复 · 在当前任务卡下方查看");
  };
  const jumpToCard = () =>
    cardRef.current?.scrollIntoView({
      behavior: reducedMotion ? "instant" : "smooth",
      block: "center",
    });
  return (
    <div
      className={`app ${dark ? "dark" : ""} ${focus ? "focus-mode" : ""} ${reducedMotion ? "reduce-motion" : ""}`}
    >
      <aside className="sidebar">
        <div className="brand">
          <img src="/synax-icon.png" alt="" />
          <strong>Synax</strong>
          <span className="brand-tag">Workspace</span>
          <IconButton label="收起侧栏" onClick={() => setFocus(true)}>
            <PanelLeft size={16} />
          </IconButton>
        </div>
        <button
          className="workspace-picker"
          onClick={() => showToast("原型工作区：Synax · 本地演示")}
        >
          <span className="workspace-icon">
            <Folder size={17} />
          </span>
          <span>
            <strong>Synax</strong>
            <small>本地工作区</small>
          </span>
          <ChevronDown size={14} />
        </button>
        <button className="new-chat" onClick={reset}>
          <Plus size={16} />
          新对话<span>⌘ N</span>
        </button>
        <div className="sidebar-label">工作区</div>
        <button
          className="side-link"
          onClick={() => showToast("当前正在演示对话内 Git 操作")}
        >
          <Folder size={16} />
          文件
        </button>
        <button className="side-link" onClick={jumpToCard}>
          <GitBranch size={16} />
          源代码管理<span>2</span>
        </button>
        <button
          className="side-link"
          onClick={() => {
            setShowDetails(true);
            jumpToCard();
          }}
        >
          <Terminal size={16} />
          终端与任务
        </button>
        <div className="sidebar-label history-label">
          今天{" "}
          <button
            aria-label="搜索对话"
            onClick={() => showToast("原型包含一个示例对话")}
          >
            <Search size={13} />
          </button>
        </div>
        <button className="chat-link selected" onClick={jumpToCard}>
          <MessageSquare size={14} />
          <span>
            合并会话刷新功能<small>feature/session-refresh</small>
          </span>
          <i />
        </button>
        <div className="side-note">
          <span>INTERACTIVE CONVERSATION</span>
          <p>
            让复杂过程，
            <br />
            在对话中变得清晰。
          </p>
          <div>
            <GitBranch size={14} />
            <TestTube2 size={14} />
            <Code2 size={14} />
          </div>
        </div>
        <div className="sidebar-bottom">
          <span className="user-avatar">M</span>
          <div>
            <strong>Mint</strong>
            <small>个人工作区</small>
          </div>
          <IconButton
            label={dark ? "切换浅色主题" : "切换深色主题"}
            onClick={() => setDark(!dark)}
          >
            {dark ? <Sun size={16} /> : <Moon size={16} />}
          </IconButton>
        </div>
      </aside>
      <div className="main-shell">
        <header className="app-header">
          <div className="breadcrumbs">
            {focus && (
              <IconButton label="展开侧栏" onClick={() => setFocus(false)}>
                <PanelLeft size={16} />
              </IconButton>
            )}
            <Folder size={14} />
            <span>Synax</span>
            <span className="slash">/</span>
            <strong>合并会话刷新功能</strong>
          </div>
          <div className="header-right">
            <span className="prototype-badge">交互原型</span>
            <button
              className="quiet-button"
              onClick={() => {
                reset();
                setReplay(true);
              }}
              disabled={replay}
            >
              <PlayIcon />
              {replay ? "正在演示" : "播放全流程"}
            </button>
            <IconButton label="重置演示" onClick={reset}>
              <RotateCcw size={15} />
            </IconButton>
            <IconButton
              label="演示选项"
              active={demoMenu}
              onClick={() => setDemoMenu(!demoMenu)}
            >
              <SlidersHorizontal size={15} />
            </IconButton>
          </div>
          {demoMenu && (
            <div className="demo-menu">
              <strong>演示选项</strong>
              <label>
                <input
                  type="checkbox"
                  checked={state.simulateFailure}
                  disabled={busy || done}
                  onChange={(e) =>
                    dispatch({
                      type: "SET_SIMULATE_FAILURE",
                      value: e.target.checked,
                    })
                  }
                />
                下一次验证模拟失败
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={reducedMotion}
                  onChange={(e) => setReducedMotion(e.target.checked)}
                />
                减少动效
              </label>
              <button
                disabled={state.stage !== "ready"}
                onClick={() => {
                  dispatch({ type: "MERGE_GUARD" });
                  setDemoMenu(false);
                }}
              >
                模拟 main 已更新<span>测试通过后可用</span>
              </button>
              <small>所有操作使用示例数据</small>
            </div>
          )}
        </header>
        <div className="conversation-scroll" ref={scrollRef}>
          <div className="conversation-width">
            <div className="thread-heading">
              <span>今天 · 14:32</span>
              <span>
                <GitBranch size={12} /> feature/session-refresh
              </span>
            </div>
            <div className="user-message">
              <p>
                帮我把会话刷新功能合并到 main。
                <br className="mobile-br" />
                有冲突先让我看一下，测试通过再合并。
              </p>
              <span className="user-mini">M</span>
            </div>
            <section className="assistant-turn">
              <div className="assistant-label">
                <img src="/synax-icon.png" alt="" />
                <strong>Synax</strong>
                <span>为当前任务生成交互视图</span>
              </div>
              <button
                className="activity-disclosure"
                onClick={() => setShowDetails(!showDetails)}
                aria-expanded={showDetails}
              >
                <Check size={13} />
                <span>已检查分支与改动</span>
                <span className="subtle">· 5 次工具调用</span>
                {showDetails ? (
                  <ChevronDown size={13} />
                ) : (
                  <ChevronRight size={13} />
                )}
              </button>
              {showDetails && (
                <div className="tool-details">
                  <div>
                    <Check size={12} />
                    git status<span>工作区干净</span>
                  </div>
                  <div>
                    <Check size={12} />
                    git log main...feature/session-refresh
                    <span>3 项功能改动</span>
                  </div>
                  <div>
                    <Check size={12} />
                    git merge-tree<span>2 个文件冲突</span>
                  </div>
                  <div>
                    <Check size={12} />
                    read_file × 2<span>已生成组合建议</span>
                  </div>
                  <small>示例工具记录 · 未执行真实命令</small>
                </div>
              )}
              <p className="assistant-intro">
                main 上的密钥轮换与会话刷新修改了同一段逻辑。
                <br />
                我找到了 <strong>2 处冲突</strong>，并准备了保留双方意图的方案。
              </p>
              <section
                ref={cardRef}
                className={`flow-card stage-${state.stage}`}
                data-testid="merge-card"
                aria-label="会话刷新合并任务"
              >
                <div className="flow-header">
                  <span className="flow-icon">
                    <GitPullRequest size={19} />
                  </span>
                  <div>
                    <h1>
                      会话刷新与认证优化 <span>#128</span>
                    </h1>
                    <p>
                      <code>feature/session-refresh</code>
                      <ArrowUpRight size={12} />
                      <code>main</code>
                    </p>
                  </div>
                  <span
                    className={`state-badge ${["failed", "stale", "conflict"].includes(state.stage) ? "warning" : ""}`}
                    aria-live="polite"
                  >
                    {busy ? (
                      <LoaderCircle className="spin" size={12} />
                    ) : done ? (
                      <GitMerge size={12} />
                    ) : (
                      <i />
                    )}
                    {titles[state.stage]}
                  </span>
                  <IconButton
                    label={focus ? "退出专注视图" : "展开专注视图"}
                    onClick={() => setFocus(!focus)}
                  >
                    {focus ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                  </IconButton>
                  <IconButton
                    label={collapsed ? "展开任务卡" : "折叠任务卡"}
                    onClick={() => setCollapsed(!collapsed)}
                  >
                    {collapsed ? (
                      <ChevronRight size={15} />
                    ) : (
                      <ChevronDown size={15} />
                    )}
                  </IconButton>
                </div>
                {!collapsed && (
                  <>
                    <ol className="step-strip" aria-label="任务进度">
                      {stepLabels.map((label, index) => (
                        <li
                          key={label}
                          className={
                            stageStep[state.stage] > index
                              ? "complete"
                              : stageStep[state.stage] === index
                                ? "current"
                                : ""
                          }
                        >
                          <span>
                            {stageStep[state.stage] > index ? (
                              <Check size={11} />
                            ) : (
                              index + 1
                            )}
                          </span>
                          {label}
                          {index < 3 && <ChevronRight size={12} />}
                        </li>
                      ))}
                    </ol>
                    <div className="graph-section">
                      <div className="section-eyebrow">
                        <span>分支与提交</span>
                        <span>点击节点查看变更</span>
                      </div>
                      <GitGraph
                        stage={state.stage}
                        confirmedFiles={state.confirmed}
                        onConflictClick={review}
                        selectedCommit={selectedCommit}
                        onSelectCommit={setSelectedCommit}
                      />
                    </div>
                    {state.stage !== "scanning" && (
                      <div className="conflicts-section">
                        <div className="conflict-heading">
                          <div>
                            <span className="small-alert">
                              <CircleAlert size={14} />
                            </span>
                            <strong>
                              {state.stage === "stale"
                                ? "基线发生变化"
                                : editable
                                  ? "需要你确认的冲突"
                                  : "已确认的解决方案"}
                            </strong>
                            <span className="count">
                              {state.confirmed.length} / 2
                            </span>
                          </div>
                          <span className="ai-recommend">
                            {editable ? (
                              <>
                                <Sparkles size={12} />
                                已生成解决建议
                              </>
                            ) : (
                              <>
                                {state.stage === "stale"
                                  ? "需要重新分析"
                                  : "只读 · 点击回看"}
                              </>
                            )}
                          </span>
                        </div>
                        {state.stage === "stale" ? (
                          <div className="stale-note">
                            <p>
                              main
                              新增了提交。之前的方案和测试已失效，请基于最新代码重新分析。
                            </p>
                            <small>
                              基线 v{state.revision - 1} → v{state.revision} ·
                              已保留操作记录
                            </small>
                          </div>
                        ) : (
                          files.map((file) => (
                            <div
                              className={`conflict-file ${expanded === file.id ? "expanded" : ""}`}
                              key={file.id}
                            >
                              <button
                                className="conflict-row"
                                onClick={() => review(file.id)}
                                aria-expanded={expanded === file.id}
                              >
                                <FileCode2 size={15} />
                                <strong>{file.name}</strong>
                                <span className="file-purpose">
                                  {file.title}
                                </span>
                                <span
                                  className={`file-status ${state.confirmed.includes(file.id) ? "confirmed" : ""}`}
                                >
                                  {state.confirmed.includes(file.id) ? (
                                    <>
                                      <Check size={12} />
                                      {choiceLabels[state.choices[file.id]]} ·
                                      已确认
                                    </>
                                  ) : (
                                    <>
                                      {choiceLabels[state.choices[file.id]]}
                                      <ChevronRight size={13} />
                                    </>
                                  )}
                                </span>
                              </button>
                              {expanded === file.id && (
                                <div className="conflict-body">
                                  <p className="conflict-description">
                                    {file.summary}
                                  </p>
                                  <div
                                    className="choice-buttons"
                                    role="group"
                                    aria-label={`${file.name}解决方案`}
                                  >
                                    {Object.entries(choiceLabels).map(
                                      ([choice, label]) => (
                                        <button
                                          key={choice}
                                          disabled={!editable}
                                          aria-pressed={
                                            state.choices[file.id] === choice
                                          }
                                          className={
                                            state.choices[file.id] === choice
                                              ? "chosen"
                                              : ""
                                          }
                                          onClick={() =>
                                            dispatch({
                                              type: "CHOOSE",
                                              fileId: file.id,
                                              choice,
                                            })
                                          }
                                        >
                                          {choice === "combined" && (
                                            <Sparkles size={12} />
                                          )}{" "}
                                          {label}
                                          {state.choices[file.id] ===
                                            choice && <Check size={12} />}
                                        </button>
                                      ),
                                    )}
                                  </div>
                                  <div
                                    className="code-tabs"
                                    role="group"
                                    aria-label="代码视图"
                                  >
                                    <button
                                      aria-pressed={codeTab === "compare"}
                                      className={
                                        codeTab === "compare" ? "selected" : ""
                                      }
                                      onClick={() => setCodeTab("compare")}
                                    >
                                      对比两侧
                                    </button>
                                    <button
                                      aria-pressed={codeTab === "result"}
                                      className={
                                        codeTab === "result" ? "selected" : ""
                                      }
                                      onClick={() => setCodeTab("result")}
                                    >
                                      合并结果
                                    </button>
                                    <span>{file.path}</span>
                                  </div>
                                  {codeTab === "compare" ? (
                                    <div className="code-columns">
                                      <div>
                                        <div className="code-label local">
                                          当前 · feature
                                        </div>
                                        <CodeBlock
                                          code={file.local}
                                          tone="local"
                                        />
                                      </div>
                                      <div>
                                        <div className="code-label incoming">
                                          传入 · main
                                        </div>
                                        <CodeBlock
                                          code={file.incoming}
                                          tone="incoming"
                                        />
                                      </div>
                                    </div>
                                  ) : (
                                    <div className="result-code">
                                      <CodeBlock
                                        code={file[state.choices[file.id]]}
                                      />
                                    </div>
                                  )}
                                  <div className="explanation">
                                    <Sparkles size={13} />
                                    <p>
                                      {
                                        file.explanations[
                                          state.choices[file.id]
                                        ]
                                      }
                                    </p>
                                  </div>
                                  <div className="file-actions">
                                    <button
                                      className="text-button"
                                      onClick={() => {
                                        setCodeTab("result");
                                      }}
                                    >
                                      查看合并结果
                                      <ArrowUpRight size={12} />
                                    </button>
                                    <button
                                      className="secondary-button"
                                      disabled={
                                        !editable ||
                                        state.confirmed.includes(file.id)
                                      }
                                      onClick={() => {
                                        dispatch({
                                          type: "CONFIRM_FILE",
                                          fileId: file.id,
                                        });
                                        setExpanded(
                                          file.id === "auth"
                                            ? "middleware"
                                            : null,
                                        );
                                        setCodeTab("compare");
                                      }}
                                    >
                                      {!editable
                                        ? "已锁定方案"
                                        : state.confirmed.includes(file.id)
                                          ? "已确认"
                                          : "确认此方案"}
                                      <Check size={13} />
                                    </button>
                                  </div>
                                </div>
                              )}
                            </div>
                          ))
                        )}
                      </div>
                    )}
                    {[
                      "testing",
                      "failed",
                      "ready",
                      "merging",
                      "merged",
                    ].includes(state.stage) && (
                      <div className="verification-section">
                        <div className="verification-title">
                          <span>
                            {state.stage === "failed" ? (
                              <CircleAlert size={17} />
                            ) : state.stage === "testing" ? (
                              <LoaderCircle size={17} className="spin" />
                            ) : (
                              <CheckCheck size={17} />
                            )}
                            <strong>
                              {state.stage === "failed"
                                ? "发现一个需要修复的边界"
                                : state.stage === "testing"
                                  ? "正在验证合并结果"
                                  : "全部检查通过"}
                            </strong>
                          </span>
                          <code>{state.testProgress} / 42</code>
                        </div>
                        <div className="progress-track">
                          <div
                            style={{
                              width: `${(state.testProgress / 42) * 100}%`,
                            }}
                          />
                        </div>
                        <div className="test-groups">
                          <span>
                            <Check size={12} />
                            类型检查
                          </span>
                          <span>
                            <Check size={12} />
                            冲突标记清除
                          </span>
                          <span>
                            {state.stage === "testing" ? (
                              <LoaderCircle size={12} className="spin" />
                            ) : state.stage === "failed" ? (
                              <X size={12} />
                            ) : (
                              <Check size={12} />
                            )}
                            会话回归测试
                          </span>
                        </div>
                        {state.stage === "failed" && (
                          <div className="error-log">
                            <code>FAIL auth/session-refresh.test.ts:48</code>
                            <p>
                              过期会话 + 密钥轮换：预期返回有效 token，收到
                              401。
                            </p>
                            <span>建议：补齐旧密钥兼容分支，再重新验证。</span>
                          </div>
                        )}
                        {done && (
                          <div className="merge-receipt">
                            <GitMerge size={17} />
                            <div>
                              <strong>已合并到 main</strong>
                              <span>
                                合并提交 <code>4f8a2d1</code> · 2 个冲突已解决
                              </span>
                            </div>
                            <span className="demo-tag">模拟结果</span>
                          </div>
                        )}
                      </div>
                    )}
                    <div className="flow-footer">
                      <div className="footer-status">
                        {busy ? (
                          <LoaderCircle size={14} className="spin" />
                        ) : done ? (
                          <Check size={14} />
                        ) : (
                          <span className="footer-dot" />
                        )}
                        <span>
                          {state.stage === "conflict"
                            ? allConfirmed
                              ? "所有方案已确认"
                              : "方案待确认，尚未写入工作区"
                            : state.stage === "testing"
                              ? `验证中 · 已完成 ${state.testProgress} 项`
                              : state.stage === "ready"
                                ? "42 项通过，等待确认合并"
                                : state.stage === "failed"
                                  ? "保留已确认方案，可修复重试"
                                  : state.stage === "merged"
                                    ? "任务已完成 · 可回看决策"
                                    : state.stage === "stale"
                                      ? "重新分析后才能继续"
                                      : "正在更新当前任务"}
                        </span>
                      </div>
                      <div className="footer-actions">
                        {editable && (
                          <>
                            <button
                              className="text-button"
                              onClick={() => {
                                setExpanded(expanded ? null : "auth");
                                setCodeTab("compare");
                              }}
                            >
                              {expanded ? "收起详情" : "逐个查看"}
                            </button>
                            <button className="primary-button" onClick={run}>
                              <Sparkles size={14} />
                              {allConfirmed
                                ? "运行验证"
                                : state.choices.auth === "combined" &&
                                    state.choices.middleware === "combined"
                                  ? "采用建议并验证"
                                  : "应用所选方案并验证"}
                            </button>
                          </>
                        )}
                        {state.stage === "ready" && (
                          <button
                            className="primary-button"
                            onClick={() => dispatch({ type: "MERGE" })}
                          >
                            <GitMerge size={14} />
                            确认合并到 main
                          </button>
                        )}
                        {state.stage === "failed" && (
                          <button className="primary-button" onClick={retry}>
                            <RotateCcw size={14} />
                            模拟修复并重试
                          </button>
                        )}
                        {state.stage === "stale" && (
                          <button
                            className="primary-button"
                            onClick={() => dispatch({ type: "RESCAN" })}
                          >
                            <RotateCcw size={14} />
                            重新分析
                          </button>
                        )}
                        {done && (
                          <button
                            className="text-button"
                            onClick={() => setShowDetails(!showDetails)}
                          >
                            <History size={14} />
                            查看操作记录
                          </button>
                        )}
                        {busy && (
                          <span className="working-label">
                            {state.stage === "merging"
                              ? "正在合并…"
                              : state.stage === "scanning"
                                ? "读取最新基线…"
                                : "运行中…"}
                          </span>
                        )}
                      </div>
                    </div>
                  </>
                )}
                {collapsed && (
                  <button
                    className="collapsed-summary"
                    onClick={() => setCollapsed(false)}
                  >
                    <GitBranch size={15} />
                    {titles[state.stage]} · 2 个文件 · {state.confirmed.length}{" "}
                    项已确认
                    <span>
                      展开
                      <ChevronDown size={13} />
                    </span>
                  </button>
                )}
                <div className="card-caption">
                  <span>
                    <span className="live-dot" />
                    同一任务 · 实时更新
                  </span>
                  <span>示例数据 · 不执行真实 Git 操作</span>
                </div>
              </section>
              <p className="assistant-outro">
                你可以直接确认建议，也可以展开文件对比。选择会留在这段对话里。
              </p>
              <div className="suggestions">
                <button onClick={() => send("为什么建议组合这两段逻辑？")}>
                  <MessageSquare size={12} />
                  解释组合方案
                </button>
                <button onClick={() => send("第二个文件保留 main")}>
                  <GitBranch size={12} />
                  第二个文件保留 main
                </button>
              </div>
              {showDetails && (
                <div className="decision-log">
                  <div>
                    <History size={14} />
                    <strong>当前任务的操作记录</strong>
                  </div>
                  {state.events.map((event) => (
                    <p key={event.id}>
                      <span className={event.kind} />
                      {event.text}
                    </p>
                  ))}
                  <small>记录与任务绑定；原型重置后清空</small>
                </div>
              )}
            </section>
            {messages.map((message) => (
              <div className="followup-turn" key={message.id}>
                <div className="user-message">
                  <p>{message.text}</p>
                  <span className="user-mini">M</span>
                </div>
                <div className="assistant-label">
                  <img src="/synax-icon.png" alt="" />
                  <strong>Synax</strong>
                  <button className="return-card" onClick={jumpToCard}>
                    任务卡已关联
                    <ArrowUpRight size={12} />
                  </button>
                </div>
                <p>{message.response}</p>
              </div>
            ))}
            <div ref={latestReplyRef} />
            {messages.length > 0 && (
              <button className="back-to-card" onClick={jumpToCard}>
                <ArrowUp size={13} />
                回到当前任务
              </button>
            )}
          </div>
        </div>
        <footer className="composer-area">
          <div className="composer-container">
            <div className="context-line">
              <GitBranch size={12} />
              <span>feature/session-refresh</span>
              <span className="context-separator" />{" "}
              <button
                type="button"
                className="attached-task"
                onClick={jumpToCard}
              >
                <GitPullRequest size={12} />
                合并任务 #128
              </button>
              <span className="context-spacer" />
              <span>本地演示</span>
            </div>
            <form
              className="composer"
              onSubmit={(e) => {
                e.preventDefault();
                send();
              }}
            >
              <textarea
                ref={inputRef}
                aria-label="继续对话"
                value={input}
                rows={1}
                onChange={(e) => setInput(e.target.value)}
                placeholder="继续对话，或告诉我如何调整方案…"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
              />
              <div className="composer-bottom">
                <button
                  type="button"
                  className="composer-add"
                  aria-label="添加上下文"
                  onClick={() => showToast("当前已关联分支和合并任务")}
                >
                  <Plus size={17} />
                </button>
                <span>
                  <Sparkles size={12} />
                  Agent <ChevronDown size={11} />
                </span>
                <span className="composer-model">Synax · 演示模式</span>
                <button
                  type="submit"
                  className="send-button"
                  aria-label="发送消息"
                  disabled={!input.trim()}
                >
                  <ArrowUp size={17} />
                </button>
              </div>
            </form>
            <div className="composer-footnote">
              <span>可视化随任务更新，对话保留你的每次决策。</span>
              <span>↵ 发送</span>
            </div>
          </div>
        </footer>
      </div>
      {toast && (
        <div className="toast" role="status">
          <Check size={14} />
          {toast}
        </div>
      )}
    </div>
  );
}
function PlayIcon() {
  return <ChevronRight size={14} />;
}
