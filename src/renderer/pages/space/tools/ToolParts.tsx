import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import {
  ChevronRightIcon,
  CopyIcon,
  GlobeIcon,
  KeyIcon,
  LayersIcon,
  MonitorIcon,
  PackageIcon,
  TerminalIcon,
} from "@/components/icons";
import { useToast } from "@/components/Toast";
import { copyPlainText } from "@/utils/clipboard";
import type { PortableMcpManifestV1 } from "../../../../shared/spaceToolManifest";
import {
  configKeyUsage,
  summarizeToolRun,
  toolMonogram,
  type ToolConfigKeyUsage,
  type ToolRunSummary,
} from "./toolPresentation";

export function ToolIcon({
  name,
  iconUrl,
  size = 40,
}: {
  name: string;
  iconUrl?: string | null;
  size?: 40 | 56;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const shape =
    size === 56 ? "h-14 w-14 rounded-2xl" : "h-10 w-10 rounded-xl";
  const frame = `grid shrink-0 place-items-center overflow-hidden border border-[var(--line)] bg-[var(--paper-elevated)] shadow-xs ${shape}`;
  if (iconUrl && failedUrl !== iconUrl) {
    return (
      <span aria-hidden className={frame}>
        <img
          src={iconUrl}
          alt=""
          draggable={false}
          onError={() => setFailedUrl(iconUrl)}
          className="h-full w-full object-cover"
        />
      </span>
    );
  }
  const monogram = toolMonogram(name);
  return (
    <span
      aria-hidden
      style={{ color: monogram.color }}
      className={`${frame} font-semibold ${size === 56 ? "text-xl" : "text-base"}`}
    >
      {monogram.character}
    </span>
  );
}

export function ToolKindTag({ kind }: { kind: "mcp" | "custom_install_prompt" }) {
  const { t } = useTranslation("app");
  return (
    <span className="shrink-0 rounded-md bg-[var(--paper-inset)] px-1.5 py-0.5 text-xs font-semibold text-[var(--ink-muted)]">
      {kind === "mcp" ? t("space.tools.kindMcp") : t("space.tools.kindGeneral")}
    </span>
  );
}

/** One "icon + primary line + secondary line" row used across detail sections. */
export function ToolInfoRow({
  icon,
  title,
  subtitle,
  mono = false,
  hint,
}: {
  icon: ReactNode;
  title: string;
  subtitle: string;
  mono?: boolean;
  hint?: string;
}) {
  return (
    <div className="grid grid-cols-[32px_minmax(0,1fr)] items-center gap-3 py-2" title={hint}>
      <span className="grid h-8 w-8 place-items-center rounded-lg border border-[var(--line-subtle)] bg-[var(--paper)] text-[var(--ink-muted)]">
        {icon}
      </span>
      <span className="min-w-0">
        <span
          className={`block truncate text-sm text-[var(--ink)] ${mono ? "font-mono" : "font-semibold"}`}
        >
          {title}
        </span>
        <span className="mt-0.5 block text-xs text-[var(--ink-muted)]">
          {subtitle}
        </span>
      </span>
    </div>
  );
}

export function ToolSection({
  title,
  hint,
  action,
  children,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="mt-7">
      <h3 className="mb-1 flex items-baseline gap-2.5 text-sm font-semibold text-[var(--ink)]">
        <span className="shrink-0">{title}</span>
        {hint ? (
          <span className="min-w-0 text-xs font-normal text-[var(--ink-subtle)]">
            {hint}
          </span>
        ) : null}
        {action ? <span className="ml-auto self-center">{action}</span> : null}
      </h3>
      {children}
    </section>
  );
}

function runIcon(summary: ToolRunSummary) {
  const className = "h-3.5 w-3.5";
  switch (summary.kind) {
    case "remote":
      return <GlobeIcon className={className} />;
    case "localService":
      return <MonitorIcon className={className} />;
    case "package":
      return <PackageIcon className={className} />;
    case "docker":
      return <LayersIcon className={className} />;
    default:
      return <TerminalIcon className={className} />;
  }
}

export function useRunSummaryText() {
  const { t } = useTranslation("app");
  return (summary: ToolRunSummary): { title: string; subtitle: string; mono: boolean } => {
    switch (summary.kind) {
      case "remote":
        return {
          title: summary.host,
          subtitle: t("space.tools.runRemote", {
            transport: summary.transport.toUpperCase(),
          }),
          mono: true,
        };
      case "localService":
        return {
          title: t("space.tools.runLocalTitle", { port: summary.port }),
          subtitle: t("space.tools.runLocalDetail", {
            transport: summary.transport.toUpperCase(),
          }),
          mono: false,
        };
      case "package":
        return {
          title: summary.packageName,
          subtitle: summary.runtime
            ? t("space.tools.runPackageRuntime", {
                runner: summary.runner,
                runtime: summary.runtime,
              })
            : t("space.tools.runPackage", { runner: summary.runner }),
          mono: true,
        };
      case "docker":
        return { title: summary.image, subtitle: t("space.tools.runDocker"), mono: true };
      default:
        return {
          title: summary.command,
          subtitle: t("space.tools.runCommand", { command: summary.command }),
          mono: true,
        };
    }
  };
}

function useKeyUsageText() {
  const { t } = useTranslation("app");
  return (usage: ToolConfigKeyUsage): string => {
    switch (usage.kind) {
      case "header":
        return t("space.tools.keyHeader", { name: usage.name });
      case "env":
        return t("space.tools.keyEnv");
      case "url":
        return t("space.tools.keyUrl");
      default:
        return t("space.tools.keyArgument");
    }
  };
}

/** "运行方式" + "需要填写": the MCP body shared by the member detail and the publish preview. */
export function McpToolBody({
  manifest,
  keysHint,
}: {
  manifest: PortableMcpManifestV1;
  keysHint: string;
}) {
  const { t } = useTranslation("app");
  const runText = useRunSummaryText();
  const keyText = useKeyUsageText();
  const summary = summarizeToolRun(manifest);
  const run = runText(summary);
  return (
    <>
      <ToolSection title={t("space.tools.runTitle")}>
        <ToolInfoRow
          icon={runIcon(summary)}
          title={run.title}
          subtitle={run.subtitle}
          mono={run.mono}
          hint={summary.full}
        />
      </ToolSection>
      {manifest.requiredConfigKeys.length ? (
        <ToolSection title={t("space.tools.keysTitle")} hint={keysHint}>
          {manifest.requiredConfigKeys.map((key) => (
            <ToolInfoRow
              key={key}
              icon={<KeyIcon className="h-3.5 w-3.5" />}
              title={key}
              subtitle={keyText(configKeyUsage(manifest, key))}
              mono
            />
          ))}
        </ToolSection>
      ) : null}
    </>
  );
}

/** Copy button that confirms in place, per DESIGN §4.1. */
export function CopyButton({ text }: { text: string }) {
  const { t } = useTranslation("app");
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );
  return (
    <button
      type="button"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void copyPlainText(text)
          .then(() => {
            setCopied(true);
            if (timer.current !== null) window.clearTimeout(timer.current);
            timer.current = window.setTimeout(() => setCopied(false), 1600);
          })
          .catch(() => toast.error(t("space.tools.copyFailed")));
      }}
      className="inline-flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs font-semibold text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
    >
      <CopyIcon className="h-3.5 w-3.5" />
      {copied ? t("space.tools.copied") : t("space.tools.copy")}
    </button>
  );
}

/** Folded "完整配置": read-only JSON for members, optional editor for publishers. */
export function RawConfigDisclosure({
  manifest,
  open,
  onToggle,
  children,
}: {
  manifest: PortableMcpManifestV1;
  open: boolean;
  onToggle: () => void;
  /** Replaces the read-only JSON when the publisher edits it. */
  children?: ReactNode;
}) {
  const { t } = useTranslation("app");
  const json = JSON.stringify(manifest, null, 2);
  return (
    <section className="mt-6">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="inline-flex items-center gap-1.5 text-xs font-semibold text-[var(--ink-subtle)] transition-colors hover:text-[var(--ink-muted)]"
      >
        <ChevronRightIcon
          className={`h-3 w-3 transition-transform ${open ? "rotate-90" : ""}`}
        />
        {t("space.tools.rawConfig")}
      </button>
      {open ? (
        children ?? (
          <div className="relative mt-2.5 rounded-xl bg-[var(--paper)]">
            <span className="absolute right-2 top-2">
              <CopyButton text={json} />
            </span>
            <pre className="max-h-80 overflow-auto p-4 pr-20 font-mono text-xs leading-5 text-[var(--ink-secondary)]">
              <code>{json}</code>
            </pre>
          </div>
        )
      ) : null}
    </section>
  );
}
