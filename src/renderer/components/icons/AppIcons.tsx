import type { ComponentType, ReactNode, SVGProps } from 'react';

/**
 * MyAgents product icon set — the only source of UI glyphs in the renderer.
 *
 * Grid: 20×20 drawing grid with round caps and joins; container corners use a
 * 3–3.5 radius so every glyph shares one soft silhouette. Icons are displayed
 * through a 16.5-unit crop (`VIEW_BOX`) so the outline fills a slot like a
 * 24-grid icon with 2px padding, and the default stroke (1.35 units) renders at
 * ~1.31px in the usual 16px slot.
 *
 * Props mirror the former lucide-react API so call sites keep their meaning:
 * `size` sets width/height (CSS classes still win), `strokeWidth` is expressed
 * in lucide-equivalent units (2 = default product weight), and `fill` / `color`
 * pass through to the root.
 *
 * Icons with a body shape carry an `app-icon-tint` layer that stays invisible
 * until a host sets `--app-icon-tint` (e.g. a selected sidebar row), giving
 * active states a quiet fill without swapping glyphs.
 *
 * File/folder identity lives in `components/file-icon/`; workspace avatars live
 * in `WorkspaceIcon`. Do not import `lucide-react` — ESLint enforces this.
 */
export interface AppIconProps extends SVGProps<SVGSVGElement> {
  size?: number | string;
  /** Lucide-equivalent weight. 2 is the default product line. */
  strokeWidth?: number | string;
  color?: string;
}

export type AppIconComponent = ComponentType<AppIconProps>;

const VIEW_BOX = '1.75 1.75 16.5 16.5';
/** Maps lucide-equivalent stroke units onto the 20-grid drawing units. */
const STROKE_SCALE = 1.35 / 2;

function createAppIcon(name: string, children: ReactNode): AppIconComponent {
  function AppIcon({
    size = 24,
    strokeWidth = 2,
    color = 'currentColor',
    className,
    ...props
  }: AppIconProps) {
    // Decorative by default; an explicit accessible name exposes the glyph,
    // matching the former lucide-react contract.
    const labelled = Boolean(props['aria-label'] || props['aria-labelledby'] || props.role);
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox={VIEW_BOX}
        width={size}
        height={size}
        fill="none"
        stroke={color}
        strokeWidth={Number(strokeWidth) * STROKE_SCALE}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden={labelled ? undefined : true}
        focusable="false"
        className={`app-icon app-icon-${name}${className ? ` ${className}` : ''}`}
        {...props}
      >
        {children}
      </svg>
    );
  }
  AppIcon.displayName = `AppIcon(${name})`;
  return AppIcon;
}

const TINT_STYLE = { opacity: 'var(--app-icon-tint, 0)' } as const;
const Tint = ({ d }: { d: string }) => (
  <path className="app-icon-tint" d={d} fill="currentColor" stroke="none" style={TINT_STYLE} />
);

// 导航与入口
export const ComposeIcon = createAppIcon('compose', (
  <>
    <Tint d="M14.4 3.35a1.55 1.55 0 0 1 2.2 2.2L10.75 11.4l-2.9.75.75-2.9z" />
    <path d="M9.25 3.75H6.75a3 3 0 0 0-3 3v6.5a3 3 0 0 0 3 3h6.5a3 3 0 0 0 3-3v-2.5" />
    <path d="M14.4 3.35a1.55 1.55 0 0 1 2.2 2.2L10.75 11.4l-2.9.75.75-2.9z" />
  </>
));
export const SearchIcon = createAppIcon('search', (
  <>
    <Tint d="M3.75 8.75a5 5 0 1 0 10 0a5 5 0 1 0-10 0z" />
    <circle cx="8.75" cy="8.75" r="5" />
    <path d="M12.5 12.5l3.75 3.75" />
  </>
));
export const TasksIcon = createAppIcon('tasks', (
  <>
    <Tint d="M7.25 3.75h5.5a3.5 3.5 0 0 1 3.5 3.5v5.5a3.5 3.5 0 0 1-3.5 3.5h-5.5a3.5 3.5 0 0 1-3.5-3.5v-5.5a3.5 3.5 0 0 1 3.5-3.5z" />
    <rect x="3.75" y="3.75" width="12.5" height="12.5" rx="3.5" />
    <path d="M7.1 10.2l2.05 2.05 3.75-4.25" />
  </>
));
export const TeamIcon = createAppIcon('team', (
  <>
    <Tint d="M5 7a2.75 2.75 0 1 0 5.5 0a2.75 2.75 0 1 0-5.5 0z" />
    <circle cx="7.75" cy="7" r="2.75" />
    <path d="M2.75 16.25c0-2.85 2.2-4.75 5-4.75s5 1.9 5 4.75" />
    <path d="M12.6 4.6a2.25 2.25 0 1 1 .65 4.4" />
    <path d="M14.4 11.65c1.75.45 2.85 2 2.85 4.1" />
  </>
));
export const UserPlusIcon = createAppIcon('user-plus', (
  <>
    <circle cx="8.75" cy="7" r="3.25" />
    <path d="M3 16.75c0-3.25 2.6-5.25 5.75-5.25 1.2 0 2.3.3 3.2.8" />
    <path d="M15.25 11.75v4.5M13 14h4.5" />
  </>
));
export const UserCheckIcon = createAppIcon('user-check', (
  <>
    <circle cx="8.75" cy="7" r="3.25" />
    <path d="M3 16.75c0-3.25 2.6-5.25 5.75-5.25 1 0 1.95.2 2.75.55" />
    <path d="M12.5 15l1.6 1.6 3.15-3.35" />
  </>
));
export const LogInIcon = createAppIcon('log-in', (
  <>
    <path d="M11.75 3.75h2.5a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2h-2.5" />
    <path d="M3.75 10h8.5" />
    <path d="M9 6.75L12.25 10 9 13.25" />
  </>
));
export const LogOutIcon = createAppIcon('log-out', (
  <>
    <path d="M8.25 3.75h-2.5a2 2 0 0 0-2 2v8.5a2 2 0 0 0 2 2h2.5" />
    <path d="M8 10h8.5" />
    <path d="M13.25 6.75L16.5 10l-3.25 3.25" />
  </>
));
export const UserIcon = createAppIcon('user', (
  <>
    <Tint d="M6.75 7a3.25 3.25 0 1 0 6.5 0a3.25 3.25 0 1 0-6.5 0z" />
    <circle cx="10" cy="7" r="3.25" />
    <path d="M3.75 16.75c0-3.25 2.8-5.25 6.25-5.25s6.25 2 6.25 5.25" />
  </>
));
export const CapabilitiesIcon = createAppIcon('capabilities', (
  <>
    <Tint d="M8.75 4.5c.5 3.35 2.4 5.25 5.75 5.75-3.35.5-5.25 2.4-5.75 5.75-.5-3.35-2.4-5.25-5.75-5.75 3.35-.5 5.25-2.4 5.75-5.75z" />
    <path d="M8.75 4.5c.5 3.35 2.4 5.25 5.75 5.75-3.35.5-5.25 2.4-5.75 5.75-.5-3.35-2.4-5.25-5.75-5.75 3.35-.5 5.25-2.4 5.75-5.75z" />
    <path d="M15 2.75v3.5M13.25 4.5h3.5" />
  </>
));
export const BellIcon = createAppIcon('bell', (
  <>
    <Tint d="M4.25 14.25h11.5l-1.25-1.75V9a4.5 4.5 0 0 0-9 0v3.5z" />
    <path d="M4.25 14.25h11.5l-1.25-1.75V9a4.5 4.5 0 0 0-9 0v3.5z" />
    <path d="M8.25 16.75a2 2 0 0 0 3.5 0" />
  </>
));
export const HelperIcon = createAppIcon('helper', (
  <>
    <Tint d="M7.25 6.25h5.5a3.5 3.5 0 0 1 3.5 3.5v3a3.5 3.5 0 0 1-3.5 3.5h-5.5a3.5 3.5 0 0 1-3.5-3.5v-3a3.5 3.5 0 0 1 3.5-3.5z" />
    <rect x="3.75" y="6.25" width="12.5" height="10" rx="3.5" />
    <path d="M7.75 10.25v1.5M12.25 10.25v1.5" />
    <path d="M10 6.25V4.5" />
    <circle cx="10" cy="3.25" r="1" fill="currentColor" stroke="none" />
  </>
));
export const SettingsIcon = createAppIcon('settings', (
  <>
    <Tint d="M8.79 4.38L9 2.57A7.5 7.5 0 0 1 11 2.57L11.21 4.38A5.75 5.75 0 0 1 13.12 5.17L14.55 4.04A7.5 7.5 0 0 1 15.96 5.45L14.83 6.88A5.75 5.75 0 0 1 15.62 8.79L17.43 9A7.5 7.5 0 0 1 17.43 11L15.62 11.21A5.75 5.75 0 0 1 14.83 13.12L15.96 14.55A7.5 7.5 0 0 1 14.55 15.96L13.12 14.83A5.75 5.75 0 0 1 11.21 15.62L11 17.43A7.5 7.5 0 0 1 9 17.43L8.79 15.62A5.75 5.75 0 0 1 6.88 14.83L5.45 15.96A7.5 7.5 0 0 1 4.04 14.55L5.17 13.12A5.75 5.75 0 0 1 4.38 11.21L2.57 11A7.5 7.5 0 0 1 2.57 9L4.38 8.79A5.75 5.75 0 0 1 5.17 6.88L4.04 5.45A7.5 7.5 0 0 1 5.45 4.04L6.88 5.17A5.75 5.75 0 0 1 8.79 4.38Z" />
    <path d="M8.79 4.38L9 2.57A7.5 7.5 0 0 1 11 2.57L11.21 4.38A5.75 5.75 0 0 1 13.12 5.17L14.55 4.04A7.5 7.5 0 0 1 15.96 5.45L14.83 6.88A5.75 5.75 0 0 1 15.62 8.79L17.43 9A7.5 7.5 0 0 1 17.43 11L15.62 11.21A5.75 5.75 0 0 1 14.83 13.12L15.96 14.55A7.5 7.5 0 0 1 14.55 15.96L13.12 14.83A5.75 5.75 0 0 1 11.21 15.62L11 17.43A7.5 7.5 0 0 1 9 17.43L8.79 15.62A5.75 5.75 0 0 1 6.88 14.83L5.45 15.96A7.5 7.5 0 0 1 4.04 14.55L5.17 13.12A5.75 5.75 0 0 1 4.38 11.21L2.57 11A7.5 7.5 0 0 1 2.57 9L4.38 8.79A5.75 5.75 0 0 1 5.17 6.88L4.04 5.45A7.5 7.5 0 0 1 5.45 4.04L6.88 5.17A5.75 5.75 0 0 1 8.79 4.38Z" />
    <circle cx="10" cy="10" r="2.25" />
  </>
));
export const ArchiveIcon = createAppIcon('archive', (
  <>
    <Tint d="M4.25 7.5h11.5v6.25a2.5 2.5 0 0 1-2.5 2.5h-6.5a2.5 2.5 0 0 1-2.5-2.5z" />
    <rect x="2.75" y="3.75" width="14.5" height="3.75" rx="1.25" />
    <path d="M4.25 7.5v6.25a2.5 2.5 0 0 0 2.5 2.5h6.5a2.5 2.5 0 0 0 2.5-2.5V7.5" />
    <path d="M8.25 10.5h3.5" />
  </>
));
export const ArchiveRestoreIcon = createAppIcon('archive-restore', (
  <>
    <rect x="2.75" y="3.75" width="14.5" height="3.75" rx="1.25" />
    <path d="M4.25 7.5v6.25a2.5 2.5 0 0 0 2.5 2.5h1" />
    <path d="M15.75 7.5v6.25a2.5 2.5 0 0 1-2.5 2.5h-1" />
    <path d="M10 16.25v-5.5" />
    <path d="M7.75 12.75L10 10.5l2.25 2.25" />
  </>
));
export const SidebarIcon = createAppIcon('sidebar', (
  <>
    <Tint d="M6 3.75h1.75v12.5H6A3.25 3.25 0 0 1 2.75 13V7A3.25 3.25 0 0 1 6 3.75z" />
    <rect x="2.75" y="3.75" width="14.5" height="12.5" rx="3.25" />
    <path d="M7.75 3.75v12.5" />
  </>
));
export const PanelRightIcon = createAppIcon('panel-right', (
  <>
    <Tint d="M12.25 3.75H14A3.25 3.25 0 0 1 17.25 7v6A3.25 3.25 0 0 1 14 16.25h-1.75z" />
    <rect x="2.75" y="3.75" width="14.5" height="12.5" rx="3.25" />
    <path d="M12.25 3.75v12.5" />
  </>
));
export const MessageIcon = createAppIcon('message', (
  <>
    <Tint d="M6.75 3.75h6.5a3 3 0 0 1 3 3v4.5a3 3 0 0 1-3 3H10.5l-3.5 2.5v-2.5h-.25a3 3 0 0 1-3-3v-4.5a3 3 0 0 1 3-3z" />
    <path d="M6.75 3.75h6.5a3 3 0 0 1 3 3v4.5a3 3 0 0 1-3 3H10.5l-3.5 2.5v-2.5h-.25a3 3 0 0 1-3-3v-4.5a3 3 0 0 1 3-3z" />
    <path d="M7.25 8.25h5.5" />
  </>
));
export const MessageCircleIcon = createAppIcon('message-circle', (
  <>
    <Tint d="M10 3.5a6.5 6.5 0 0 0-5.7 9.6l-.8 3.4 3.4-.8A6.5 6.5 0 1 0 10 3.5z" />
    <path d="M10 3.5a6.5 6.5 0 0 0-5.7 9.6l-.8 3.4 3.4-.8A6.5 6.5 0 1 0 10 3.5z" />
  </>
));
export const HelpBubbleIcon = createAppIcon('help-bubble', (
  <>
    <Tint d="M10 3.5a6.5 6.5 0 0 0-5.7 9.6l-.8 3.4 3.4-.8A6.5 6.5 0 1 0 10 3.5z" />
    <path d="M10 3.5a6.5 6.5 0 0 0-5.7 9.6l-.8 3.4 3.4-.8A6.5 6.5 0 1 0 10 3.5z" />
    <path d="M8.4 8.35a1.6 1.6 0 1 1 2.35 1.4c-.5.25-.75.6-.75 1.15" />
    <circle cx="10" cy="13.1" r="0.85" fill="currentColor" stroke="none" />
  </>
));
export const TemplateIcon = createAppIcon('template', (
  <>
    <Tint d="M6.25 3.25h7.5a3 3 0 0 1 3 3v7.5a3 3 0 0 1-3 3h-7.5a3 3 0 0 1-3-3v-7.5a3 3 0 0 1 3-3z" />
    <rect x="3.25" y="3.25" width="13.5" height="13.5" rx="3" />
    <path d="M3.25 8.25h13.5" />
    <path d="M8.75 8.25v8.5" />
  </>
));
export const GridIcon = createAppIcon('grid', (
  <>
    <rect x="3.25" y="3.25" width="5.5" height="5.5" rx="1.75" />
    <rect x="11.25" y="3.25" width="5.5" height="5.5" rx="1.75" />
    <rect x="3.25" y="11.25" width="5.5" height="5.5" rx="1.75" />
    <rect x="11.25" y="11.25" width="5.5" height="5.5" rx="1.75" />
  </>
));

// 通用操作
export const PlusIcon = createAppIcon('plus', <path d="M10 4.75v10.5M4.75 10h10.5" />);
export const MinusIcon = createAppIcon('minus', <path d="M4.75 10h10.5" />);
export const CloseIcon = createAppIcon('close', <path d="M5.5 5.5l9 9M14.5 5.5l-9 9" />);
export const CheckIcon = createAppIcon('check', <path d="M4.75 10.5l3.5 3.5 7-7.75" />);
export const CheckCheckIcon = createAppIcon('check-check', (
  <>
    <path d="M2.75 10.75l3.25 3.25 6.5-7.25" />
    <path d="M10.25 13.25l.75.75 6.25-7" />
  </>
));
export const TrashIcon = createAppIcon('trash', (
  <>
    <Tint d="M5.25 5.75h9.5l-.7 9a2 2 0 0 1-2 1.85h-4.1a2 2 0 0 1-2-1.85z" />
    <path d="M3.75 5.75h12.5" />
    <path d="M7.75 5.75V4.75a1.25 1.25 0 0 1 1.25-1.25h2a1.25 1.25 0 0 1 1.25 1.25v1" />
    <path d="M5.25 5.75l.7 9a2 2 0 0 0 2 1.85h4.1a2 2 0 0 0 2-1.85l.7-9" />
    <path d="M8.6 9v4.25M11.4 9v4.25" />
  </>
));
export const CopyIcon = createAppIcon('copy', (
  <>
    <Tint d="M9.75 7.25h4.5a2.5 2.5 0 0 1 2.5 2.5v4.5a2.5 2.5 0 0 1-2.5 2.5h-4.5a2.5 2.5 0 0 1-2.5-2.5v-4.5a2.5 2.5 0 0 1 2.5-2.5z" />
    <path d="M12.75 6.25V5.5a2.25 2.25 0 0 0-2.25-2.25h-5A2.25 2.25 0 0 0 3.25 5.5v5a2.25 2.25 0 0 0 2.25 2.25h.75" />
    <rect x="7.25" y="7.25" width="9.5" height="9.5" rx="2.5" />
  </>
));
export const PasteIcon = createAppIcon('paste', (
  <>
    <path d="M7.25 4.25H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2h-1.25" />
    <rect x="7.25" y="2.75" width="5.5" height="3" rx="1" />
    <path d="M10 8.75v5" />
    <path d="M7.75 11.5L10 13.75l2.25-2.25" />
  </>
));
export const ScissorsIcon = createAppIcon('scissors', (
  <>
    <circle cx="5.75" cy="5.75" r="2.25" />
    <circle cx="5.75" cy="14.25" r="2.25" />
    <path d="M7.6 7.15l8.65 7.6" />
    <path d="M7.6 12.85l8.65-7.6" />
  </>
));
export const EditIcon = createAppIcon('edit', (
  <>
    <Tint d="M13.6 3.9a1.9 1.9 0 0 1 2.5 2.5L7.5 15l-3.75 1.25L5 12.5z" />
    <path d="M13.6 3.9a1.9 1.9 0 0 1 2.5 2.5L7.5 15l-3.75 1.25L5 12.5z" />
    <path d="M12.1 5.4l2.5 2.5" />
  </>
));
export const SaveIcon = createAppIcon('save', (
  <>
    <path d="M5.75 3.75h6.75l3.75 3.75v6.75a2 2 0 0 1-2 2h-8.5a2 2 0 0 1-2-2v-8.5a2 2 0 0 1 2-2z" />
    <path d="M7 3.75v3h5.25v-3" />
    <path d="M6.75 16.25v-4.5a1 1 0 0 1 1-1h4.5a1 1 0 0 1 1 1v4.5" />
  </>
));
export const DownloadIcon = createAppIcon('download', (
  <>
    <path d="M3.75 12.75v1.5a2 2 0 0 0 2 2h8.5a2 2 0 0 0 2-2v-1.5" />
    <path d="M10 3.75v8.5M6.5 8.75L10 12.25l3.5-3.5" />
  </>
));
export const UploadIcon = createAppIcon('upload', (
  <>
    <path d="M3.75 12.75v1.5a2 2 0 0 0 2 2h8.5a2 2 0 0 0 2-2v-1.5" />
    <path d="M10 12.25v-8.5M6.5 7.25L10 3.75l3.5 3.5" />
  </>
));
export const UploadCloudIcon = createAppIcon('upload-cloud', (
  <>
    <path d="M6 15.25a3.75 3.75 0 0 1-.6-7.45 5 5 0 0 1 9.6.95 3.25 3.25 0 0 1-.25 6.5" />
    <path d="M10 16.75v-6.25" />
    <path d="M7.75 12.5L10 10.25l2.25 2.25" />
  </>
));
export const ExternalIcon = createAppIcon('external', (
  <>
    <path d="M9 4.25H6.25a2.5 2.5 0 0 0-2.5 2.5v7a2.5 2.5 0 0 0 2.5 2.5h7a2.5 2.5 0 0 0 2.5-2.5V11" />
    <path d="M12 3.75h4.25V8M16.25 3.75l-6.5 6.5" />
  </>
));
export const RefreshIcon = createAppIcon('refresh', (
  <>
    <path d="M16.25 10a6.25 6.25 0 0 1-11.1 3.95" />
    <path d="M3.75 10a6.25 6.25 0 0 1 11.1-3.95" />
    <path d="M15.25 2.9v3.35h-3.35" />
    <path d="M4.75 17.1v-3.35h3.35" />
  </>
));
export const UndoIcon = createAppIcon('undo', (
  <>
    <path d="M5.5 8.25h6.75a4 4 0 0 1 0 8h-3.5" />
    <path d="M8.25 5L5 8.25l3.25 3.25" />
  </>
));
export const RedoIcon = createAppIcon('redo', (
  <>
    <path d="M14.5 8.25H7.75a4 4 0 0 0 0 8h3.5" />
    <path d="M11.75 5L15 8.25l-3.25 3.25" />
  </>
));
export const RepeatIcon = createAppIcon('repeat', (
  <>
    <path d="M4.25 9.5v-.75A2.75 2.75 0 0 1 7 6h9" />
    <path d="M13.5 3.5L16 6l-2.5 2.5" />
    <path d="M15.75 10.5v.75A2.75 2.75 0 0 1 13 14H4" />
    <path d="M6.5 16.5L4 14l2.5-2.5" />
  </>
));
export const MoreIcon = createAppIcon('more', (
  <>
    <circle cx="4.75" cy="10" r="1.15" fill="currentColor" stroke="none" />
    <circle cx="10" cy="10" r="1.15" fill="currentColor" stroke="none" />
    <circle cx="15.25" cy="10" r="1.15" fill="currentColor" stroke="none" />
  </>
));
export const GripIcon = createAppIcon('grip', (
  <>
    <circle cx="7.5" cy="5" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="12.5" cy="5" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="7.5" cy="10" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="12.5" cy="10" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="7.5" cy="15" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="12.5" cy="15" r="1.1" fill="currentColor" stroke="none" />
  </>
));
export const SendIcon = createAppIcon('send', (
  <>
    <Tint d="M16.75 3.25L3.5 8.4l5.5 2.6 2.6 5.5z" />
    <path d="M16.75 3.25L3.5 8.4l5.5 2.6 2.6 5.5z" />
    <path d="M16.75 3.25L9 11" />
  </>
));
export const AttachIcon = createAppIcon('attach', <path d="M15.5 9.5l-5.3 5.3a3.5 3.5 0 0 1-4.95-4.95l5.65-5.65a2.35 2.35 0 0 1 3.3 3.3l-5.6 5.6a1.2 1.2 0 0 1-1.7-1.7l5.05-5.05" />);
export const MicIcon = createAppIcon('mic', (
  <>
    <Tint d="M10 2.75h0a2.75 2.75 0 0 1 2.75 2.75v3.75a2.75 2.75 0 0 1-2.75 2.75h-0a2.75 2.75 0 0 1-2.75-2.75v-3.75a2.75 2.75 0 0 1 2.75-2.75z" />
    <rect x="7.25" y="2.75" width="5.5" height="9.25" rx="2.75" />
    <path d="M4.75 9.75a5.25 5.25 0 0 0 10.5 0" />
    <path d="M10 15v2.25" />
  </>
));
export const LinkIcon = createAppIcon('link', (
  <>
    <path d="M8.25 11.75a3.25 3.25 0 0 0 4.6 0l2.3-2.3a3.25 3.25 0 0 0-4.6-4.6l-.9.9" />
    <path d="M11.75 8.25a3.25 3.25 0 0 0-4.6 0l-2.3 2.3a3.25 3.25 0 0 0 4.6 4.6l.9-.9" />
  </>
));
export const UnlinkIcon = createAppIcon('unlink', (
  <>
    <path d="M11.1 6.4l.85-.85a3.25 3.25 0 0 1 4.6 4.6l-.85.85" />
    <path d="M8.9 13.6l-.85.85a3.25 3.25 0 0 1-4.6-4.6l.85-.85" />
    <path d="M7.5 3.25v1.75M3.25 7.5H5M12.5 16.75V15M16.75 12.5H15" />
  </>
));
export const PinIcon = createAppIcon('pin', (
  <>
    <Tint d="M7.5 3.75h5l-.75 4.5 2.75 2.75v1.25h-9V11l2.75-2.75z" />
    <path d="M7.5 3.75h5l-.75 4.5 2.75 2.75v1.25h-9V11l2.75-2.75z" />
    <path d="M10 12.25v4.5" />
  </>
));
export const PinOffIcon = createAppIcon('pin-off', (
  <>
    <path d="M7.5 3.75h5l-.75 4.5 2.75 2.75v1.25h-9V11l2.75-2.75z" />
    <path d="M10 12.25v4.5" />
    <path d="M3.75 3.75l12.5 12.5" />
  </>
));
export const StarIcon = createAppIcon('star', (
  <>
    <Tint d="M10 3.35L11.97 7.89L16.9 8.36L13.19 11.64L14.26 16.47L10 13.95L5.74 16.47L6.81 11.64L3.1 8.36L8.03 7.89Z" />
    <path d="M10 3.35L11.97 7.89L16.9 8.36L13.19 11.64L14.26 16.47L10 13.95L5.74 16.47L6.81 11.64L3.1 8.36L8.03 7.89Z" />
  </>
));
export const HeartIcon = createAppIcon('heart', (
  <>
    <Tint d="M10 16.25s-6.25-3.6-6.25-8a3.5 3.5 0 0 1 6.25-2.15A3.5 3.5 0 0 1 16.25 8.25c0 4.4-6.25 8-6.25 8z" />
    <path d="M10 16.25s-6.25-3.6-6.25-8a3.5 3.5 0 0 1 6.25-2.15A3.5 3.5 0 0 1 16.25 8.25c0 4.4-6.25 8-6.25 8z" />
  </>
));
export const FlagIcon = createAppIcon('flag', (
  <>
    <Tint d="M4.75 4.25c3.5-1.75 5.5 1.75 10.25 0v7.5c-4.75 1.75-6.75-1.75-10.25 0z" />
    <path d="M4.75 17.25V3.75" />
    <path d="M4.75 4.25c3.5-1.75 5.5 1.75 10.25 0v7.5c-4.75 1.75-6.75-1.75-10.25 0" />
  </>
));
export const TagIcon = createAppIcon('tag', (
  <>
    <path d="M3.25 4.1v4.25a1.5 1.5 0 0 0 .45 1.05l6.1 6.1a1.5 1.5 0 0 0 2.1 0l3.95-3.95a1.5 1.5 0 0 0 0-2.1L9.75 3.4a1.5 1.5 0 0 0-1.05-.45H4.4a1.15 1.15 0 0 0-1.15 1.15z" />
    <circle cx="6.6" cy="6.35" r="1.1" fill="currentColor" stroke="none" />
  </>
));
export const EyeIcon = createAppIcon('eye', (
  <>
    <Tint d="M2.75 10s2.6-5.25 7.25-5.25S17.25 10 17.25 10s-2.6 5.25-7.25 5.25S2.75 10 2.75 10z" />
    <path d="M2.75 10s2.6-5.25 7.25-5.25S17.25 10 17.25 10s-2.6 5.25-7.25 5.25S2.75 10 2.75 10z" />
    <circle cx="10" cy="10" r="2.25" />
  </>
));
export const EyeOffIcon = createAppIcon('eye-off', (
  <>
    <path d="M7.4 5.25A7 7 0 0 1 10 4.75c4.65 0 7.25 5.25 7.25 5.25a12.4 12.4 0 0 1-1.95 2.75" />
    <path d="M12.5 13.9a6.7 6.7 0 0 1-2.5.5c-4.65 0-7.25-4.4-7.25-4.4a12.6 12.6 0 0 1 2.4-3" />
    <path d="M8.4 8.4a2.25 2.25 0 0 0 3.2 3.2" />
    <path d="M3.75 3.75l12.5 12.5" />
  </>
));
export const SlidersIcon = createAppIcon('sliders', (
  <>
    <Tint d="M9.5 6.25a2 2 0 1 0 4 0a2 2 0 1 0-4 0zM6.5 13.75a2 2 0 1 0 4 0a2 2 0 1 0-4 0z" />
    <path d="M3.75 6.25h5.75M13.5 6.25h2.75M3.75 13.75h2.75M10.5 13.75h5.75" />
    <circle cx="11.5" cy="6.25" r="2" />
    <circle cx="8.5" cy="13.75" r="2" />
  </>
));
export const ZoomInIcon = createAppIcon('zoom-in', (
  <>
    <circle cx="8.75" cy="8.75" r="5" />
    <path d="M12.5 12.5l3.75 3.75" />
    <path d="M8.75 6.75v4M6.75 8.75h4" />
  </>
));
export const ZoomOutIcon = createAppIcon('zoom-out', (
  <>
    <circle cx="8.75" cy="8.75" r="5" />
    <path d="M12.5 12.5l3.75 3.75" />
    <path d="M6.75 8.75h4" />
  </>
));
export const ExpandIcon = createAppIcon('expand', (
  <>
    <path d="M12.25 3.75h4v4M7.75 16.25h-4v-4" />
    <path d="M16.25 3.75l-4.75 4.75M3.75 16.25l4.75-4.75" />
  </>
));
export const MinimizeIcon = createAppIcon('minimize', (
  <>
    <path d="M4 12h4v4M16 8h-4V4" />
    <path d="M8 12l-4.25 4.25M12 8l4.25-4.25" />
  </>
));
export const TextSelectIcon = createAppIcon('text-select', (
  <>
    <path d="M3.75 6.25v-1a1.5 1.5 0 0 1 1.5-1.5h1M13.75 3.75h1a1.5 1.5 0 0 1 1.5 1.5v1M16.25 13.75v1a1.5 1.5 0 0 1-1.5 1.5h-1M6.25 16.25h-1a1.5 1.5 0 0 1-1.5-1.5v-1" />
    <path d="M7 8h6M7 12h4" />
  </>
));
export const ReplyIcon = createAppIcon('reply', (
  <>
    <path d="M8 12.25L4.25 8.5 8 4.75" />
    <path d="M4.25 8.5h7a4.5 4.5 0 0 1 4.5 4.5v2.25" />
  </>
));
export const QuoteIcon = createAppIcon('quote', (
  <>
    <path d="M8 9.75H5.25a1 1 0 0 1-1-1v-2a1 1 0 0 1 1-1H7a1 1 0 0 1 1 1v3c0 2.25-1 3.75-3.25 4.5" />
    <path d="M15.75 9.75H13a1 1 0 0 1-1-1v-2a1 1 0 0 1 1-1h1.75a1 1 0 0 1 1 1v3c0 2.25-1 3.75-3.25 4.5" />
  </>
));
export const HashIcon = createAppIcon('hash', <path d="M8.25 3.75l-1.5 12.5M13.25 3.75l-1.5 12.5M4.25 7.5h12M3.75 12.5h12" />);
export const AtIcon = createAppIcon('at', (
  <>
    <circle cx="10" cy="10" r="2.75" />
    <path d="M12.75 7.25v3.5a2 2 0 0 0 4 0V10a6.75 6.75 0 1 0-2.65 5.35" />
  </>
));
export const QrIcon = createAppIcon('qr', (
  <>
    <rect x="3.25" y="3.25" width="5" height="5" rx="1.25" />
    <rect x="11.75" y="3.25" width="5" height="5" rx="1.25" />
    <rect x="3.25" y="11.75" width="5" height="5" rx="1.25" />
    <path d="M11.75 11.75h2v2M16.75 11.75v.01M14.75 16.75h2v-2M11.75 15.75v1" />
  </>
));

// 方向
export const ChevronDownIcon = createAppIcon('chevron-down', <path d="M5.5 8l4.5 4.5L14.5 8" />);
export const ChevronUpIcon = createAppIcon('chevron-up', <path d="M5.5 12l4.5-4.5 4.5 4.5" />);
export const ChevronRightIcon = createAppIcon('chevron-right', <path d="M8 5.5l4.5 4.5L8 14.5" />);
export const ChevronLeftIcon = createAppIcon('chevron-left', <path d="M12 5.5L7.5 10l4.5 4.5" />);
export const ArrowUpIcon = createAppIcon('arrow-up', (
  <>
    <path d="M10 16V4.5" />
    <path d="M5.25 9.25L10 4.5l4.75 4.75" />
  </>
));
export const ArrowDownIcon = createAppIcon('arrow-down', (
  <>
    <path d="M10 4v11.5" />
    <path d="M5.25 10.75L10 15.5l4.75-4.75" />
  </>
));
export const ArrowLeftIcon = createAppIcon('arrow-left', (
  <>
    <path d="M16 10H4.5" />
    <path d="M9.25 5.25L4.5 10l4.75 4.75" />
  </>
));
export const ArrowRightIcon = createAppIcon('arrow-right', (
  <>
    <path d="M4 10h11.5" />
    <path d="M10.75 5.25L15.5 10l-4.75 4.75" />
  </>
));
export const ArrowUpRightIcon = createAppIcon('arrow-up-right', (
  <>
    <path d="M6 14l8-8" />
    <path d="M7.5 6H14v6.5" />
  </>
));
export const ArrowDownLeftIcon = createAppIcon('arrow-down-left', (
  <>
    <path d="M14 6l-8 8" />
    <path d="M12.5 14H6V7.5" />
  </>
));
export const ArrowUpLineIcon = createAppIcon('arrow-up-line', (
  <>
    <path d="M4.75 3.75h10.5" />
    <path d="M10 16.25V7.25" />
    <path d="M5.75 11.5L10 7.25l4.25 4.25" />
  </>
));

// 状态与反馈
export const LoaderIcon = createAppIcon('loader', (
  <>
    <circle cx="10" cy="10" r="6.5" opacity={0.3} />
    <path d="M10 3.5a6.5 6.5 0 0 1 6.5 6.5" />
  </>
));
export const SuccessIcon = createAppIcon('success', (
  <>
    <Tint d="M3.25 10a6.75 6.75 0 1 0 13.5 0a6.75 6.75 0 1 0-13.5 0z" />
    <circle cx="10" cy="10" r="6.75" />
    <path d="M7 10.25l2.1 2.1 3.9-4.35" />
  </>
));
export const XCircleIcon = createAppIcon('x-circle', (
  <>
    <Tint d="M3.25 10a6.75 6.75 0 1 0 13.5 0a6.75 6.75 0 1 0-13.5 0z" />
    <circle cx="10" cy="10" r="6.75" />
    <path d="M7.75 7.75l4.5 4.5M12.25 7.75l-4.5 4.5" />
  </>
));
export const AlertIcon = createAppIcon('alert', (
  <>
    <Tint d="M3.25 10a6.75 6.75 0 1 0 13.5 0a6.75 6.75 0 1 0-13.5 0z" />
    <circle cx="10" cy="10" r="6.75" />
    <path d="M10 6.6v3.9" />
    <circle cx="10" cy="13.35" r="0.95" fill="currentColor" stroke="none" />
  </>
));
export const WarningIcon = createAppIcon('warning', (
  <>
    <Tint d="M8.6 3.9a1.6 1.6 0 0 1 2.8 0l5.75 10.1a1.6 1.6 0 0 1-1.4 2.4H4.25a1.6 1.6 0 0 1-1.4-2.4z" />
    <path d="M8.6 3.9a1.6 1.6 0 0 1 2.8 0l5.75 10.1a1.6 1.6 0 0 1-1.4 2.4H4.25a1.6 1.6 0 0 1-1.4-2.4z" />
    <path d="M10 7.9v3.35" />
    <circle cx="10" cy="13.85" r="0.95" fill="currentColor" stroke="none" />
  </>
));
export const InfoIcon = createAppIcon('info', (
  <>
    <Tint d="M3.25 10a6.75 6.75 0 1 0 13.5 0a6.75 6.75 0 1 0-13.5 0z" />
    <circle cx="10" cy="10" r="6.75" />
    <path d="M10 9.25v4.25" />
    <circle cx="10" cy="6.65" r="0.95" fill="currentColor" stroke="none" />
  </>
));
export const HelpIcon = createAppIcon('help', (
  <>
    <Tint d="M3.25 10a6.75 6.75 0 1 0 13.5 0a6.75 6.75 0 1 0-13.5 0z" />
    <circle cx="10" cy="10" r="6.75" />
    <path d="M8.4 8.35a1.6 1.6 0 1 1 2.35 1.4c-.5.25-.75.6-.75 1.15" />
    <circle cx="10" cy="13.1" r="0.85" fill="currentColor" stroke="none" />
  </>
));
export const BanIcon = createAppIcon('ban', (
  <>
    <circle cx="10" cy="10" r="6.75" />
    <path d="M5.25 5.25l9.5 9.5" />
  </>
));
export const CircleDotIcon = createAppIcon('circle-dot', (
  <>
    <circle cx="10" cy="10" r="6.75" />
    <circle cx="10" cy="10" r="2.25" fill="currentColor" stroke="none" />
  </>
));
export const StopCircleIcon = createAppIcon('stop-circle', (
  <>
    <Tint d="M3.25 10a6.75 6.75 0 1 0 13.5 0a6.75 6.75 0 1 0-13.5 0z" />
    <circle cx="10" cy="10" r="6.75" />
    <rect x="7.6" y="7.6" width="4.8" height="4.8" rx="1.25" />
  </>
));
export const ShieldIcon = createAppIcon('shield', (
  <>
    <Tint d="M10 2.75l5.75 2v4.5c0 3.6-2.4 6.2-5.75 7.5-3.35-1.3-5.75-3.9-5.75-7.5v-4.5z" />
    <path d="M10 2.75l5.75 2v4.5c0 3.6-2.4 6.2-5.75 7.5-3.35-1.3-5.75-3.9-5.75-7.5v-4.5z" />
  </>
));
export const ShieldCheckIcon = createAppIcon('shield-check', (
  <>
    <Tint d="M10 2.75l5.75 2v4.5c0 3.6-2.4 6.2-5.75 7.5-3.35-1.3-5.75-3.9-5.75-7.5v-4.5z" />
    <path d="M10 2.75l5.75 2v4.5c0 3.6-2.4 6.2-5.75 7.5-3.35-1.3-5.75-3.9-5.75-7.5v-4.5z" />
    <path d="M7.5 9.9l1.75 1.75 3.25-3.5" />
  </>
));
export const ShieldAlertIcon = createAppIcon('shield-alert', (
  <>
    <Tint d="M10 2.75l5.75 2v4.5c0 3.6-2.4 6.2-5.75 7.5-3.35-1.3-5.75-3.9-5.75-7.5v-4.5z" />
    <path d="M10 2.75l5.75 2v4.5c0 3.6-2.4 6.2-5.75 7.5-3.35-1.3-5.75-3.9-5.75-7.5v-4.5z" />
    <path d="M10 6.75v3.5" />
    <circle cx="10" cy="12.6" r="0.9" fill="currentColor" stroke="none" />
  </>
));
export const ShieldQuestionIcon = createAppIcon('shield-question', (
  <>
    <Tint d="M10 2.75l5.75 2v4.5c0 3.6-2.4 6.2-5.75 7.5-3.35-1.3-5.75-3.9-5.75-7.5v-4.5z" />
    <path d="M10 2.75l5.75 2v4.5c0 3.6-2.4 6.2-5.75 7.5-3.35-1.3-5.75-3.9-5.75-7.5v-4.5z" />
    <path d="M8.6 8.1a1.5 1.5 0 1 1 2.2 1.35c-.5.25-.8.6-.8 1.15" />
    <circle cx="10" cy="12.85" r="0.85" fill="currentColor" stroke="none" />
  </>
));
export const ActivityIcon = createAppIcon('activity', <path d="M2.75 10h3l2-5 4.5 10 2-5h3" />);
export const HeartPulseIcon = createAppIcon('heart-pulse', (
  <>
    <path d="M10 16.25s-6.25-3.6-6.25-8a3.5 3.5 0 0 1 6.25-2.15A3.5 3.5 0 0 1 16.25 8.25c0 4.4-6.25 8-6.25 8z" />
    <path d="M5.25 9.75h2.25l1.25-2 2 4 1.25-2h2.75" />
  </>
));
export const GaugeIcon = createAppIcon('gauge', (
  <>
    <path d="M4.1 14.5a6.75 6.75 0 1 1 11.8 0" />
    <path d="M10 11.75l3-3.5" />
    <circle cx="10" cy="11.75" r="1.25" fill="currentColor" stroke="none" />
  </>
));

// 时间与计划
export const ClockIcon = createAppIcon('clock', (
  <>
    <Tint d="M3.25 10a6.75 6.75 0 1 0 13.5 0a6.75 6.75 0 1 0-13.5 0z" />
    <circle cx="10" cy="10" r="6.75" />
    <path d="M10 6.25V10l2.6 1.75" />
  </>
));
export const TimerIcon = createAppIcon('timer', (
  <>
    <Tint d="M4 11a6 6 0 1 0 12 0a6 6 0 1 0-12 0z" />
    <circle cx="10" cy="11" r="6" />
    <path d="M8 2.75h4" />
    <path d="M10 11V8" />
    <path d="M15 5.6l1.1-1.1" />
  </>
));
export const HistoryIcon = createAppIcon('history', (
  <>
    <path d="M3.75 10a6.25 6.25 0 1 0 1.85-4.45L3.5 7.6" />
    <path d="M3.5 4v3.6h3.6" />
    <path d="M10 6.75V10l2.25 1.5" />
  </>
));
export const CalendarIcon = createAppIcon('calendar', (
  <>
    <Tint d="M6.25 4.25h7.5a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3h-7.5a3 3 0 0 1-3-3v-6a3 3 0 0 1 3-3z" />
    <rect x="3.25" y="4.25" width="13.5" height="12" rx="3" />
    <path d="M3.25 8.25h13.5" />
    <path d="M7 2.75v3M13 2.75v3" />
  </>
));
export const TargetIcon = createAppIcon('target', (
  <>
    <circle cx="10" cy="10" r="6.75" />
    <circle cx="10" cy="10" r="3.75" />
    <circle cx="10" cy="10" r="1.1" fill="currentColor" stroke="none" />
  </>
));
export const ListTodoIcon = createAppIcon('list-todo', (
  <>
    <rect x="3.25" y="4.25" width="4" height="4" rx="1" />
    <path d="M4.25 14l1 1 2-2.25" />
    <path d="M10 6.25h6.75M10 14h6.75" />
  </>
));
export const ListChecksIcon = createAppIcon('list-checks', (
  <>
    <path d="M3.5 5.75l1.25 1.25 2.25-2.5" />
    <path d="M3.5 12.75l1.25 1.25 2.25-2.5" />
    <path d="M10 6h6.5M10 13h6.5" />
  </>
));
export const ListIcon = createAppIcon('list', (
  <>
    <path d="M7.25 5.75h9M7.25 10h9M7.25 14.25h9" />
    <circle cx="3.9" cy="5.75" r="1" fill="currentColor" stroke="none" />
    <circle cx="3.9" cy="10" r="1" fill="currentColor" stroke="none" />
    <circle cx="3.9" cy="14.25" r="1" fill="currentColor" stroke="none" />
  </>
));
export const PlayIcon = createAppIcon('play', (
  <>
    <Tint d="M6.5 4.9a1 1 0 0 1 1.5-.85l7.6 5.1a1 1 0 0 1 0 1.7l-7.6 5.1a1 1 0 0 1-1.5-.85z" />
    <path d="M6.5 4.9a1 1 0 0 1 1.5-.85l7.6 5.1a1 1 0 0 1 0 1.7l-7.6 5.1a1 1 0 0 1-1.5-.85z" />
  </>
));
export const PauseIcon = createAppIcon('pause', (
  <>
    <Tint d="M6.5 4.25h0.5a1.25 1.25 0 0 1 1.25 1.25v9a1.25 1.25 0 0 1-1.25 1.25h-0.5a1.25 1.25 0 0 1-1.25-1.25v-9a1.25 1.25 0 0 1 1.25-1.25zM13 4.25h0.5a1.25 1.25 0 0 1 1.25 1.25v9a1.25 1.25 0 0 1-1.25 1.25h-0.5a1.25 1.25 0 0 1-1.25-1.25v-9a1.25 1.25 0 0 1 1.25-1.25z" />
    <rect x="5.25" y="4.25" width="3" height="11.5" rx="1.25" />
    <rect x="11.75" y="4.25" width="3" height="11.5" rx="1.25" />
  </>
));
export const StopIcon = createAppIcon('stop', (
  <>
    <Tint d="M7.5 4.75h5a2.75 2.75 0 0 1 2.75 2.75v5a2.75 2.75 0 0 1-2.75 2.75h-5a2.75 2.75 0 0 1-2.75-2.75v-5a2.75 2.75 0 0 1 2.75-2.75z" />
    <rect x="4.75" y="4.75" width="10.5" height="10.5" rx="2.75" />
  </>
));
export const ZapIcon = createAppIcon('zap', (
  <>
    <Tint d="M11 2.75L4.75 11.25H10l-1 6 6.25-8.5H10z" />
    <path d="M11 2.75L4.75 11.25H10l-1 6 6.25-8.5H10z" />
  </>
));
export const PowerIcon = createAppIcon('power', (
  <>
    <path d="M10 3.25v6.25" />
    <path d="M6.25 5.6a6 6 0 1 0 7.5 0" />
  </>
));
export const PowerOffIcon = createAppIcon('power-off', (
  <>
    <path d="M10 3.25v4" />
    <path d="M6.25 5.6a6 6 0 0 0 8.4 8.4" />
    <path d="M15.5 12.75a6 6 0 0 0-1.75-7.15" />
    <path d="M3.75 3.75l12.5 12.5" />
  </>
));

// 对象与能力
export const FolderIcon = createAppIcon('folder', (
  <>
    <Tint d="M2.75 6.25a2.5 2.5 0 0 1 2.5-2.5h2.6l1.9 2h5a2.5 2.5 0 0 1 2.5 2.5v5.5a2.5 2.5 0 0 1-2.5 2.5h-9.5a2.5 2.5 0 0 1-2.5-2.5z" />
    <path d="M2.75 6.25a2.5 2.5 0 0 1 2.5-2.5h2.6l1.9 2h5a2.5 2.5 0 0 1 2.5 2.5v5.5a2.5 2.5 0 0 1-2.5 2.5h-9.5a2.5 2.5 0 0 1-2.5-2.5z" />
  </>
));
export const FolderOpenIcon = createAppIcon('folder-open', (
  <>
    <Tint d="M3 14.25l1.75-4.45a2 2 0 0 1 1.85-1.3h9.6a1 1 0 0 1 .95 1.3l-1.5 4.7a2.25 2.25 0 0 1-2.15 1.5H5.25A2.25 2.25 0 0 1 3 14.25z" />
    <path d="M3 14.25V6a2.25 2.25 0 0 1 2.25-2.25h2.5l1.75 1.75h4.75a2.25 2.25 0 0 1 2.25 2.25v.75" />
    <path d="M3 14.25l1.75-4.45a2 2 0 0 1 1.85-1.3h9.6a1 1 0 0 1 .95 1.3l-1.5 4.7a2.25 2.25 0 0 1-2.15 1.5H5.25A2.25 2.25 0 0 1 3 14.25z" />
  </>
));
export const FolderPlusIcon = createAppIcon('folder-plus', (
  <>
    <path d="M2.75 6.25a2.5 2.5 0 0 1 2.5-2.5h2.6l1.9 2h5a2.5 2.5 0 0 1 2.5 2.5v5.5a2.5 2.5 0 0 1-2.5 2.5h-9.5a2.5 2.5 0 0 1-2.5-2.5z" />
    <path d="M10 8.75v5M7.5 11.25h5" />
  </>
));
export const FolderUpIcon = createAppIcon('folder-up', (
  <>
    <path d="M2.75 6.25a2.5 2.5 0 0 1 2.5-2.5h2.6l1.9 2h5a2.5 2.5 0 0 1 2.5 2.5v5.5a2.5 2.5 0 0 1-2.5 2.5h-9.5a2.5 2.5 0 0 1-2.5-2.5z" />
    <path d="M10 13.75V9" />
    <path d="M7.75 11.25L10 9l2.25 2.25" />
  </>
));
export const FolderArchiveIcon = createAppIcon('folder-archive', (
  <>
    <path d="M2.75 6.25a2.5 2.5 0 0 1 2.5-2.5h2.6l1.9 2h5a2.5 2.5 0 0 1 2.5 2.5v5.5a2.5 2.5 0 0 1-2.5 2.5h-9.5a2.5 2.5 0 0 1-2.5-2.5z" />
    <rect x="7.75" y="9" width="4.5" height="4.25" rx="1" />
    <path d="M7.75 10.75h4.5" />
  </>
));
export const DocumentIcon = createAppIcon('document', (
  <>
    <Tint d="M5.75 2.75h5.5l4 4v8.5a2 2 0 0 1-2 2h-7.5a2 2 0 0 1-2-2V4.75a2 2 0 0 1 2-2z" />
    <path d="M5.75 2.75h5.5l4 4v8.5a2 2 0 0 1-2 2h-7.5a2 2 0 0 1-2-2V4.75a2 2 0 0 1 2-2z" />
    <path d="M11 2.75v3a1 1 0 0 0 1 1h3.25" />
    <path d="M7.25 10.5h5.5M7.25 13.5h3.5" />
  </>
));
export const FilePlusIcon = createAppIcon('file-plus', (
  <>
    <path d="M5.75 2.75h5.5l4 4v8.5a2 2 0 0 1-2 2h-7.5a2 2 0 0 1-2-2V4.75a2 2 0 0 1 2-2z" />
    <path d="M11 2.75v3a1 1 0 0 0 1 1h3.25" />
    <path d="M10 9.25v5M7.5 11.75h5" />
  </>
));
export const FileCheckIcon = createAppIcon('file-check', (
  <>
    <path d="M5.75 2.75h5.5l4 4v8.5a2 2 0 0 1-2 2h-7.5a2 2 0 0 1-2-2V4.75a2 2 0 0 1 2-2z" />
    <path d="M11 2.75v3a1 1 0 0 0 1 1h3.25" />
    <path d="M7.5 12l1.75 1.75 3.25-3.5" />
  </>
));
export const FileEditIcon = createAppIcon('file-edit', (
  <>
    <path d="M5.75 2.75h5.5l4 4v8.5a2 2 0 0 1-2 2h-7.5a2 2 0 0 1-2-2V4.75a2 2 0 0 1 2-2z" />
    <path d="M11 2.75v3a1 1 0 0 0 1 1h3.25" />
    <path d="M7.25 14.5l.4-1.6 3.6-3.6a.9.9 0 0 1 1.3 1.3l-3.6 3.6z" />
  </>
));
export const FileWarningIcon = createAppIcon('file-warning', (
  <>
    <path d="M5.75 2.75h5.5l4 4v8.5a2 2 0 0 1-2 2h-7.5a2 2 0 0 1-2-2V4.75a2 2 0 0 1 2-2z" />
    <path d="M11 2.75v3a1 1 0 0 0 1 1h3.25" />
    <path d="M10 9.25v2.75" />
    <circle cx="10" cy="14.25" r="0.9" fill="currentColor" stroke="none" />
  </>
));
export const NotebookIcon = createAppIcon('notebook', (
  <>
    <rect x="4.25" y="2.75" width="11.5" height="14.5" rx="2.5" />
    <path d="M7.5 2.75v14.5" />
    <path d="M10.25 7h2.75M10.25 10h2.75" />
  </>
));
export const BookIcon = createAppIcon('book', (
  <>
    <path d="M10 5.5c-1.5-1.25-3.75-1.75-6.25-1.75v11c2.5 0 4.75.5 6.25 1.75 1.5-1.25 3.75-1.75 6.25-1.75v-11c-2.5 0-4.75.5-6.25 1.75z" />
    <path d="M10 5.5v11" />
  </>
));
export const ImageIcon = createAppIcon('image', (
  <>
    <Tint d="M5.75 3.75h8.5a3 3 0 0 1 3 3v6.5a3 3 0 0 1-3 3h-8.5a3 3 0 0 1-3-3v-6.5a3 3 0 0 1 3-3z" />
    <rect x="2.75" y="3.75" width="14.5" height="12.5" rx="3" />
    <path d="M3 14l4.25-4.25a1.5 1.5 0 0 1 2.1 0l4.4 4.4" />
    <path d="M12 12.4l1.15-1.15a1.5 1.5 0 0 1 2.1 0l1.85 1.85" />
    <circle cx="12.75" cy="7.5" r="1.25" fill="currentColor" stroke="none" />
  </>
));
export const ImagePlusIcon = createAppIcon('image-plus', (
  <>
    <path d="M10.25 3.75H5.75a3 3 0 0 0-3 3v6.5a3 3 0 0 0 3 3h8.5a3 3 0 0 0 3-3V10" />
    <path d="M3 14l4.25-4.25a1.5 1.5 0 0 1 2.1 0l4.4 4.4" />
    <path d="M14.75 2.75v5M12.25 5.25h5" />
  </>
));
export const VideoIcon = createAppIcon('video', (
  <>
    <Tint d="M5.25 5.25h5.5a2.5 2.5 0 0 1 2.5 2.5v4.5a2.5 2.5 0 0 1-2.5 2.5h-5.5a2.5 2.5 0 0 1-2.5-2.5v-4.5a2.5 2.5 0 0 1 2.5-2.5z" />
    <rect x="2.75" y="5.25" width="10.5" height="9.5" rx="2.5" />
    <path d="M13.25 8.75l3.25-2v6.5l-3.25-2" />
  </>
));
export const AudioLinesIcon = createAppIcon('audio-lines', <path d="M3.5 8.5v3M6.75 5.75v8.5M10 3.5v13M13.25 6.75v6.5M16.5 9v2" />);
export const VolumeIcon = createAppIcon('volume', (
  <>
    <Tint d="M3.75 8a1 1 0 0 1 1-1H7l3.5-3v12L7 13H4.75a1 1 0 0 1-1-1z" />
    <path d="M3.75 8a1 1 0 0 1 1-1H7l3.5-3v12L7 13H4.75a1 1 0 0 1-1-1z" />
    <path d="M13.25 7.5a3.5 3.5 0 0 1 0 5" />
    <path d="M15.25 5.25a6.5 6.5 0 0 1 0 9.5" />
  </>
));
export const VolumeXIcon = createAppIcon('volume-x', (
  <>
    <Tint d="M3.75 8a1 1 0 0 1 1-1H7l3.5-3v12L7 13H4.75a1 1 0 0 1-1-1z" />
    <path d="M3.75 8a1 1 0 0 1 1-1H7l3.5-3v12L7 13H4.75a1 1 0 0 1-1-1z" />
    <path d="M13 8l4 4M17 8l-4 4" />
  </>
));
export const TerminalIcon = createAppIcon('terminal', (
  <>
    <Tint d="M5.75 3.75h8.5a3 3 0 0 1 3 3v6.5a3 3 0 0 1-3 3h-8.5a3 3 0 0 1-3-3v-6.5a3 3 0 0 1 3-3z" />
    <rect x="2.75" y="3.75" width="14.5" height="12.5" rx="3" />
    <path d="M6.25 8l2.25 2-2.25 2" />
    <path d="M10.5 12.25h3.25" />
  </>
));
export const SlashCommandIcon = createAppIcon('slash-command', (
  <>
    <rect x="3.25" y="3.25" width="13.5" height="13.5" rx="3.5" />
    <path d="M11.75 6.75l-3.5 6.5" />
  </>
));
export const CodeIcon = createAppIcon('code', (
  <>
    <path d="M7 6.25L3.25 10 7 13.75" />
    <path d="M13 6.25L16.75 10 13 13.75" />
    <path d="M11.25 4.75l-2.5 10.5" />
  </>
));
export const SearchCodeIcon = createAppIcon('search-code', (
  <>
    <circle cx="8.75" cy="8.75" r="5" />
    <path d="M12.5 12.5l3.75 3.75" />
    <path d="M7.5 7.25L6 8.75l1.5 1.5M10 7.25l1.5 1.5-1.5 1.5" />
  </>
));
export const GlobeIcon = createAppIcon('globe', (
  <>
    <Tint d="M3.25 10a6.75 6.75 0 1 0 13.5 0a6.75 6.75 0 1 0-13.5 0z" />
    <circle cx="10" cy="10" r="6.75" />
    <path d="M10 3.25c-1.9 1.9-2.85 4.15-2.85 6.75s.95 4.85 2.85 6.75c1.9-1.9 2.85-4.15 2.85-6.75S11.9 5.15 10 3.25z" />
    <path d="M3.25 10h13.5" />
  </>
));
export const LocateIcon = createAppIcon('locate', (
  <>
    <circle cx="10" cy="10" r="5.25" />
    <circle cx="10" cy="10" r="1.75" />
    <path d="M10 2.75v2M10 15.25v2M2.75 10h2M15.25 10h2" />
  </>
));
export const CloudIcon = createAppIcon('cloud', (
  <>
    <Tint d="M6 15.25a3.75 3.75 0 0 1-.6-7.45 5 5 0 0 1 9.6.95 3.25 3.25 0 0 1-.25 6.5z" />
    <path d="M6 15.25a3.75 3.75 0 0 1-.6-7.45 5 5 0 0 1 9.6.95 3.25 3.25 0 0 1-.25 6.5z" />
  </>
));
export const DatabaseIcon = createAppIcon('database', (
  <>
    <ellipse cx="10" cy="5.25" rx="5.75" ry="2.25" />
    <path d="M4.25 5.25v9.5c0 1.25 2.6 2.25 5.75 2.25s5.75-1 5.75-2.25v-9.5" />
    <path d="M4.25 10c0 1.25 2.6 2.25 5.75 2.25s5.75-1 5.75-2.25" />
  </>
));
export const LayersIcon = createAppIcon('layers', (
  <>
    <Tint d="M10 3.25l6.75 3.5L10 10.25 3.25 6.75z" />
    <path d="M10 3.25l6.75 3.5L10 10.25 3.25 6.75z" />
    <path d="M3.25 10.25L10 13.75l6.75-3.5" />
    <path d="M3.25 13.5L10 17l6.75-3.5" />
  </>
));
export const ChartIcon = createAppIcon('chart', (
  <>
    <Tint d="M9.75 3.75h0.5a1.25 1.25 0 0 1 1.25 1.25v10a1.25 1.25 0 0 1-1.25 1.25h-0.5a1.25 1.25 0 0 1-1.25-1.25v-10a1.25 1.25 0 0 1 1.25-1.25z" />
    <rect x="3.75" y="10.25" width="3" height="6" rx="1.25" />
    <rect x="8.5" y="3.75" width="3" height="12.5" rx="1.25" />
    <rect x="13.25" y="7.25" width="3" height="9" rx="1.25" />
  </>
));
export const CoinsIcon = createAppIcon('coins', (
  <>
    <ellipse cx="10" cy="5.5" rx="5.5" ry="2" />
    <path d="M4.5 5.5v3c0 1.1 2.45 2 5.5 2s5.5-.9 5.5-2v-3" />
    <path d="M4.5 8.5v3c0 1.1 2.45 2 5.5 2s5.5-.9 5.5-2v-3" />
    <path d="M4.5 11.5v3c0 1.1 2.45 2 5.5 2s5.5-.9 5.5-2v-3" />
  </>
));
export const BrainIcon = createAppIcon('brain', (
  <>
    <path d="M10 4.6a2.4 2.4 0 0 0-4.3 1.25 2.7 2.7 0 0 0-1.45 4.4 2.7 2.7 0 0 0 1.9 4.5A2.4 2.4 0 0 0 10 15.6" />
    <path d="M10 4.6a2.4 2.4 0 0 1 4.3 1.25 2.7 2.7 0 0 1 1.45 4.4 2.7 2.7 0 0 1-1.9 4.5A2.4 2.4 0 0 1 10 15.6" />
    <path d="M10 4.6v11" />
    <path d="M7.4 8.6c.9.6 1.9.6 2.6 0" />
    <path d="M12.6 11.6c-.9-.6-1.9-.6-2.6 0" />
  </>
));
export const WrenchIcon = createAppIcon('wrench', (
  <>
    <Tint d="M12.6 3.4a4 4 0 0 0-4.5 5.3l-4.6 4.6a1.6 1.6 0 0 0 2.25 2.25l4.6-4.6a4 4 0 0 0 5.3-4.5l-2.4 2.4-2.25-.6-.6-2.25z" />
    <path d="M12.6 3.4a4 4 0 0 0-4.5 5.3l-4.6 4.6a1.6 1.6 0 0 0 2.25 2.25l4.6-4.6a4 4 0 0 0 5.3-4.5l-2.4 2.4-2.25-.6-.6-2.25z" />
  </>
));
export const PluginIcon = createAppIcon('plugin', (
  <>
    <Tint d="M4.25 6.75a1.5 1.5 0 0 1 1.5-1.5h2.5a1.75 1.75 0 0 1 3.5 0h2.5a1.5 1.5 0 0 1 1.5 1.5v2.5a1.75 1.75 0 0 1 0 3.5v2.5a1.5 1.5 0 0 1-1.5 1.5h-8.5a1.5 1.5 0 0 1-1.5-1.5z" />
    <path d="M4.25 6.75a1.5 1.5 0 0 1 1.5-1.5h2.5a1.75 1.75 0 0 1 3.5 0h2.5a1.5 1.5 0 0 1 1.5 1.5v2.5a1.75 1.75 0 0 1 0 3.5v2.5a1.5 1.5 0 0 1-1.5 1.5h-8.5a1.5 1.5 0 0 1-1.5-1.5z" />
  </>
));
export const PlugIcon = createAppIcon('plug', (
  <>
    <Tint d="M5 6.25h10v2.5a5 5 0 0 1-10 0z" />
    <path d="M7.25 2.75v3.5M12.75 2.75v3.5" />
    <path d="M5 6.25h10v2.5a5 5 0 0 1-10 0z" />
    <path d="M10 13.75v3.5" />
  </>
));
export const GitBranchIcon = createAppIcon('git-branch', (
  <>
    <circle cx="6" cy="5" r="1.75" />
    <circle cx="6" cy="15" r="1.75" />
    <circle cx="14" cy="6.5" r="1.75" />
    <path d="M6 6.75v6.5" />
    <path d="M14 8.25v.25a3 3 0 0 1-3 3H8.75A2.75 2.75 0 0 0 6 14.25" />
  </>
));
export const RadioIcon = createAppIcon('radio', (
  <>
    <circle cx="10" cy="8.75" r="1.4" fill="currentColor" stroke="none" />
    <path d="M10 10.25v6.5" />
    <path d="M7.1 5.9a4 4 0 0 0 0 5.7" />
    <path d="M12.9 5.9a4 4 0 0 1 0 5.7" />
    <path d="M4.75 3.6a7.25 7.25 0 0 0 0 10.3" />
    <path d="M15.25 3.6a7.25 7.25 0 0 1 0 10.3" />
  </>
));
export const MonitorIcon = createAppIcon('monitor', (
  <>
    <Tint d="M5.25 3.75h9.5a2.5 2.5 0 0 1 2.5 2.5v5a2.5 2.5 0 0 1-2.5 2.5h-9.5a2.5 2.5 0 0 1-2.5-2.5v-5a2.5 2.5 0 0 1 2.5-2.5z" />
    <rect x="2.75" y="3.75" width="14.5" height="10" rx="2.5" />
    <path d="M7 16.75h6" />
    <path d="M10 13.75v3" />
  </>
));
export const CameraIcon = createAppIcon('camera', (
  <>
    <Tint d="M3.25 7.25a2 2 0 0 1 2-2h1.6l1.25-1.75h3.8l1.25 1.75h1.6a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-9.5a2 2 0 0 1-2-2z" />
    <path d="M3.25 7.25a2 2 0 0 1 2-2h1.6l1.25-1.75h3.8l1.25 1.75h1.6a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-9.5a2 2 0 0 1-2-2z" />
    <circle cx="10" cy="10.75" r="2.75" />
  </>
));
export const PackageIcon = createAppIcon('package', (
  <>
    <Tint d="M10 2.75l6.25 3.5v7.5L10 17.25l-6.25-3.5v-7.5z" />
    <path d="M10 2.75l6.25 3.5v7.5L10 17.25l-6.25-3.5v-7.5z" />
    <path d="M3.75 6.25L10 9.75l6.25-3.5" />
    <path d="M10 9.75v7.5" />
    <path d="M6.9 4.5l6.25 3.5" />
  </>
));
export const PackagePlusIcon = createAppIcon('package-plus', (
  <>
    <path d="M16.25 9.5V6.25L10 2.75l-6.25 3.5v7.5L10 17.25" />
    <path d="M3.75 6.25L10 9.75l6.25-3.5" />
    <path d="M10 9.75v7.5" />
    <path d="M15 12.5V17M12.75 14.75h4.5" />
  </>
));
export const MonitorUpIcon = createAppIcon('monitor-up', (
  <>
    <rect x="2.75" y="3.75" width="14.5" height="10" rx="2.5" />
    <path d="M7 16.75h6" />
    <path d="M10 13.75v3" />
    <path d="M7.75 9.25L10 7l2.25 2.25" />
    <path d="M10 7v4.25" />
  </>
));
export const PaletteIcon = createAppIcon('palette', (
  <>
    <path d="M10 3.25a6.75 6.75 0 0 0 0 13.5c1 0 1.5-.6 1.5-1.4 0-.45-.2-.8-.45-1.1-.25-.3-.45-.65-.45-1.1 0-.8.6-1.4 1.4-1.4h1.7a3.05 3.05 0 0 0 3.05-3.05C16.75 5.85 13.75 3.25 10 3.25z" />
    <circle cx="6.6" cy="9.4" r="1" fill="currentColor" stroke="none" />
    <circle cx="8.4" cy="6.4" r="1" fill="currentColor" stroke="none" />
    <circle cx="12" cy="6.4" r="1" fill="currentColor" stroke="none" />
  </>
));
export const KeyIcon = createAppIcon('key', (
  <>
    <circle cx="6.75" cy="13.25" r="3" />
    <path d="M8.9 11.1l6.35-6.35" />
    <path d="M13.25 6.75l2 2" />
    <path d="M11.5 8.5l1.5 1.5" />
  </>
));
export const LockIcon = createAppIcon('lock', (
  <>
    <Tint d="M6.5 9h7a2.25 2.25 0 0 1 2.25 2.25v3.5a2.25 2.25 0 0 1-2.25 2.25h-7a2.25 2.25 0 0 1-2.25-2.25v-3.5a2.25 2.25 0 0 1 2.25-2.25z" />
    <rect x="4.25" y="9" width="11.5" height="8" rx="2.25" />
    <path d="M7 9V6.5a3 3 0 0 1 6 0V9" />
  </>
));
export const LockOpenIcon = createAppIcon('lock-open', (
  <>
    <Tint d="M6.5 9h7a2.25 2.25 0 0 1 2.25 2.25v3.5a2.25 2.25 0 0 1-2.25 2.25h-7a2.25 2.25 0 0 1-2.25-2.25v-3.5a2.25 2.25 0 0 1 2.25-2.25z" />
    <rect x="4.25" y="9" width="11.5" height="8" rx="2.25" />
    <path d="M7 9V6.5a3 3 0 0 1 5.85-.95" />
  </>
));
