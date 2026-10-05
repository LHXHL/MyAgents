import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";

import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CloseIcon,
  ImageIcon,
  LoaderIcon,
} from "@/components/icons";
import {
  spaceErrorMessage,
  type SpaceTool,
  type SpaceToolDetail,
} from "@/api/spaceCloud";
import OverlayBackdrop from "@/components/OverlayBackdrop";
import { useToast } from "@/components/Toast";
import type { AppConfig, McpServerDefinition } from "@/config/types";
import { useWorkspaceFileService } from "@/hooks/useWorkspaceFileService";
import { isImeComposingEvent } from "@/utils/imeKeyboard";
import {
  RESERVED_SPACE_MCP_SERVER_IDS,
  SpaceMcpPolicyError,
  analyzeSpaceMcpCandidate,
  validatePortableMcpManifest,
  type PortableMcpManifestV1,
  type SpaceMcpPolicyResult,
} from "../../../../shared/spaceToolManifest";
import { McpToolBody, RawConfigDisclosure, ToolIcon, useRunSummaryText } from "./ToolParts";
import { summarizeToolRun } from "./toolPresentation";

export type ToolPublishMode = "mcp" | "custom";

export type ToolIconInput = {
  iconFilePath: string | null;
  resetIcon: boolean;
};

export type McpPublishInput = ToolIconInput & {
  name: string;
  description: string;
  portableMcpManifest: PortableMcpManifestV1;
};

export type CustomPublishInput = ToolIconInput & {
  name: string;
  description: string;
  instruction: string;
};

type McpCandidate = {
  server: McpServerDefinition;
  policy: SpaceMcpPolicyResult;
};

const fieldTitleClass =
  "w-full rounded-lg bg-transparent px-2 -ml-2 text-xl font-semibold text-[var(--ink)] outline-none transition-colors placeholder:text-[var(--ink-faint)] hover:bg-[var(--hover-bg)] focus:bg-[var(--paper)] focus:ring-1 focus:ring-[var(--line-strong)]";
const fieldSubClass =
  "mt-0.5 w-full resize-none rounded-lg bg-transparent px-2 py-0.5 -ml-2 text-sm leading-6 text-[var(--ink-muted)] outline-none transition-colors placeholder:text-[var(--ink-faint)] hover:bg-[var(--hover-bg)] focus:bg-[var(--paper)] focus:ring-1 focus:ring-[var(--line-strong)]";

function EditableToolHero({
  name,
  description,
  iconUrl,
  onNameChange,
  onDescriptionChange,
  onIconChange,
  onResetIcon,
  showErrors,
  onBlurField,
}: {
  name: string;
  description: string;
  iconUrl: string | null;
  onNameChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
  onIconChange: (path: string, preview: string) => void;
  onResetIcon: (() => void) | null;
  showErrors: { name: boolean; description: boolean };
  onBlurField: (field: "name" | "description") => void;
}) {
  const { t } = useTranslation("app");
  const toast = useToast();
  const fileService = useWorkspaceFileService(null);
  const pickIcon = async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [
        { name: t("space.tools.icon"), extensions: ["png", "jpg", "jpeg", "webp"] },
      ],
    });
    if (!selected || Array.isArray(selected)) return;
    try {
      const preview = await fileService.readPathsAsBase64({ paths: [selected] });
      const file = preview.files[0];
      if (!file || file.error) {
        throw new Error(file?.error || t("space.tools.iconPreviewFailed"));
      }
      onIconChange(selected, `data:${file.mimeType};base64,${file.data}`);
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    }
  };
  return (
    <div className="grid grid-cols-[56px_minmax(0,1fr)] items-start gap-4">
      <div className="flex flex-col items-center gap-1">
        <button
          type="button"
          onClick={() => void pickIcon()}
          aria-label={t("space.tools.chooseIcon")}
          className="group relative rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-warm)]"
        >
          {name.trim() || iconUrl ? (
            <ToolIcon name={name || "?"} iconUrl={iconUrl} size={56} />
          ) : (
            <span className="grid h-14 w-14 place-items-center rounded-2xl border border-dashed border-[var(--line-strong)] text-[var(--ink-subtle)]">
              <ImageIcon className="h-4 w-4" />
            </span>
          )}
          <span className="absolute inset-0 grid place-items-center rounded-2xl bg-black/45 text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
            <ImageIcon className="h-4 w-4" />
          </span>
        </button>
        {onResetIcon ? (
          <button
            type="button"
            onClick={onResetIcon}
            className="text-xs text-[var(--ink-subtle)] hover:text-[var(--ink-muted)]"
          >
            {t("space.tools.resetIcon")}
          </button>
        ) : null}
      </div>
      <div className="min-w-0">
        <input
          value={name}
          maxLength={100}
          aria-label={t("space.tools.name")}
          aria-invalid={showErrors.name && !name.trim()}
          placeholder={t("space.tools.name")}
          onChange={(event) => onNameChange(event.target.value)}
          onBlur={() => onBlurField("name")}
          className={`h-9 ${fieldTitleClass}`}
        />
        {showErrors.name && !name.trim() ? (
          <p className="mt-0.5 text-xs text-[var(--error)]">
            {t("space.tools.nameRequired")}
          </p>
        ) : null}
        <textarea
          value={description}
          rows={2}
          maxLength={1000}
          aria-label={t("space.tools.description")}
          aria-invalid={showErrors.description && !description.trim()}
          placeholder={t("space.tools.descriptionPlaceholder")}
          onChange={(event) => onDescriptionChange(event.target.value)}
          onBlur={() => onBlurField("description")}
          className={fieldSubClass}
        />
        {showErrors.description && !description.trim() ? (
          <p className="text-xs text-[var(--error)]">
            {t("space.tools.descriptionRequired")}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function useIconState(initialUrl: string | null) {
  const [iconFilePath, setIconFilePath] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(initialUrl);
  const [resetIcon, setResetIcon] = useState(false);
  return {
    iconFilePath,
    resetIcon,
    iconUrl: resetIcon ? null : preview,
    canReset: Boolean(initialUrl) && !resetIcon,
    change(path: string, nextPreview: string) {
      setIconFilePath(path);
      setPreview(nextPreview);
      setResetIcon(false);
    },
    reset() {
      setIconFilePath(null);
      setPreview(null);
      setResetIcon(true);
    },
  };
}

function McpCandidateList({
  config,
  tools,
  onPick,
}: {
  config: AppConfig;
  tools: SpaceTool[];
  onPick: (candidate: McpCandidate) => void;
}) {
  const { t } = useTranslation("app");
  const runText = useRunSummaryText();
  const candidates = useMemo<McpCandidate[]>(
    () =>
      (config.mcpServers ?? [])
        .filter(
          (server) =>
            server.isBuiltin !== true && !RESERVED_SPACE_MCP_SERVER_IDS.has(server.id),
        )
        .map((server) => ({ server, policy: analyzeSpaceMcpCandidate(server, config) })),
    [config],
  );
  const published = new Map(
    tools.filter((tool) => tool.kind === "mcp" && tool.mcpServerId).map((tool) => [tool.mcpServerId!, tool]),
  );
  if (!candidates.length) {
    return (
      <div className="grid min-h-48 place-items-center text-sm text-[var(--ink-muted)]">
        {t("space.tools.noLocalMcp")}
      </div>
    );
  }
  return (
    <>
      <p className="mb-3 text-sm leading-6 text-[var(--ink-muted)]">
        {t("space.tools.mcpPickHint")}
      </p>
      <div className="grid">
        {candidates.map((candidate) => {
          const { server, policy } = candidate;
          const blocked = policy.status === "blocked" || !policy.manifest;
          const existing = published.get(server.id);
          const run = policy.manifest ? runText(summarizeToolRun(policy.manifest)) : null;
          return (
            <button
              key={server.id}
              type="button"
              disabled={blocked}
              onClick={() => onPick(candidate)}
              className="-mx-2.5 grid grid-cols-[40px_minmax(0,1fr)_auto] items-center gap-3.5 rounded-xl px-2.5 py-2.5 text-left transition-colors hover:bg-[var(--hover-bg)] disabled:cursor-not-allowed disabled:hover:bg-transparent"
            >
              <span className={blocked ? "opacity-55" : ""}>
                <ToolIcon name={server.name || server.id} />
              </span>
              <span className="min-w-0">
                <span
                  className={`block truncate text-sm font-semibold ${blocked ? "text-[var(--ink-muted)]" : "text-[var(--ink)]"}`}
                >
                  {server.name || server.id}
                </span>
                <span
                  className={`mt-0.5 block truncate text-xs ${blocked ? "text-[var(--error)]" : "text-[var(--ink-muted)]"}`}
                >
                  {blocked
                    ? policy.codes.map((code) => t(`space.tools.policy.${code}`)).join("；")
                    : `${run!.title} · ${run!.subtitle}`}
                </span>
              </span>
              <span className="flex items-center gap-2 text-xs font-semibold">
                {blocked ? (
                  <span className="text-[var(--error)]">{t("space.tools.candidateBlocked")}</span>
                ) : existing ? (
                  <span className="text-[var(--ink-subtle)]">
                    {t("space.tools.candidateUpdate", {
                      revision: existing.latestRevision + 1,
                    })}
                  </span>
                ) : null}
                {blocked ? null : (
                  <ChevronRightIcon className="h-4 w-4 text-[var(--ink-faint)]" />
                )}
              </span>
            </button>
          );
        })}
      </div>
    </>
  );
}

function parseManifestDraft(
  text: string,
  expectedServerId: string,
  t: (key: string) => string,
): { manifest: PortableMcpManifestV1 | null; error: string | null } {
  try {
    const manifest = validatePortableMcpManifest(JSON.parse(text));
    if (manifest.serverId !== expectedServerId) {
      return { manifest: null, error: t("space.tools.mcpServerIdImmutable") };
    }
    return { manifest, error: null };
  } catch (error) {
    if (error instanceof SpaceMcpPolicyError) {
      return { manifest: null, error: t(`space.tools.policy.${error.code}`) };
    }
    return { manifest: null, error: t("space.tools.mcpJsonInvalid") };
  }
}

function McpForm({
  baseManifest,
  initialName,
  initialDescription,
  initialIconUrl,
  existingTool,
  platformWarning,
  keysHint,
  busy,
  submitLabel,
  onBack,
  onCancel,
  onSubmit,
}: {
  baseManifest: PortableMcpManifestV1;
  initialName: string;
  initialDescription: string;
  initialIconUrl: string | null;
  existingTool: SpaceTool | null;
  platformWarning: boolean;
  keysHint: string;
  busy: boolean;
  submitLabel: string;
  onBack: (() => void) | null;
  onCancel: () => void;
  onSubmit: (input: McpPublishInput) => void;
}) {
  const { t } = useTranslation("app");
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  const icon = useIconState(initialIconUrl);
  const [rawOpen, setRawOpen] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [touched, setTouched] = useState({ name: false, description: false });
  const parsed = useMemo(
    () =>
      draft === null
        ? { manifest: baseManifest, error: null }
        : parseManifestDraft(draft, baseManifest.serverId, t),
    [baseManifest, draft, t],
  );
  const manifest = parsed.manifest ?? baseManifest;
  const valid = Boolean(name.trim() && description.trim() && parsed.manifest);
  return (
    <DialogFrameBody
      footer={
        <>
          {onBack ? (
            <button
              type="button"
              disabled={busy}
              onClick={onBack}
              className="inline-flex h-9 items-center gap-1 rounded-lg px-2.5 text-sm font-semibold text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
            >
              <ChevronLeftIcon className="h-4 w-4" />
              {t("space.tools.reselect")}
            </button>
          ) : null}
          <span className="flex-1" />
          <FooterActions
            busy={busy}
            submitLabel={submitLabel}
            onCancel={onCancel}
            onSubmit={() => {
              if (!valid || !parsed.manifest) return;
              onSubmit({
                name: name.trim(),
                description: description.trim(),
                portableMcpManifest: parsed.manifest,
                iconFilePath: icon.iconFilePath,
                resetIcon: icon.resetIcon,
              });
            }}
            submitDisabled={!valid}
          />
        </>
      }
    >
      <EditableToolHero
        name={name}
        description={description}
        iconUrl={icon.iconUrl}
        onNameChange={setName}
        onDescriptionChange={setDescription}
        onIconChange={icon.change}
        onResetIcon={icon.canReset ? icon.reset : null}
        showErrors={touched}
        onBlurField={(field) => setTouched((value) => ({ ...value, [field]: true }))}
      />
      {existingTool ? (
        <p className="ml-[72px] mt-3 text-xs text-[var(--ink-muted)]">
          {t("space.tools.existingNotice", {
            name: existingTool.name,
            revision: existingTool.latestRevision + 1,
          })}
        </p>
      ) : null}
      <McpToolBody manifest={manifest} keysHint={keysHint} />
      {platformWarning ? (
        <p className="mt-3 text-xs font-semibold text-[var(--warning)]">
          {t("space.tools.policy.platform_dependency")}
        </p>
      ) : null}
      <RawConfigDisclosure
        manifest={manifest}
        open={rawOpen}
        onToggle={() => setRawOpen((open) => !open)}
      >
        <div className="mt-2.5">
          <textarea
            value={draft ?? JSON.stringify(baseManifest, null, 2)}
            rows={12}
            spellCheck={false}
            aria-label={t("space.tools.mcpConfiguration")}
            aria-invalid={Boolean(parsed.error)}
            onChange={(event) => setDraft(event.target.value)}
            className="block w-full resize-y rounded-xl bg-[var(--paper)] p-4 font-mono text-xs leading-5 text-[var(--ink-secondary)] outline-none focus:ring-1 focus:ring-[var(--line-strong)]"
          />
          <p className="mt-2 text-xs text-[var(--ink-subtle)]">
            {t("space.tools.mcpConfigurationEditHelp")}
          </p>
          {parsed.error ? (
            <p className="mt-1 text-xs text-[var(--error)]">{parsed.error}</p>
          ) : null}
        </div>
      </RawConfigDisclosure>
    </DialogFrameBody>
  );
}

function CustomForm({
  initialName,
  initialDescription,
  initialInstruction,
  initialIconUrl,
  busy,
  submitLabel,
  onCancel,
  onSubmit,
}: {
  initialName: string;
  initialDescription: string;
  initialInstruction: string;
  initialIconUrl: string | null;
  busy: boolean;
  submitLabel: string;
  onCancel: () => void;
  onSubmit: (input: CustomPublishInput) => void;
}) {
  const { t } = useTranslation("app");
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  const [instruction, setInstruction] = useState(initialInstruction);
  const icon = useIconState(initialIconUrl);
  const [touched, setTouched] = useState({
    name: false,
    description: false,
    instruction: false,
  });
  const valid = Boolean(name.trim() && description.trim() && instruction.trim());
  return (
    <DialogFrameBody
      footer={
        <>
          <span className="flex-1" />
          <FooterActions
            busy={busy}
            submitLabel={submitLabel}
            onCancel={onCancel}
            onSubmit={() => {
              if (!valid) return;
              onSubmit({
                name: name.trim(),
                description: description.trim(),
                instruction,
                iconFilePath: icon.iconFilePath,
                resetIcon: icon.resetIcon,
              });
            }}
            submitDisabled={!valid}
          />
        </>
      }
    >
      <EditableToolHero
        name={name}
        description={description}
        iconUrl={icon.iconUrl}
        onNameChange={setName}
        onDescriptionChange={setDescription}
        onIconChange={icon.change}
        onResetIcon={icon.canReset ? icon.reset : null}
        showErrors={touched}
        onBlurField={(field) => setTouched((value) => ({ ...value, [field]: true }))}
      />
      <section className="mt-7">
        <h3 className="mb-1.5 flex items-baseline gap-2.5 text-sm font-semibold text-[var(--ink)]">
          {t("space.tools.instructionTitle")}
          <span className="text-xs font-normal text-[var(--ink-subtle)]">
            {t("space.tools.instructionHint")}
          </span>
        </h3>
        <textarea
          value={instruction}
          rows={10}
          maxLength={20_000}
          aria-label={t("space.tools.instructionTitle")}
          aria-invalid={touched.instruction && !instruction.trim()}
          placeholder={t("space.tools.installInstructionPlaceholder")}
          onChange={(event) => setInstruction(event.target.value)}
          onBlur={() => setTouched((value) => ({ ...value, instruction: true }))}
          className="block min-h-56 w-full resize-y rounded-xl bg-[var(--paper)] p-4 font-mono text-sm leading-6 text-[var(--ink)] outline-none placeholder:font-sans placeholder:text-[var(--ink-faint)] focus:ring-1 focus:ring-[var(--line-strong)]"
        />
        {touched.instruction && !instruction.trim() ? (
          <p className="mt-1 text-xs text-[var(--error)]">
            {t("space.tools.instructionRequired")}
          </p>
        ) : null}
        <p className="mt-2 text-xs leading-5 text-[var(--ink-subtle)]">
          {t("space.tools.instructionFooter")}
        </p>
      </section>
    </DialogFrameBody>
  );
}

function FooterActions({
  busy,
  submitLabel,
  submitDisabled,
  onCancel,
  onSubmit,
}: {
  busy: boolean;
  submitLabel: string;
  submitDisabled: boolean;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const { t } = useTranslation("app");
  return (
    <>
      <button
        type="button"
        onClick={onCancel}
        disabled={busy}
        className="h-9 rounded-lg px-3 text-sm font-semibold text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] disabled:opacity-50"
      >
        {t("space.common.cancel")}
      </button>
      <button
        type="button"
        disabled={busy || submitDisabled}
        onClick={onSubmit}
        className="flex h-9 items-center gap-2 rounded-xl bg-[var(--button-primary-bg)] px-4 text-sm font-semibold text-[var(--button-primary-text)] shadow-sm transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:cursor-not-allowed disabled:opacity-60"
      >
        {busy ? <LoaderIcon className="h-4 w-4 animate-spin" /> : null}
        {submitLabel}
      </button>
    </>
  );
}

function DialogFrameBody({
  children,
  footer,
}: {
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <>
      <div className="min-h-0 overflow-y-auto px-8 pb-7 pt-5 max-sm:px-5">{children}</div>
      <footer className="flex items-center gap-2 px-5 pb-5 pt-3">{footer}</footer>
    </>
  );
}

export function ToolPublishDialog({
  mode,
  editing,
  config,
  tools,
  busy,
  onModeChange,
  onClose,
  onSubmitMcp,
  onSubmitCustom,
}: {
  mode: ToolPublishMode;
  /** Present when editing an existing tool; the kind is then fixed. */
  editing: SpaceToolDetail | null;
  config: AppConfig;
  tools: SpaceTool[];
  busy: boolean;
  onModeChange: (mode: ToolPublishMode) => void;
  onClose: () => void;
  onSubmitMcp: (input: McpPublishInput) => void;
  onSubmitCustom: (input: CustomPublishInput) => void;
}) {
  const { t } = useTranslation("app");
  const [candidate, setCandidate] = useState<McpCandidate | null>(null);
  const containerRef = useRef<HTMLElement | null>(null);
  const close = () => {
    if (!busy) onClose();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || isImeComposingEvent(event)) return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };

  useEffect(() => {
    containerRef.current?.focus();
  }, []);

  let body: ReactNode;
  if (editing) {
    const revision = editing.revision;
    const nextRevision = editing.tool.latestRevision + 1;
    const submitLabel = t("space.tools.publishRevision", { revision: nextRevision });
    body =
      editing.tool.kind === "mcp" && revision.portableMcpManifest ? (
        <McpForm
          baseManifest={revision.portableMcpManifest}
          initialName={revision.name}
          initialDescription={revision.description ?? ""}
          initialIconUrl={revision.iconUrl ?? null}
          existingTool={null}
          platformWarning={false}
          keysHint={t("space.tools.keysEditHint")}
          busy={busy}
          submitLabel={submitLabel}
          onBack={null}
          onCancel={close}
          onSubmit={onSubmitMcp}
        />
      ) : (
        <CustomForm
          initialName={revision.name}
          initialDescription={revision.description ?? ""}
          initialInstruction={revision.customInstallInstruction ?? ""}
          initialIconUrl={revision.iconUrl ?? null}
          busy={busy}
          submitLabel={submitLabel}
          onCancel={close}
          onSubmit={onSubmitCustom}
        />
      );
  } else if (mode === "mcp" && candidate?.policy.manifest) {
    const existing =
      tools.find(
        (tool) => tool.kind === "mcp" && tool.mcpServerId === candidate.server.id,
      ) ?? null;
    body = (
      <McpForm
        key={candidate.server.id}
        baseManifest={candidate.policy.manifest}
        initialName={existing?.name ?? candidate.server.name ?? ""}
        initialDescription={
          existing?.description || candidate.server.description || ""
        }
        initialIconUrl={existing?.iconUrl ?? null}
        existingTool={existing}
        platformWarning={candidate.policy.codes.includes("platform_dependency")}
        keysHint={t("space.tools.keysPublishHint")}
        busy={busy}
        submitLabel={
          existing
            ? t("space.tools.publishRevision", { revision: existing.latestRevision + 1 })
            : t("space.tools.publish")
        }
        onBack={() => setCandidate(null)}
        onCancel={close}
        onSubmit={onSubmitMcp}
      />
    );
  } else if (mode === "mcp") {
    body = (
      <DialogFrameBody
        footer={
          <>
            <span className="flex-1" />
            <button
              type="button"
              onClick={close}
              className="h-9 rounded-lg px-3 text-sm font-semibold text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"
            >
              {t("space.common.cancel")}
            </button>
          </>
        }
      >
        <McpCandidateList config={config} tools={tools} onPick={setCandidate} />
      </DialogFrameBody>
    );
  } else {
    body = (
      <CustomForm
        initialName=""
        initialDescription=""
        initialInstruction=""
        initialIconUrl={null}
        busy={busy}
        submitLabel={t("space.tools.publish")}
        onCancel={close}
        onSubmit={onSubmitCustom}
      />
    );
  }

  return (
    <OverlayBackdrop
      portal
      onClose={busy ? undefined : onClose}
      className="z-[240] items-center justify-center bg-black/25 px-3 py-6 backdrop-blur-sm"
    >
      <section
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-label={
          editing
            ? t("space.tools.editTitle", { name: editing.revision.name })
            : t("space.tools.publishTitle")
        }
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="grid h-[min(88vh,700px)] max-h-[calc(100dvh-24px)] w-[min(92vw,720px)] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--paper-elevated)] shadow-xl outline-none"
      >
        <header className="flex items-center gap-4 pl-8 pr-4 pt-4 max-sm:pl-5">
          <h2 className="truncate text-base font-semibold text-[var(--ink)]">
            {editing
              ? t("space.tools.editTitle", { name: editing.revision.name })
              : t("space.tools.publishTitle")}
          </h2>
          {editing ? null : (
            <div role="tablist" className="flex gap-0.5">
              {(["mcp", "custom"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={mode === value}
                  disabled={busy}
                  onClick={() => {
                    setCandidate(null);
                    onModeChange(value);
                  }}
                  className={`h-8 rounded-full px-3 text-sm font-semibold transition-colors ${mode === value ? "bg-[var(--paper-inset)] text-[var(--ink)]" : "text-[var(--ink-muted)] hover:text-[var(--ink)]"}`}
                >
                  {value === "mcp" ? t("space.tools.tabMcp") : t("space.tools.tabGeneral")}
                </button>
              ))}
            </div>
          )}
          <span className="flex-1" />
          <button
            type="button"
            onClick={close}
            disabled={busy}
            aria-label={t("space.tools.close")}
            className="grid h-8 w-8 place-items-center rounded-lg text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)] disabled:opacity-50"
          >
            <CloseIcon className="h-4 w-4" />
          </button>
        </header>
        {body}
      </section>
    </OverlayBackdrop>
  );
}
