import type { LandingLanguage } from "./language.js";

export type Copy = {
  title: string;
  description: string;
  brand: string;
  navHow: string;
  navSetup: string;
  navGithub: string;
  languageEn: string;
  languageZh: string;
  eyebrow: string;
  heroTitleStart: string;
  heroTitleAccent: string;
  heroBody: string;
  badgeAccount: string;
  badgeExpiry: string;
  badgeSource: string;
  toolKicker: string;
  toolTitle: string;
  toolBody: string;
  keyLabel: string;
  keyEmpty: string;
  generate: string;
  regenerate: string;
  copyKey: string;
  copied: string;
  retainNote: string;
  regenerateNote: string;
  localOnly: string;
  flowFrom: string;
  flowFromBody: string;
  flowCode: string;
  flowCodeBody: string;
  flowTo: string;
  flowToBody: string;
  howKicker: string;
  howTitle: string;
  step1Title: string;
  step1Body: string;
  step2Title: string;
  step2Body: string;
  step3Title: string;
  step3Body: string;
  setupKicker: string;
  setupTitle: string;
  setupBody: string;
  bearerTab: string;
  bearerLabel: string;
  bearerNote: string;
  queryTab: string;
  queryLabel: string;
  queryNote: string;
  configLocked: string;
  copyConfig: string;
  clientGuidePrompt: string;
  clientGuideLink: string;
  nextHeading: string;
  nextBody: string;
  nextLink: string;
  guideKicker: string;
  guideTitle: string;
  guideBody: string;
  trustKicker: string;
  trustTitle: string;
  privacyTitle: string;
  privacyBody: string;
  revisionsTitle: string;
  revisionsBody: string;
  opensourceTitle: string;
  opensourceBody: string;
  boundariesTitle: string;
  boundariesBody: string;
  footerTagline: string;
  footerRepo: string;
};

export const COPY: Record<LandingLanguage, Copy> = {
  en: {
    title: "TaskDrop — move AI work without starting over",
    description: "A temporary, versioned handoff layer for AI clients. No account required.",
    brand: "TaskDrop",
    navHow: "How it works",
    navSetup: "Install Skill",
    navGithub: "GitHub",
    languageEn: "EN",
    languageZh: "中文",
    eyebrow: "A handoff layer for AI work",
    heroTitleStart: "Drop context.",
    heroTitleAccent: "Pick it up anywhere.",
    heroBody:
      "Move a complete working checkpoint between AI clients with a short Handoff Code — without an account, a shared drive, or starting the conversation over.",
    badgeAccount: "No account",
    badgeExpiry: "Auto-expires",
    badgeSource: "Open source",
    toolKicker: "Start here",
    toolTitle: "Create your private Space",
    toolBody:
      "Generate a Space Key in this browser. Configure it once in each MCP client, then move work with short Handoff Codes.",
    keyLabel: "Your Space Key",
    keyEmpty: "Generated locally when you click the button",
    generate: "Generate Space Key",
    regenerate: "Generate a new Key",
    copyKey: "Copy Key",
    copied: "Copied",
    retainNote:
      "Save the exact Key in a password manager. This page never stores it, and a reload cannot bring it back.",
    regenerateNote:
      "A new Key opens a different Space. It does not recover, reset, or rotate the previous one.",
    localOnly: "Local-only generation",
    flowFrom: "DROP",
    flowFromBody: "An AI client saves a complete Markdown checkpoint.",
    flowCode: "HANDOFF",
    flowCodeBody: "A short Code points to an immutable Revision.",
    flowTo: "PICK UP",
    flowToBody: "Another client loads the work and continues.",
    howKicker: "One small loop",
    howTitle: "Move the work, not the whole conversation",
    step1Title: "Ask an agent to create a Handoff",
    step1Body: "TaskDrop stores a complete Markdown checkpoint inside your private Space.",
    step2Title: "Carry the short Code",
    step2Body: "The Handoff Code locates the work. Your Space Key stays configured in the client.",
    step3Title: "Continue in another client",
    step3Body: "Load the latest Revision, keep working, and append a new snapshot when ready.",
    setupKicker: "MCP setup",
    setupTitle: "Configure once. Then just use the Code.",
    setupBody:
      "Generate a Space Key above, then copy the connection fields your MCP client supports.",
    bearerTab: "Bearer",
    bearerLabel: "Recommended",
    bearerNote: "Use when your client can send an Authorization header.",
    queryTab: "Query URL",
    queryLabel: "Compatibility",
    queryNote: "Use only when headers are unavailable. The complete URL is a credential.",
    configLocked: "Generate a Space Key above to create your private configuration.",
    copyConfig: "Copy config",
    clientGuidePrompt: "Using a specific MCP client?",
    clientGuideLink: "View setup for Codex, Claude Code, WorkBuddy, Cursor, and more",
    nextHeading: "Install the TaskDrop Skill",
    nextBody:
      "The MCP connection moves data. The Skill teaches an AI client how to create, load, and update a Handoff.",
    nextLink: "Read the Skill installation guide",
    guideKicker: "Agent workflow",
    guideTitle: "Give your AI client the TaskDrop Skill",
    guideBody:
      "Once MCP is connected, install the Skill so your agent knows the complete create, load, and update workflow.",
    trustKicker: "Built for temporary work",
    trustTitle: "Clear boundaries, by design",
    privacyTitle: "Private Space",
    privacyBody:
      "No account. Your browser generates the bearer credential and never sends or persists it from this page.",
    revisionsTitle: "Immutable Revisions",
    revisionsBody:
      "Updates append complete snapshots. Older Revisions stay unchanged, and concurrent changes cannot silently overwrite each other.",
    opensourceTitle: "Open source",
    opensourceBody:
      "The server, Space Key format, and complete TaskDrop Skill are available in the public repository.",
    boundariesTitle: "Temporary means temporary",
    boundariesBody:
      "Every Handoff expires after the service Retention Window. Reads do not extend it. Lost Space Keys and expired Handoffs cannot be recovered. TaskDrop removes its own Space Key format from Handoff Markdown, but it is not a general secret scanner.",
    footerTagline: "Continue the work, wherever the next agent lives.",
    footerRepo: "View source on GitHub",
  },
  zh: {
    title: "TaskDrop — 换个 AI，工作不用重来",
    description: "在 AI 客户端之间传递临时、带版本的工作上下文。无需账号。",
    brand: "TaskDrop",
    navHow: "工作方式",
    navSetup: "安装 Skill",
    navGithub: "GitHub",
    languageEn: "EN",
    languageZh: "中文",
    eyebrow: "AI 工作的交接层",
    heroTitleStart: "把上下文放下。",
    heroTitleAccent: "在任何地方接着做。",
    heroBody:
      "用一个简短的 Handoff Code，在 AI 客户端之间移动完整的工作检查点——无需账号、共享网盘，也不用从头解释对话。",
    badgeAccount: "无需账号",
    badgeExpiry: "自动过期",
    badgeSource: "开放源码",
    toolKicker: "从这里开始",
    toolTitle: "创建你的私有 Space",
    toolBody:
      "在这个浏览器中生成 Space Key。只需在每个 MCP 客户端配置一次，之后就用短 Handoff Code 搬工作。",
    keyLabel: "你的 Space Key",
    keyEmpty: "点击按钮后，仅在本地生成",
    generate: "生成 Space Key",
    regenerate: "生成一把新 Key",
    copyKey: "复制 Key",
    copied: "已复制",
    retainNote: "请把 Key 的确切拼写存进密码管理器。本页不会保存它，刷新后也无法找回。",
    regenerateNote: "新 Key 会进入另一个 Space；它不会找回、重置或轮换原来的 Space。",
    localOnly: "仅本地生成",
    flowFrom: "放下",
    flowFromBody: "一个 AI 客户端保存完整的 Markdown 工作检查点。",
    flowCode: "交接",
    flowCodeBody: "短 Code 指向一份不可变的 Revision。",
    flowTo: "接手",
    flowToBody: "另一个客户端加载工作并继续推进。",
    howKicker: "一个很小的闭环",
    howTitle: "搬走工作，不必搬走整段对话",
    step1Title: "让 Agent 创建 Handoff",
    step1Body: "TaskDrop 把完整的 Markdown 检查点存进你的私有 Space。",
    step2Title: "只带走短 Code",
    step2Body: "Handoff Code 用于定位工作；Space Key 留在客户端配置中。",
    step3Title: "在另一个客户端继续",
    step3Body: "加载最新 Revision，继续工作，并在合适时追加一份新快照。",
    setupKicker: "MCP 配置",
    setupTitle: "配置一次，之后只管用 Code",
    setupBody: "先在上方生成 Space Key，再复制你的 MCP 客户端支持的连接字段。",
    bearerTab: "Bearer",
    bearerLabel: "推荐",
    bearerNote: "客户端能发送 Authorization 请求头时使用。",
    queryTab: "Query URL",
    queryLabel: "兼容模式",
    queryNote: "仅在无法发送请求头时使用。完整 URL 本身就是凭证。",
    configLocked: "请先在上方生成 Space Key，以创建你的私有配置。",
    copyConfig: "复制配置",
    clientGuidePrompt: "正在使用特定的 MCP 客户端？",
    clientGuideLink: "查看 Codex、Claude Code、WorkBuddy、Cursor 等客户端配置",
    nextHeading: "安装 TaskDrop Skill",
    nextBody: "MCP 连接负责搬数据；Skill 教 AI 客户端如何创建、读取和更新 Handoff。",
    nextLink: "阅读 Skill 安装指南",
    guideKicker: "Agent 工作流",
    guideTitle: "让你的 AI 客户端学会 TaskDrop",
    guideBody: "连接 MCP 后安装 Skill，让 Agent 掌握创建、读取和更新 Handoff 的完整流程。",
    trustKicker: "为临时工作而生",
    trustTitle: "边界清楚，是设计的一部分",
    privacyTitle: "私有 Space",
    privacyBody: "无需账号。浏览器生成 bearer 凭证，本页既不会发送，也不会持久化保存。",
    revisionsTitle: "不可变 Revision",
    revisionsBody: "更新会追加完整快照。旧版本保持不变，并发修改也不会被静默覆盖。",
    opensourceTitle: "开放源码",
    opensourceBody: "服务端、Space Key 格式和完整的 TaskDrop Skill 都在公开仓库中。",
    boundariesTitle: "临时，就真的有期限",
    boundariesBody:
      "每个 Handoff 都会在服务的 Retention Window 后过期，读取不会续期。丢失的 Space Key 和过期的 Handoff 无法恢复。TaskDrop 会从 Handoff Markdown 中移除自身的 Space Key 格式，但它不是通用密钥扫描器。",
    footerTagline: "下一个 Agent 在哪里，工作就从哪里继续。",
    footerRepo: "在 GitHub 查看源码",
  },
};
