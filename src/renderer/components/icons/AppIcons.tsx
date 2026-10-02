import type { ReactNode, SVGProps } from 'react';

/**
 * MyAgents product icon set (app chrome: sidebar, navigation, shell actions).
 *
 * Grid: 20×20 viewBox, 2px live-area padding, 1.5 stroke with round caps and
 * joins. Rendered at the usual 16px slot this yields a ~1.2px line that sits
 * lighter than the 14px label next to it instead of competing with it.
 * Corners use a 3–3.5 radius so containers share one soft silhouette.
 *
 * Each icon may carry an `app-icon-tint` layer: a solid shape that stays
 * invisible until a host sets `--app-icon-tint` (e.g. a selected nav row),
 * giving active states a quiet duotone fill without swapping glyphs.
 *
 * File/folder identity stays in `components/file-icon/`; workspace avatars
 * stay in `WorkspaceIcon`. Menus and dense tool UIs may keep lucide.
 */
export type AppIconProps = SVGProps<SVGSVGElement>;

function createAppIcon(name: string, children: ReactNode) {
  function AppIcon({ className, ...props }: AppIconProps) {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 20 20"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
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

export const SidebarIcon = createAppIcon('sidebar', (
  <>
    <Tint d="M6 3.75h1.75v12.5H6A3.25 3.25 0 0 1 2.75 13V7A3.25 3.25 0 0 1 6 3.75z" />
    <rect x="2.75" y="3.75" width="14.5" height="12.5" rx="3.25" />
    <path d="M7.75 3.75v12.5" />
  </>
));

export const ComposeIcon = createAppIcon('compose', (
  <>
    <path d="M9.25 3.75H6.75a3 3 0 0 0-3 3v6.5a3 3 0 0 0 3 3h6.5a3 3 0 0 0 3-3v-2.5" />
    <path d="M14.4 3.35a1.55 1.55 0 0 1 2.2 2.2L10.75 11.4l-2.9.75.75-2.9z" />
  </>
));

export const SearchIcon = createAppIcon('search', (
  <>
    <Tint d="M8.75 3.75a5 5 0 1 1 0 10 5 5 0 0 1 0-10z" />
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
    <Tint d="M7.75 4.25a2.75 2.75 0 1 1 0 5.5 2.75 2.75 0 0 1 0-5.5z" />
    <circle cx="7.75" cy="7" r="2.75" />
    <path d="M2.75 16.25c0-2.85 2.2-4.75 5-4.75s5 1.9 5 4.75" />
    <path d="M12.6 4.6a2.25 2.25 0 1 1 .65 4.4" />
    <path d="M14.4 11.65c1.75.45 2.85 2 2.85 4.1" />
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
    <path d="M10 6.25V4.5" />
    <circle cx="10" cy="3.25" r="1" fill="currentColor" stroke="none" />
    <path d="M7.75 10.25v1.5M12.25 10.25v1.5" />
  </>
));

const GEAR_PATH = 'M8.79 4.38L9 2.57A7.5 7.5 0 0 1 11 2.57L11.21 4.38A5.75 5.75 0 0 1 13.12 5.17L13.12 5.17L14.55 4.04A7.5 7.5 0 0 1 15.96 5.45L14.83 6.88A5.75 5.75 0 0 1 15.62 8.79L15.62 8.79L17.43 9A7.5 7.5 0 0 1 17.43 11L15.62 11.21A5.75 5.75 0 0 1 14.83 13.12L14.83 13.12L15.96 14.55A7.5 7.5 0 0 1 14.55 15.96L13.12 14.83A5.75 5.75 0 0 1 11.21 15.62L11.21 15.62L11 17.43A7.5 7.5 0 0 1 9 17.43L8.79 15.62A5.75 5.75 0 0 1 6.88 14.83L6.88 14.83L5.45 15.96A7.5 7.5 0 0 1 4.04 14.55L5.17 13.12A5.75 5.75 0 0 1 4.38 11.21L4.38 11.21L2.57 11A7.5 7.5 0 0 1 2.57 9L4.38 8.79A5.75 5.75 0 0 1 5.17 6.88L5.17 6.88L4.04 5.45A7.5 7.5 0 0 1 5.45 4.04L6.88 5.17A5.75 5.75 0 0 1 8.79 4.38Z';

export const SettingsIcon = createAppIcon('settings', (
  <>
    <Tint d={GEAR_PATH} />
    <path d={GEAR_PATH} />
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

export const WorkspacesIcon = createAppIcon('workspaces', (
  <>
    <Tint d="M2.75 6.25a2.5 2.5 0 0 1 2.5-2.5h2.6l1.9 2h5a2.5 2.5 0 0 1 2.5 2.5v5.5a2.5 2.5 0 0 1-2.5 2.5h-9.5a2.5 2.5 0 0 1-2.5-2.5z" />
    <path d="M2.75 6.25a2.5 2.5 0 0 1 2.5-2.5h2.6l1.9 2h5a2.5 2.5 0 0 1 2.5 2.5v5.5a2.5 2.5 0 0 1-2.5 2.5h-9.5a2.5 2.5 0 0 1-2.5-2.5z" />
  </>
));

export const ChevronRightIcon = createAppIcon('chevron-right', (
  <path d="M8 5.5l4.5 4.5L8 14.5" />
));

export const PlusIcon = createAppIcon('plus', (
  <path d="M10 4.75v10.5M4.75 10h10.5" />
));

export const MoreIcon = createAppIcon('more', (
  <g fill="currentColor" stroke="none">
    <circle cx="4.75" cy="10" r="1.15" />
    <circle cx="10" cy="10" r="1.15" />
    <circle cx="15.25" cy="10" r="1.15" />
  </g>
));
