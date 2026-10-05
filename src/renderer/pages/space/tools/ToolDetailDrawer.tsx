import {
  useEffect,
  useMemo,
  useRef,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";

import {
  AlertIcon,
  CheckIcon,
  ChevronRightIcon,
  EditIcon,
  HelperIcon,
  HistoryIcon,
  LoaderIcon,
  PackagePlusIcon,
  RefreshIcon,
  SettingsIcon,
  TrashIcon,
  UndoIcon,
} from "@/components/icons";
import {
  spaceErrorMessage,
  type SpaceTool,
  type SpaceToolDetail,
  type SpaceToolRevision,
} from "@/api/spaceCloud";
import Markdown from "@/components/Markdown";
import { DropdownMenu } from "@/components/ui/DropdownMenu";
import type { AppConfig } from "@/config/types";
import { SpaceAvatar } from "@/pages/space/SpaceAvatar";
import { SpaceDetailDrawer } from "@/pages/space/SpaceDetailDrawer";
import type {
  SpaceToolDetailState,
  SpaceToolRevisionState,
} from "@/pages/space/spaceStore";
import { formatDate } from "@/pages/space/spaceUi";
import { isImeComposingEvent } from "@/utils/imeKeyboard";
import {
  classifyLocalSpaceMcp,
  diffPortableMcpManifests,
  type LocalSpaceMcpState,
  type PortableMcpDifference,
} from "../../../../shared/spaceToolManifest";
import {
  CopyButton,
  McpToolBody,
  RawConfigDisclosure,
  ToolIcon,
  ToolKindTag,
  ToolSection,
} from "./ToolParts";
import {
  describeRevisionChange,
  type ToolRevisionChangeField,
} from "./toolPresentation";

export type ToolDetailView = "detail" | "history";

const PRIMARY_BUTTON =
  "flex h-9 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-xl bg-[var(--button-primary-bg)] px-4 text-sm font-semibold text-[var(--button-primary-text)] shadow-sm transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:cursor-wait disabled:opacity-70";
const SECONDARY_BUTTON =
  "flex h-9 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-xl bg-[var(--button-secondary-bg)] px-4 text-sm font-semibold text-[var(--button-secondary-text)] transition-colors hover:bg-[var(--button-secondary-bg-hover)] disabled:cursor-wait disabled:opacity-70";
const SMALL_GHOST =
  "h-8 rounded-lg px-2.5 text-sm font-semibold text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)] disabled:opacity-50";

function safeLocalState(
  config: AppConfig,
  detail: SpaceToolDetail,
): LocalSpaceMcpState | null {
  const manifest = detail.revision.portableMcpManifest;
  if (detail.tool.kind !== "mcp" || !manifest) return null;
  try {
    return classifyLocalSpaceMcp(config, manifest);
  } catch {
    // A malformed Cloud manifest is reported by the install attempt itself.
    return { status: "none" };
  }
}

function differenceLabel(
  difference: PortableMcpDifference,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  switch (difference.field.kind) {
    case "transport":
      return t("space.tools.diffTransport");
    case "command":
      return t("space.tools.diffCommand");
    case "url":
      return t("space.tools.diffUrl");
    case "env":
      return t("space.tools.diffEnv", { name: difference.field.name });
    default:
      return t("space.tools.diffHeader", { name: difference.field.name });
  }
}

function DetailHero({
  admin,
  tool,
  detail,
  busy,
  action,
  onEdit,
  onHistory,
  onDelete,
  menuOpen,
  onMenuOpenChange,
}: {
  admin: boolean;
  tool: SpaceTool | SpaceToolDetail["tool"];
  detail: SpaceToolDetail | null;
  busy: boolean;
  action: ReactNode;
  onEdit: () => void;
  onHistory: () => void;
  onDelete: () => void;
  menuOpen: boolean;
  onMenuOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation("app");
  const name = detail?.revision.name ?? tool.name;
  const description = detail?.revision.description ?? tool.description;
  return (
    <div className="grid grid-cols-[56px_minmax(0,1fr)_auto] items-start gap-4 pr-8">
      <ToolIcon
        name={name}
        iconUrl={detail?.revision.iconUrl ?? tool.iconUrl}
        size={56}
      />
      <div className="min-w-0 pt-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="truncate text-xl font-semibold text-[var(--ink)]">{name}</h2>
          <ToolKindTag kind={tool.kind} />
        </div>
        <p
          className={`mt-1 whitespace-pre-wrap text-sm leading-6 ${description ? "text-[var(--ink-muted)]" : "text-[var(--ink-faint)]"}`}
        >
          {description || t("space.tools.noDescription")}
        </p>
      </div>
      <div className="flex items-center gap-2 pt-1.5">
        {admin && detail ? (
          <DropdownMenu
            size="md"
            open={menuOpen}
            onOpenChange={onMenuOpenChange}
            disabled={busy}
            title={t("space.tools.moreActions")}
            zIndex={250}
            minWidth={176}
            sections={[
              {
                items: [
                  {
                    icon: <EditIcon className="h-3.5 w-3.5" />,
                    label: t("space.tools.menuEdit"),
                    onClick: onEdit,
                  },
                  {
                    icon: <HistoryIcon className="h-3.5 w-3.5" />,
                    label: t("space.tools.menuHistory"),
                    onClick: onHistory,
                  },
                ],
              },
              {
                items: [
                  {
                    icon: <TrashIcon className="h-3.5 w-3.5" />,
                    label: t("space.tools.menuDelete"),
                    onClick: onDelete,
                    danger: true,
                  },
                ],
              },
            ]}
          />
        ) : null}
        {action}
      </div>
    </div>
  );
}

function McpStateLine({
  state,
  detail,
  replaceConfirm,
  busy,
  onCancelReplace,
  onConfirmReplace,
}: {
  state: LocalSpaceMcpState;
  detail: SpaceToolDetail;
  replaceConfirm: boolean;
  busy: boolean;
  onCancelReplace: () => void;
  onConfirmReplace: () => void;
}) {
  const { t } = useTranslation("app");
  const differences = useMemo(
    () =>
      state.status === "different" && detail.revision.portableMcpManifest
        ? diffPortableMcpManifests(state.localManifest, detail.revision.portableMcpManifest)
        : [],
    [detail.revision.portableMcpManifest, state],
  );
  if (state.status === "none") return null;
  if (state.status === "identical") {
    return (
      <p className="flex items-center gap-1.5 text-xs font-semibold text-[var(--success)]">
        <CheckIcon className="h-3.5 w-3.5" />
        {t("space.tools.installedState")}
        {state.enabled ? null : (
          <span className="font-normal text-[var(--ink-muted)]">
            {t("space.tools.installedDisabledSuffix")}
          </span>
        )}
      </p>
    );
  }
  return (
    <div>
      <p className="flex items-center gap-1.5 text-xs font-semibold text-[var(--warning)]">
        <AlertIcon className="h-3.5 w-3.5" />
        {t("space.tools.differentState")}
      </p>
      {differences.length ? (
        <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
          {differences.map((difference) => (
            <div key={differenceLabel(difference, t)} className="contents">
              <dt className="text-[var(--ink-subtle)]">{differenceLabel(difference, t)}</dt>
              <dd className="min-w-0 break-all font-mono">
                <span className="text-[var(--ink-subtle)] line-through">
                  {difference.local ?? "—"}
                </span>
                <span className="mx-1.5 text-[var(--ink-faint)]">→</span>
                <span className="text-[var(--ink)]">{difference.space ?? "—"}</span>
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {replaceConfirm ? (
        <div className="mt-3 flex items-center gap-2 rounded-xl bg-[var(--paper)] px-3 py-2 text-xs text-[var(--ink-secondary)]">
          <span className="flex-1">{t("space.tools.replaceConfirm")}</span>
          <button type="button" disabled={busy} onClick={onCancelReplace} className={SMALL_GHOST}>
            {t("space.common.cancel")}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onConfirmReplace}
            className="flex h-8 items-center gap-1.5 rounded-lg bg-[var(--warning)] px-3 text-sm font-semibold text-[var(--on-warning)] disabled:opacity-60"
          >
            {busy ? <LoaderIcon className="h-3.5 w-3.5 animate-spin" /> : null}
            {t("space.tools.replaceAction")}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function revisionChangeText(
  revision: SpaceToolRevision,
  previous: SpaceToolRevision | undefined,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  const change = describeRevisionChange(revision, previous);
  switch (change.kind) {
    case "first":
      return t("space.tools.changeFirst");
    case "unchanged":
      return t("space.tools.changeUnchanged");
    case "unknown":
      return "";
    default:
      return t("space.tools.changeFields", {
        fields: change.fields
          .map((field: ToolRevisionChangeField) => t(`space.tools.changeField.${field}`))
          .join(t("space.tools.changeFieldSeparator")),
      });
  }
}

function HistoryView({
  detail,
  revisionState,
  rollbackTarget,
  busy,
  onBack,
  onRequestRollback,
  onCancelRollback,
  onConfirmRollback,
  onRetry,
  onLoadMore,
}: {
  detail: SpaceToolDetail;
  revisionState?: SpaceToolRevisionState;
  rollbackTarget: number | null;
  busy: boolean;
  onBack: () => void;
  onRequestRollback: (revision: number) => void;
  onCancelRollback: () => void;
  onConfirmRollback: () => void;
  onRetry: () => void;
  onLoadMore: () => void;
}) {
  const { t } = useTranslation("app");
  const items = revisionState?.history?.items ?? [];
  return (
    <div>
      <nav className="-mt-2 flex items-center gap-1 text-xs text-[var(--ink-subtle)]">
        <button
          type="button"
          onClick={onBack}
          className="-ml-1.5 rounded-md px-1.5 py-0.5 font-semibold text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
        >
          {detail.revision.name}
        </button>
        <ChevronRightIcon className="h-3 w-3" />
        <span className="font-semibold text-[var(--ink)]">{t("space.tools.historyTitle")}</span>
      </nav>
      <div className="mt-4 flex items-baseline gap-2">
        <h2 className="text-xl font-semibold text-[var(--ink)]">{t("space.tools.historyTitle")}</h2>
        <span className="text-sm text-[var(--ink-subtle)]">{detail.tool.latestRevision}</span>
      </div>
      <p className="mt-1.5 text-sm leading-6 text-[var(--ink-muted)]">
        {t("space.tools.historyHint")}
      </p>
      {revisionState?.error ? (
        <div
          role="alert"
          className="mt-4 flex items-center gap-3 rounded-xl bg-[var(--error-bg)] px-3 py-2 text-sm text-[var(--error)]"
        >
          <span className="flex-1">{spaceErrorMessage(revisionState.error)}</span>
          <button type="button" onClick={onRetry} className="shrink-0 font-semibold hover:underline">
            {t("space.common.retry")}
          </button>
        </div>
      ) : null}
      {revisionState?.isLoading && !revisionState.history ? (
        <div className="grid min-h-40 place-items-center">
          <LoaderIcon className="h-5 w-5 animate-spin text-[var(--ink-muted)]" />
        </div>
      ) : (
        <div className="mt-5 grid">
          {items.map((revision, index) => {
            const current = revision.revision === detail.tool.currentRevision;
            const confirming = rollbackTarget === revision.revision;
            const change = revisionChangeText(revision, items[index + 1], t);
            return (
              <div
                key={revision.id}
                className={`group -mx-2.5 grid grid-cols-[44px_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 rounded-xl px-2.5 py-3 transition-colors hover:bg-[var(--hover-bg)] ${confirming ? "bg-[var(--hover-bg)]" : ""}`}
              >
                <span className="self-start pt-px text-sm font-semibold text-[var(--ink)]">
                  v{revision.revision}
                </span>
                <span className="min-w-0">
                  {change ? (
                    <span className="block text-sm text-[var(--ink)]">{change}</span>
                  ) : null}
                  <span className="mt-1 flex items-center gap-1.5 text-xs text-[var(--ink-subtle)]">
                    <SpaceAvatar
                      name={revision.uploader?.name ?? revision.uploader?.id}
                      size={16}
                    />
                    {revision.uploader?.name ??
                      revision.uploader?.id ??
                      t("space.tools.unknownUploader")}
                    <span className="text-[var(--line-strong)]">·</span>
                    {formatDate(revision.createdAt)}
                  </span>
                </span>
                {current ? (
                  <span className="text-xs font-semibold text-[var(--success)]">
                    {t("space.tools.currentRevision")}
                  </span>
                ) : (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onRequestRollback(revision.revision)}
                    className={`flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-semibold text-[var(--ink-muted)] transition-opacity hover:bg-[var(--paper-elevated)] hover:text-[var(--ink)] focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 ${confirming ? "opacity-100" : "opacity-0"}`}
                  >
                    <UndoIcon className="h-3.5 w-3.5" />
                    {t("space.tools.setCurrent")}
                  </button>
                )}
                {confirming ? (
                  <div className="col-span-2 col-start-2 flex items-center gap-2 text-xs text-[var(--ink-secondary)]">
                    <span className="flex-1">
                      {t("space.tools.setCurrentConfirm", {
                        target: revision.revision,
                        current: detail.tool.currentRevision,
                      })}
                    </span>
                    <button type="button" disabled={busy} onClick={onCancelRollback} className={SMALL_GHOST}>
                      {t("space.common.cancel")}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={onConfirmRollback}
                      className="flex h-8 items-center gap-1.5 rounded-lg bg-[var(--button-primary-bg)] px-3 text-sm font-semibold text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)] disabled:opacity-60"
                    >
                      {busy ? <LoaderIcon className="h-3.5 w-3.5 animate-spin" /> : null}
                      {t("space.tools.setCurrentAction")}
                    </button>
                  </div>
                ) : null}
              </div>
            );
          })}
          {revisionState?.history?.hasMore ? (
            <button
              type="button"
              disabled={revisionState.isLoadingMore}
              onClick={onLoadMore}
              className="mt-2 flex h-9 items-center justify-center gap-2 rounded-lg text-sm font-semibold text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] disabled:opacity-60"
            >
              {revisionState.isLoadingMore ? <LoaderIcon className="h-4 w-4 animate-spin" /> : null}
              {t("space.common.loadMore")}
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}

export function ToolDetailDrawer({
  admin,
  config,
  tool,
  detailState,
  revisionState,
  view,
  busy,
  installing,
  replaceConfirm,
  rawOpen,
  rollbackTarget,
  menuOpen,
  onMenuOpenChange,
  onClose,
  onEscape,
  onInstall,
  onRequestReplace,
  onCancelReplace,
  onConfirmReplace,
  onManage,
  onHelperInstall,
  onToggleRaw,
  onEdit,
  onOpenHistory,
  onBackToDetail,
  onDelete,
  onRequestRollback,
  onCancelRollback,
  onConfirmRollback,
  onRetryDetail,
  onRetryRevisions,
  onLoadMoreRevisions,
}: {
  admin: boolean;
  config: AppConfig;
  tool: SpaceTool | null;
  detailState?: SpaceToolDetailState;
  revisionState?: SpaceToolRevisionState;
  view: ToolDetailView;
  busy: boolean;
  installing: boolean;
  replaceConfirm: boolean;
  rawOpen: boolean;
  rollbackTarget: number | null;
  menuOpen: boolean;
  onMenuOpenChange: (open: boolean) => void;
  onClose: () => void;
  /** Escape inside the drawer closes the innermost open layer first. */
  onEscape: () => void;
  onInstall: () => void;
  onRequestReplace: () => void;
  onCancelReplace: () => void;
  onConfirmReplace: () => void;
  onManage: () => void;
  onHelperInstall: () => void;
  onToggleRaw: () => void;
  onEdit: () => void;
  onOpenHistory: () => void;
  onBackToDetail: () => void;
  onDelete: () => void;
  onRequestRollback: (revision: number) => void;
  onCancelRollback: () => void;
  onConfirmRollback: () => void;
  onRetryDetail: () => void;
  onRetryRevisions: () => void;
  onLoadMoreRevisions: () => void;
}) {
  const { t } = useTranslation("app");
  const detail = detailState?.detail ?? null;
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    scrollerRef.current?.focus();
  }, []);
  const rendered = detail ? safeLocalState(config, detail) : null;
  // The install write found a different definition on disk before the
  // rendered config caught up: show the conflict instead of "not installed".
  const local: LocalSpaceMcpState | null =
    rendered?.status === "none" && replaceConfirm
      ? { status: "different", enabled: false }
      : rendered;
  const summary = detail?.tool ?? tool;

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || isImeComposingEvent(event)) return;
    event.preventDefault();
    event.stopPropagation();
    onEscape();
  };

  let action: ReactNode = null;
  if (detail?.tool.kind === "mcp") {
    if (!local || local.status === "none") {
      action = (
        <button type="button" disabled={busy} onClick={onInstall} className={PRIMARY_BUTTON}>
          {installing ? (
            <LoaderIcon className="h-4 w-4 animate-spin" />
          ) : (
            <PackagePlusIcon className="h-4 w-4" />
          )}
          {t("space.tools.install")}
        </button>
      );
    } else if (local.status === "identical") {
      action = (
        <button type="button" disabled={busy} onClick={onManage} className={SECONDARY_BUTTON}>
          <SettingsIcon className="h-4 w-4" />
          {t("space.tools.manage")}
        </button>
      );
    } else {
      action = (
        <button type="button" disabled={busy} onClick={onRequestReplace} className={PRIMARY_BUTTON}>
          <RefreshIcon className="h-4 w-4" />
          {t("space.tools.replace")}
        </button>
      );
    }
  } else if (detail) {
    action = (
      <button type="button" disabled={busy} onClick={onHelperInstall} className={PRIMARY_BUTTON}>
        <HelperIcon className="h-4 w-4" />
        {t("space.tools.helperInstall")}
      </button>
    );
  }

  let content: ReactNode;
  if (!detail && detailState?.error) {
    content = (
      <div className="grid min-h-60 flex-1 place-items-center text-center text-sm">
        <div>
          <p className="text-[var(--error)]">{spaceErrorMessage(detailState.error)}</p>
          <button type="button" onClick={onRetryDetail} className={`mt-3 ${SMALL_GHOST}`}>
            {t("space.common.retry")}
          </button>
        </div>
      </div>
    );
  } else if (!detail) {
    content = (
      <div className="grid min-h-60 flex-1 place-items-center">
        <LoaderIcon className="h-5 w-5 animate-spin text-[var(--ink-muted)]" />
      </div>
    );
  } else if (view === "history") {
    content = (
      <HistoryView
        detail={detail}
        revisionState={revisionState}
        rollbackTarget={rollbackTarget}
        busy={busy}
        onBack={onBackToDetail}
        onRequestRollback={onRequestRollback}
        onCancelRollback={onCancelRollback}
        onConfirmRollback={onConfirmRollback}
        onRetry={onRetryRevisions}
        onLoadMore={onLoadMoreRevisions}
      />
    );
  } else {
    const manifest = detail.revision.portableMcpManifest;
    const uploaderName =
      detail.revision.uploader?.name ??
      detail.revision.uploader?.id ??
      t("space.tools.unknownUploader");
    content = (
      <>
        <DetailHero
          admin={admin}
          tool={summary!}
          detail={detail}
          busy={busy}
          action={action}
          onEdit={onEdit}
          onHistory={onOpenHistory}
          onDelete={onDelete}
          menuOpen={menuOpen}
          onMenuOpenChange={onMenuOpenChange}
        />
        {detailState?.error ? (
          <div
            role="alert"
            className="mt-4 flex items-center gap-3 rounded-xl bg-[var(--error-bg)] px-3 py-2 text-sm text-[var(--error)]"
          >
            <span className="flex-1">{spaceErrorMessage(detailState.error)}</span>
            <button type="button" onClick={onRetryDetail} className="shrink-0 font-semibold hover:underline">
              {t("space.common.retry")}
            </button>
          </div>
        ) : null}
        <div className="ml-[72px] mt-3 empty:hidden">
          {local ? (
            <McpStateLine
              state={local}
              detail={detail}
              replaceConfirm={replaceConfirm}
              busy={busy}
              onCancelReplace={onCancelReplace}
              onConfirmReplace={onConfirmReplace}
            />
          ) : detail.tool.kind !== "mcp" ? (
            <p className="flex items-center gap-1.5 text-xs text-[var(--ink-muted)]">
              <HelperIcon className="h-3.5 w-3.5" />
              {t("space.tools.generalState")}
            </p>
          ) : null}
        </div>
        {detail.tool.kind === "mcp" && manifest ? (
          <>
            <McpToolBody manifest={manifest} keysHint={t("space.tools.keysHint")} />
            <RawConfigDisclosure manifest={manifest} open={rawOpen} onToggle={onToggleRaw} />
          </>
        ) : detail.revision.customInstallInstruction ? (
          <ToolSection
            title={t("space.tools.instructionTitle")}
            action={<CopyButton text={detail.revision.customInstallInstruction} />}
          >
            <div className="ai-message-content pt-1.5 text-[var(--ink-secondary)]">
              <Markdown raw>{detail.revision.customInstallInstruction}</Markdown>
            </div>
          </ToolSection>
        ) : null}
        <footer className="mt-auto flex items-center gap-1.5 pt-8 text-xs text-[var(--ink-subtle)]">
          <SpaceAvatar name={uploaderName} size={16} />
          <span>{t("space.tools.footerPublisher", { name: uploaderName })}</span>
          <span className="text-[var(--line-strong)]">·</span>
          <span>
            v{detail.tool.currentRevision}
            {admin && detail.tool.currentRevision < detail.tool.latestRevision
              ? t("space.tools.footerLatest", { revision: detail.tool.latestRevision })
              : ""}
          </span>
          <span className="text-[var(--line-strong)]">·</span>
          <span>{formatDate(detail.revision.createdAt)}</span>
        </footer>
      </>
    );
  }

  return (
    <SpaceDetailDrawer
      onClose={onClose}
      closeLabel={t("space.tools.close")}
      closeDisabled={busy}
      widthClassName="w-[min(88vw,760px)]"
    >
      <div
        ref={scrollerRef}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="flex h-full min-h-0 flex-col overflow-y-auto px-11 py-11 outline-none max-sm:px-5"
      >
        {content}
      </div>
    </SpaceDetailDrawer>
  );
}
