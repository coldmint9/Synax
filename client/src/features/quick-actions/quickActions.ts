import {
  Bug,
  ClipboardCheck,
  FileText,
  GitPullRequest,
  ListChecks,
  Map,
  Network,
  ShieldCheck,
  TestTube2,
  type LucideIcon,
} from "lucide-react";
import type { AgentSessionMode } from "../../adapters/transport/agentRuntime";

export type Locale = "zh" | "en";
type LocalizedCopy = { zh: string; en: string };

export type QuickActionCategory = "understand" | "quality" | "deliver";

/** One skill mounted with the session that the action starts. */
export interface QuickActionSkill {
  id: string;
  label: LocalizedCopy;
  /** Hidden while the enterprise account is signed out. */
  requiresSignIn?: boolean;
}

interface QuickActionBase {
  id: string;
  category: QuickActionCategory;
  title: LocalizedCopy;
  /** The outcome the action produces; shown in the card tooltip. */
  description: LocalizedCopy;
  icon: LucideIcon;
  requiresSignIn?: boolean;
  /** Wider grid cell; reserve it for the two highest-value procedures. */
  featured?: boolean;
}

export interface QuickActionInput {
  /** What the user must supply before the action can run. */
  hint: LocalizedCopy;
  /** Composer placeholder shown while the action is attached. */
  placeholder: LocalizedCopy;
}

export type QuickAction =
  | (QuickActionBase & {
      kind: "launch";
      mode: AgentSessionMode;
      skills: readonly QuickActionSkill[];
      brief: LocalizedCopy;
      /**
       * `instant` starts the session immediately. `compose` attaches the
       * procedure to the composer and waits for the missing user context.
       */
      policy: "instant" | "compose";
      input?: QuickActionInput;
    })
  | (QuickActionBase & { kind: "navigate"; to: string });

export interface QuickActionLaunch {
  actionId: string;
  text: string;
  skillIds: string[];
  mode: AgentSessionMode;
}

/** A procedure attached to a composer instead of being sent right away. */
export interface QuickActionAttachment {
  actionId: string;
  title: string;
  text: string;
  skillIds: string[];
  mode: AgentSessionMode;
  requiresInput: boolean;
  hint?: string;
  placeholder?: string;
}

export const QUICK_ACTION_CATEGORIES = [
  { id: "all", label: { zh: "全部", en: "All" } },
  { id: "understand", label: { zh: "理解", en: "Understand" } },
  { id: "quality", label: { zh: "质量", en: "Quality" } },
  { id: "deliver", label: { zh: "交付", en: "Ship" } },
] as const satisfies readonly { id: QuickActionCategory | "all"; label: LocalizedCopy }[];

/**
 * The shortcuts docked above the composer, in display order. This is the
 * current push list, so promoting a different procedure means editing it here
 * instead of reshuffling the whole catalog.
 */
export const QUICK_ACTION_PINNED_IDS = [
  "visual-explainer",
  "diagnose",
  "code-review",
  "release-gate",
] as const;

const skill = {
  onboarding: { id: "synax-builtin/project-onboarding", label: { zh: "项目上手", en: "Project onboarding" } },
  explore: { id: "synax-builtin/synax-explore", label: { zh: "只读探索", en: "Read-only exploration" } },
  visualize: { id: "synax-builtin/visualize", label: { zh: "交互图解", en: "Interactive diagram" } },
  review: { id: "synax-builtin/code-review", label: { zh: "代码评审", en: "Code review" } },
  verify: { id: "synax-builtin/verification-before-completion", label: { zh: "完成前验证", en: "Verification" } },
  debug: { id: "synax-builtin/systematic-debugging", label: { zh: "系统化排障", en: "Systematic debugging" } },
  tests: { id: "synax-builtin/test-augmentation", label: { zh: "测试补齐", en: "Test augmentation" } },
  digest: { id: "synax-builtin/change-digest", label: { zh: "变更说明", en: "Change digest" } },
  plan: { id: "synax-builtin/requirement-breakdown", label: { zh: "需求拆解", en: "Requirement breakdown" } },
  release: { id: "synax-builtin/release-readiness", label: { zh: "发布门禁", en: "Release gate" } },
  handoff: { id: "synax-builtin/session-handoff", label: { zh: "会话交接", en: "Session handoff" } },
} as const satisfies Record<string, QuickActionSkill>;

/**
 * Featured cards span two grid cells, so the catalog fills the 3-column and
 * 2-column layouts row by row; an odd cell count leaves the last card alone on
 * the final row instead of shrinking the grid.
 */
/**
 * The single catalog behind the home shortcuts. Every launch entry names the
 * skills it mounts, so a shortcut is a reproducible procedure rather than an
 * ad-hoc paragraph in the composer.
 */
export const QUICK_ACTIONS: readonly QuickAction[] = [
  {
    id: "project-onboarding",
    kind: "launch",
    policy: "instant",
    category: "understand",
    icon: Map,
    mode: "chat",
    featured: true,
    title: { zh: "理解项目", en: "Explore project" },
    description: {
      zh: "只读梳理结构、运行与测试命令、关键链路，给出阅读顺序和风险地图",
      en: "Read-only map of structure, run and test commands, key paths, reading order and risks",
    },
    skills: [skill.onboarding, skill.visualize],
    brief: {
      zh: [
        "把这次会话当作项目上手：只读勘察当前工作区，产出可以直接照着走的项目导览。",
        "",
        "需要覆盖：",
        "1. 技术栈与真实命令：安装、启动、构建、测试、类型检查，以仓库脚本为准。",
        "2. 分层与模块边界：入口层、领域逻辑、外部适配、数据访问各自负责什么，依赖朝哪个方向流动。",
        "3. 一条典型链路的端到端走向：从入口到数据与外部依赖，标出关键文件。",
        "4. 5-8 个“先读这些”的文件，按顺序说明理由。",
        "5. 最容易踩坑或最容易回归的 3 个位置。",
        "",
        "约束：不修改任何文件；结论给出文件路径，无法确认的内容明确标注为推断。",
        "交付：先用一张交互式架构图呈现模块关系，再给文字说明与证据清单。",
      ].join("\n"),
      en: [
        "Treat this session as project onboarding: explore the workspace read-only and produce a tour someone can follow immediately.",
        "",
        "Cover:",
        "1. Stack and the real commands for install, run, build, test and type-check, taken from repository scripts.",
        "2. Layers and module boundaries: entry points, domain logic, external adapters and data access, plus dependency direction.",
        "3. One representative path end to end, from entry point to persistence and external calls, with the key files.",
        "4. Five to eight files to read first, in order, with the reason for each.",
        "5. The three places where a small change is most likely to break something.",
        "",
        "Rules: change nothing; cite file paths and label anything unconfirmed as inference.",
        "Deliverable: one interactive architecture diagram, then prose notes and an evidence list.",
      ].join("\n"),
    },
  },
  {
    id: "requirement-breakdown",
    kind: "launch",
    policy: "compose",
    category: "understand",
    icon: ListChecks,
    mode: "chat",
    title: { zh: "拆解需求", en: "Plan a feature" },
    description: {
      zh: "先查可复用能力与歧义，再拆出有依赖顺序和验收标准的实施步骤",
      en: "Check reuse and ambiguity first, then produce ordered steps with acceptance criteria",
    },
    skills: [skill.plan],
    input: {
      hint: { zh: "需求目标、使用场景与验收条件", en: "goal, usage scenario and acceptance conditions" },
      placeholder: { zh: "描述需求目标、使用场景和验收条件…", en: "Describe the goal, usage scenario and acceptance conditions…" },
    },
    brief: {
      zh: [
        "把下面的需求拆成可以执行的实施计划，先对齐问题，再谈方案。",
        "",
        "1. 复述目标、使用者与可观察的验收条件，明确不做什么。",
        "2. 列出最多 3 个会改变设计的歧义，每个给出你建议的默认答案。",
        "3. 在现有代码中搜索可复用能力与相似实现，说明为什么复用或扩展现有接口。",
        "4. 说明影响范围：模块、公开契约、数据与配置、外部依赖、权限。",
        "5. 拆成有依赖顺序的步骤，每步给出完成判据与验证方式。",
        "6. 标注风险、回滚方式，以及明确不建议做的范围。",
        "",
        "约束：本轮只做方案，不修改代码。",
        "需求描述：",
      ].join("\n"),
      en: [
        "Turn the requirement below into an executable plan. Align on the problem before proposing a solution.",
        "",
        "1. Restate the goal, the user and observable acceptance conditions; state what is out of scope.",
        "2. List at most three ambiguities that would change the design, each with your recommended default.",
        "3. Search the codebase for reusable capabilities and similar implementations; justify reuse or extending an existing contract.",
        "4. Describe the impact: modules, public contracts, data and configuration, external dependencies, permissions.",
        "5. Break the work into ordered steps, each with a completion check and a way to verify it.",
        "6. Note risks, rollback, and what you deliberately would not do.",
        "",
        "Rules: plan only; do not edit code in this turn.",
        "Requirement:",
      ].join("\n"),
    },
  },
  {
    id: "visual-explainer",
    kind: "launch",
    policy: "compose",
    category: "understand",
    icon: Network,
    mode: "chat",
    title: { zh: "可视化图解", en: "Visual explainer" },
    description: {
      zh: "把问题画成可交互的图解：流程、结构、对比或界面原型，而不是文字长文",
      en: "Answer with an interactive diagram — flow, structure, comparison or UI prototype — instead of prose",
    },
    skills: [skill.visualize],
    input: {
      hint: { zh: "想弄明白的问题，或想看到的界面", en: "the question to explain, or the interface to preview" },
      placeholder: {
        zh: "输入任何问题，都会用交互式图解回答…",
        en: "Type any question; it comes back as an interactive visualization…",
      },
    },
    brief: {
      zh: [
        "本次输出形式已确定：用一张交互式图解回答问题，不要写成纯文字长文。",
        "",
        "1. 先选形式：流程或时序、结构与依赖、方案对比、数据趋势、可调参数的模型、界面原型，取最能解释问题的那一种。",
        "2. 只画解释问题需要的信息：一张主视图，加上真正有用的交互（切换、悬停细节、滑块、分步）；不要堆叠多个近似的视图。",
        "3. 问题涉及当前工作区时，先只读代码或配置再画：图中每个事实都要能指到出处；无法确认的部分标注为推断，不虚构数据或指标。",
        "4. 按 visualize 技能产出：把自包含的 HTML 片段写到会话工作区的 .synax/visualizations/ 下，读回确认主交互可用，然后在最终回答中单独一行给出该引用（绝对路径，可带简短标题，界面原型用 mode: \"wide\"）。",
        "5. 图解之外只保留必要文字：一句结论和怎么读这张图，不复述图中已有的内容。",
        "",
        "待图解的问题：",
      ].join("\n"),
      en: [
        "The output format for this turn is fixed: answer with one interactive visualization instead of a wall of prose.",
        "",
        "1. Pick the form that explains the question best: flow or sequence, structure and dependencies, option comparison, data trend, an adjustable parameter model, or a UI prototype.",
        "2. Draw only what the explanation needs: one primary view plus interactions that carry meaning (switch, detail on hover, slider, step through). Do not stack near-duplicate views.",
        "3. When the question concerns this workspace, read the code or configuration first: every fact in the diagram must point to a source, and anything unconfirmed is labelled inference. Never invent data or metrics.",
        "4. Produce it the way the visualize skill specifies: write a self-contained HTML fragment under .synax/visualizations/ in the session workspace, read it back to confirm the primary interaction, then emit its reference on its own line in the final answer (absolute path, optional short title, mode: \"wide\" for a UI prototype).",
        "5. Keep prose outside the diagram minimal: a one-sentence conclusion and how to read it; do not restate what the diagram already shows.",
        "",
        "Question to visualize:",
      ].join("\n"),
    },
  },
  {
    id: "code-review",
    kind: "launch",
    policy: "instant",
    category: "quality",
    icon: GitPullRequest,
    mode: "chat",
    title: { zh: "审查改动", en: "Review changes" },
    description: {
      zh: "按严重程度找出缺陷、回归和测试缺口，给出文件位置，不改代码",
      en: "Find defects, regressions and test gaps by severity with file references; no edits",
    },
    skills: [skill.review, skill.verify],
    brief: {
      zh: [
        "审查当前工作区尚未提交的改动，输出可以直接用于合并决策的评审结论。",
        "",
        "流程：先用 git status 与 git diff 确认改动范围；逐个 hunk 对照意图与调用方；检查错误处理、边界条件、异步与并发、权限和数据一致性；核对邻近测试。",
        "",
        "要求：",
        "- 按 P0（阻断）/ P1（应修）/ P2（建议）分级，每条给出文件与行号、触发条件、影响和最小修复方向。",
        "- 区分已确认问题与待验证假设，不要把风格偏好写成缺陷。",
        "- 明确列出本次改动缺少的测试。",
        "- 说明哪些检查实际运行过，哪些没有。",
        "",
        "约束：本轮只评审，不修改代码。",
      ].join("\n"),
      en: [
        "Review the uncommitted changes in this workspace and produce a merge-ready verdict.",
        "",
        "Process: confirm scope with git status and git diff; compare each hunk with its intent and callers; check error handling, boundaries, async and concurrency, permissions and data consistency; read the nearby tests.",
        "",
        "Requirements:",
        "- Rank findings P0 (blocking) / P1 (should fix) / P2 (suggestion); include file and line, trigger condition, impact and the smallest fix direction.",
        "- Separate confirmed issues from unverified assumptions; do not report style preferences as defects.",
        "- List the tests this change is missing.",
        "- State which checks were actually run and which were not.",
        "",
        "Rules: review only; do not edit code in this turn.",
      ].join("\n"),
    },
  },
  {
    id: "diagnose",
    kind: "launch",
    policy: "compose",
    category: "quality",
    icon: Bug,
    mode: "chat",
    title: { zh: "排查问题", en: "Investigate a bug" },
    description: {
      zh: "先复现和定位，再用可证伪的假设找到根因，补上回归测试",
      en: "Reproduce and localize first, prove a root cause, then lock it with a regression test",
    },
    skills: [skill.debug, skill.explore],
    input: {
      hint: { zh: "问题现象、复现步骤与期望行为", en: "observed behavior, reproduction steps and expectations" },
      placeholder: { zh: "先写问题现象，再补充复现步骤和期望行为…", en: "Describe the symptom, then the steps to reproduce and expected behavior…" },
    },
    brief: {
      zh: [
        "帮我排查下面的问题，按可验证的调试流程推进，不要先猜修复方案。",
        "",
        "1. 复现：确认最小复现路径、环境与频率；信息不足时先列出需要补充的输入。",
        "2. 定位：从报错、日志、最近改动和调用链收敛到具体模块。",
        "3. 假设：对每个候选根因写出可以证伪它的检查，一次只验一个变量。",
        "4. 修复：只改必要代码，说明为什么这是根因而非症状。",
        "5. 回归：补一个不带修复就会失败的测试，并运行相关检查。",
        "",
        "问题现象：",
        "复现步骤：",
        "期望行为：",
      ].join("\n"),
      en: [
        "Investigate the issue below with a verifiable debugging process. Do not guess at a fix first.",
        "",
        "1. Reproduce: smallest reliable path, environment and frequency. If information is missing, list what you need.",
        "2. Localize: converge from errors, logs, recent changes and the call chain to a specific module.",
        "3. Hypothesize: for each candidate cause, state the check that would disprove it; test one variable at a time.",
        "4. Fix: change only what the proven cause requires, and explain why it is not symptom suppression.",
        "5. Regress: add a test that fails without the fix, then run the relevant checks.",
        "",
        "Observed behavior:",
        "Steps to reproduce:",
        "Expected behavior:",
      ].join("\n"),
    },
  },
  {
    id: "test-gap",
    kind: "launch",
    policy: "instant",
    category: "quality",
    icon: TestTube2,
    mode: "chat",
    title: { zh: "补充测试", en: "Add tests" },
    description: {
      zh: "找出改动中未受保护的行为，补会失败的测试并实际运行",
      en: "Find unprotected behavior in the change, add failing-first tests and run them",
    },
    skills: [skill.tests, skill.verify],
    brief: {
      zh: [
        "为当前改动补齐有价值的测试，先找缺口，再写测试。",
        "",
        "1. 识别改动影响的行为契约与边界：空值、错误、并发、权限、迁移、序列化。",
        "2. 先读邻近测试与测试框架约定，复用现有 fixture、命名和运行方式。",
        "3. 每个新测试先确认它会因为预期原因失败；测试名说明它守护的行为。",
        "4. 避免复述实现的测试，也不要放松断言或删除既有覆盖。",
        "5. 运行最小相关测试，再运行最近的更大范围检查；记录命令与结果。",
        "6. 汇报仍未覆盖的场景，以及让它可测所需的最小改动的接入点。",
      ].join("\n"),
      en: [
        "Add the tests this change actually needs. Find the gaps before writing them.",
        "",
        "1. Identify the behavior contracts and boundaries the change affects: empty input, errors, concurrency, permissions, migrations, serialization.",
        "2. Read nearby tests and the existing framework conventions; reuse fixtures, naming and the configured runner.",
        "3. Confirm each new test fails for the intended reason first; name it after the behavior it guards.",
        "4. Do not mirror the implementation, weaken assertions or remove existing coverage.",
        "5. Run the focused test file, then the nearest broader check; record commands and results.",
        "6. Report what remains uncovered and the smallest seam that would make it testable.",
      ].join("\n"),
    },
  },
  {
    id: "release-gate",
    kind: "launch",
    policy: "instant",
    category: "deliver",
    icon: ShieldCheck,
    mode: "goal",
    featured: true,
    title: { zh: "上线前检查", en: "Release gate" },
    description: {
      zh: "组合评审、测试和验证，给出 PASS / BLOCK 结论与证据表",
      en: "Combine review, tests and verification into a PASS or BLOCK verdict with evidence",
    },
    skills: [skill.release, skill.review, skill.tests, skill.verify],
    brief: {
      zh: [
        "对当前工作区做上线前检查，给出明确的 PASS / BLOCK 结论。这是发布门禁，不是代码讲解。",
        "",
        "检查项：",
        "1. 改动范围与意图一致，无调试残留、密钥或无关改动。",
        "2. 正确性与回归风险：对照调用方、错误路径、边界与并发假设。",
        "3. 测试缺口：只在真实阻断信心时补最小测试，不为了好看堆测试。",
        "4. 实际执行：构建、类型检查、相关测试，记录命令、退出码和关键输出。",
        "5. 可运维性：配置、迁移、开关、权限与回滚路径。",
        "",
        "规则：",
        "- 未运行的检查必须标注“未验证”，不得推断为通过。",
        "- 有阻断项时结论为 BLOCK，并给出最小修复清单。",
        "- 无阻断项才给 PASS，并列出残余风险。",
        "",
        "交付：第一行给结论，随后是一页证据表（检查项 / 命令 / 结果 / 证据位置）和回滚方式。不提交、不推送、不部署。",
      ].join("\n"),
      en: [
        "Run a pre-release gate on this workspace and return an explicit PASS or BLOCK verdict. This is a gate, not a code walkthrough.",
        "",
        "Checks:",
        "1. Scope matches intent; no debug leftovers, secrets or unrelated edits.",
        "2. Correctness and regression risk against callers, error paths, boundaries and concurrency assumptions.",
        "3. Test gaps: add the smallest tests only where confidence is genuinely blocked.",
        "4. Execution: build, type-check and relevant tests, with command, exit code and decisive output.",
        "5. Operability: configuration, migrations, flags, permissions and rollback.",
        "",
        "Rules:",
        "- Any check that was not run must be marked unverified; never infer a pass.",
        "- Return BLOCK when a blocker exists and list the smallest fix set.",
        "- Return PASS only without blockers, and still list residual risk.",
        "",
        "Deliverable: verdict on the first line, then a one-page evidence table (check / command / result / location) and the rollback path. Do not commit, push or deploy.",
      ].join("\n"),
    },
  },
  {
    id: "change-digest",
    kind: "launch",
    policy: "instant",
    category: "deliver",
    icon: FileText,
    mode: "chat",
    title: { zh: "整理变更", en: "Summarize changes" },
    description: {
      zh: "从真实 diff 和已运行的检查生成提交或 PR 说明，不虚构结果",
      en: "Draft commit or PR notes from the real diff and executed checks, without inventing results",
    },
    skills: [skill.digest, skill.verify],
    brief: {
      zh: [
        "根据当前工作区的真实改动，整理可以直接用于提交或 PR 的说明。",
        "",
        "- 依据 git status、git diff 与已运行的检查，不臆造未执行的命令或结果。",
        "- 结构：变更目的 / 用户可见变化 / 关键实现取舍 / 验证证据（命令与结果）/ 风险与待验证项 / 提交信息建议（Conventional Commits）。",
        "- 指出与描述不一致的改动、调试残留或不该进入本次提交的文件。",
        "- 明确区分已验证、未运行和已过期（改动后又跑过）的检查。",
        "",
        "约束：不提交、不推送、不创建 PR。",
      ].join("\n"),
      en: [
        "Summarize the actual workspace changes into notes ready for a commit or pull request.",
        "",
        "- Use git status, git diff and executed checks only; never invent a command or result.",
        "- Structure: purpose / user-visible change / key trade-offs / verification evidence (command and result) / risks and unverified items / suggested Conventional Commits message.",
        "- Flag edits that contradict the description, debug leftovers, or files that should not ship.",
        "- Separate verified, not-run and stale checks (run before a later relevant edit).",
        "",
        "Rules: do not commit, push or open a pull request.",
      ].join("\n"),
    },
  },
  {
    id: "session-handoff",
    kind: "launch",
    policy: "instant",
    category: "deliver",
    icon: ClipboardCheck,
    mode: "chat",
    title: { zh: "交接上下文", en: "Hand off context" },
    description: {
      zh: "记录当前状态、决策、改动地图和下一步，写给没有参与会话的人",
      en: "Capture status, decisions, change map and next steps for someone who was not in this session",
    },
    skills: [skill.handoff, skill.explore],
    brief: {
      zh: [
        "为当前工作做一次可交接的收尾，让下一个人或下一个会话不用重新摸索。",
        "",
        "1. 目标与状态：完成了什么、没完成什么、当前是否可运行。",
        "2. 关键决策与理由，以及被否决的方案。",
        "3. 改动地图：涉及的文件与模块，各自作用。",
        "4. 验证证据：运行过的命令与结果；未验证项明确标注。",
        "5. 下一步：按优先级列出可执行动作和风险。",
        "",
        "把记录写入 .synax/handoff/<日期>-<简短标题>.md；写入受限时直接在回复中给出完整记录。最后给我文件路径和 5 行摘要。",
        "不要包含密钥、令牌或个人信息。",
      ].join("\n"),
      en: [
        "Close out this work with a handoff someone else can act on without rediscovery.",
        "",
        "1. Objective and status: done, not done, and whether the workspace currently runs.",
        "2. Decisions and reasons, including rejected alternatives.",
        "3. Change map: touched files and modules with one line on each role.",
        "4. Verification evidence: commands run and results; mark unverified items explicitly.",
        "5. Next actions, ordered, with risks.",
        "",
        "Write the record to .synax/handoff/<date>-<short-slug>.md; if writes are restricted, return the full record in the reply. Finish with the path and a five-line summary.",
        "Never include secrets, tokens or personal data.",
      ].join("\n"),
    },
  },
];

const SKILL_HINT = {
  zh: (labels: string[]) => `本次会话挂载的技能：${labels.join("、")}。开始前先加载对应技能，并遵循其中的流程与输出要求。`,
  en: (labels: string[]) => `Skills attached to this session: ${labels.join(", ")}. Load them before starting and follow their workflow and output requirements.`,
};

export interface QuickActionContext {
  locale: Locale;
  /** Enterprise account state; gates skills that need platform access. */
  signedIn?: boolean;
  /** Text already typed in the composer; folded into the brief instead of dropped. */
  extraContext?: string;
}

/** Skills and visibility are resolved per render so a signed-out account never mounts a gated skill. */
export function visibleQuickActions(
  actions: readonly QuickAction[],
  input: { signedIn?: boolean; category?: QuickActionCategory | "all" },
): QuickAction[] {
  return actions.filter((action) =>
    (!input.category || input.category === "all" || action.category === input.category) &&
    (!action.requiresSignIn || input.signedIn),
  );
}

/** Resolves the dock above the composer; a missing or gated action is dropped, never rendered disabled. */
export function pinnedQuickActions(
  actions: readonly QuickAction[],
  input: { signedIn?: boolean } = {},
): QuickAction[] {
  return QUICK_ACTION_PINNED_IDS
    .map((id) => actions.find((action) => action.id === id))
    .filter((action): action is QuickAction =>
      action !== undefined && (!action.requiresSignIn || Boolean(input.signedIn)));
}

export function quickActionSkills(action: QuickAction, signedIn?: boolean): QuickActionSkill[] {
  if (action.kind !== "launch") return [];
  return action.skills.filter((item) => !item.requiresSignIn || signedIn);
}

/** Appends typed text as context; the action brief stays the instruction block. */
export function appendQuickActionContext(text: string, extraContext: string | undefined, locale: Locale): string {
  const extra = extraContext?.trim();
  if (!extra) return text;
  const heading = locale === "zh" ? "## 补充上下文" : "## Additional context";
  return `${text}\n\n${heading}\n\n${extra}`;
}

export function buildQuickActionLaunch(
  action: QuickAction,
  input: Omit<QuickActionContext, "extraContext">,
): QuickActionLaunch | null {
  if (action.kind !== "launch") return null;
  const skills = quickActionSkills(action, input.signedIn);
  const skillIds = [...new Set(skills.map((item) => item.id))];
  const hint = skills.length
    ? `${SKILL_HINT[input.locale](skills.map((item) => item.label[input.locale]))}\n\n`
    : "";
  return {
    actionId: action.id,
    text: `${hint}${action.brief[input.locale]}`,
    skillIds,
    mode: action.mode,
  };
}

/**
 * Drops skills that are unavailable in this composer and rebuilds the kickoff
 * hint, so the attached text never claims a skill that will not be mounted.
 */
export function restrictQuickActionSkills(
  action: QuickAction,
  launch: QuickActionLaunch,
  locale: Locale,
  availableSkillIds: readonly string[] | undefined,
): QuickActionLaunch {
  if (!availableSkillIds || action.kind !== "launch") return launch;
  const kept = launch.skillIds.filter((id) => availableSkillIds.includes(id));
  if (kept.length === launch.skillIds.length) return launch;
  const labels = action.skills
    .filter((item) => kept.includes(item.id))
    .map((item) => item.label[locale]);
  const hint = labels.length ? `${SKILL_HINT[locale](labels)}\n\n` : "";
  return { ...launch, skillIds: kept, text: `${hint}${action.brief[locale]}` };
}

export function quickActionAttachment(
  action: QuickAction,
  launch: QuickActionLaunch,
  locale: Locale,
): QuickActionAttachment | null {
  if (action.kind !== "launch") return null;
  return {
    actionId: action.id,
    title: action.title[locale],
    text: launch.text,
    skillIds: launch.skillIds,
    mode: launch.mode,
    requiresInput: action.policy === "compose",
    hint: action.input?.hint[locale],
    placeholder: action.input?.placeholder[locale],
  };
}

export function findQuickAction(id: string, actions: readonly QuickAction[] = QUICK_ACTIONS): QuickAction | undefined {
  return actions.find((action) => action.id === id);
}
