import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SpaceIssue } from "@/api/spaceCloud";
import { i18n } from "@/i18n";
import { formatFullTime } from "@/pages/space/spaceUi";
import { IssuesWorkspace } from "./IssuesWorkspace";

const issue: SpaceIssue = {
  id: "issue-1",
  number: 1,
  spaceId: "space-1",
  title: "Updated issue",
  body: "Body",
  state: "todo",
  creator: { id: "user-1", name: "Owner" },
  commentCount: 0,
  createdAt: "2026-06-01T01:00:00.000Z",
  updatedAt: "2026-07-11T09:30:00.000Z",
};

describe("IssuesWorkspace", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en-US");
  });

  it("exposes related-to-me as an independent toggle and renders updatedAt", () => {
    const onRelatedToMeChange = vi.fn();
    render(
      <IssuesWorkspace
        admin={false}
        issues={[issue]}
        issuesLoading={false}
        issueError={null}
        showingPreviousIssues={false}
        hasMore={false}
        issueQ=""
        selectedGoalId=""
        selectedStatus="open,todo,doing"
        relatedToMe={false}
        goalOptions={[{ value: "", label: "All goals" }]}
        activeIssueId={null}
        remoteUpdateAvailable={false}
        onQueryChange={vi.fn()}
        onGoalChange={vi.fn()}
        onStatusChange={vi.fn()}
        onRelatedToMeChange={onRelatedToMeChange}
        onApplyRemoteUpdate={vi.fn().mockResolvedValue(undefined)}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
        onLoadMore={vi.fn().mockResolvedValue(undefined)}
        onCreate={vi.fn()}
        onOpenIssue={vi.fn()}
      />,
    );

    const related = screen.getByRole("button", { name: "Related to me" });
    expect(related).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(related);
    expect(onRelatedToMeChange).toHaveBeenCalledWith(true);
    expect(
      screen.getByTitle(formatFullTime(issue.updatedAt)),
    ).toBeInTheDocument();
    expect(
      screen.queryByTitle(formatFullTime(issue.createdAt)),
    ).not.toBeInTheDocument();
  });

  it("offers one inline refresh action for remote updates", () => {
    const onApplyRemoteUpdate = vi.fn().mockResolvedValue(undefined);
    render(
      <IssuesWorkspace
        admin={false}
        issues={[issue]}
        issuesLoading={false}
        issueError={null}
        showingPreviousIssues={false}
        hasMore={false}
        issueQ=""
        selectedGoalId=""
        selectedStatus="open,todo,doing"
        relatedToMe
        goalOptions={[{ value: "", label: "All goals" }]}
        activeIssueId={null}
        remoteUpdateAvailable
        onQueryChange={vi.fn()}
        onGoalChange={vi.fn()}
        onStatusChange={vi.fn()}
        onRelatedToMeChange={vi.fn()}
        onApplyRemoteUpdate={onApplyRemoteUpdate}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
        onLoadMore={vi.fn().mockResolvedValue(undefined)}
        onCreate={vi.fn()}
        onOpenIssue={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Updates available — refresh" }),
    );
    expect(onApplyRemoteUpdate).toHaveBeenCalledTimes(1);
  });

  it("loads the next cursor page without replacing the visible rows", () => {
    const onLoadMore = vi.fn().mockResolvedValue(undefined);
    render(
      <IssuesWorkspace
        admin={false}
        issues={[issue]}
        issuesLoading={false}
        issueError={null}
        showingPreviousIssues={false}
        hasMore
        issueQ=""
        selectedGoalId=""
        selectedStatus="open,todo,doing"
        relatedToMe={false}
        goalOptions={[{ value: "", label: "All goals" }]}
        activeIssueId={null}
        remoteUpdateAvailable={false}
        onQueryChange={vi.fn()}
        onGoalChange={vi.fn()}
        onStatusChange={vi.fn()}
        onRelatedToMeChange={vi.fn()}
        onApplyRemoteUpdate={vi.fn().mockResolvedValue(undefined)}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
        onLoadMore={onLoadMore}
        onCreate={vi.fn()}
        onOpenIssue={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Load more" }));

    expect(onLoadMore).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Updated issue")).toBeInTheDocument();
  });

  it("keeps prior rows visible and exposes retry when revalidation fails", () => {
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    render(
      <IssuesWorkspace
        admin={false}
        issues={[issue]}
        issuesLoading={false}
        issueError="network down"
        showingPreviousIssues
        hasMore={false}
        issueQ="runtime"
        selectedGoalId=""
        selectedStatus="open,todo,doing"
        relatedToMe={false}
        goalOptions={[{ value: "", label: "All goals" }]}
        activeIssueId={null}
        remoteUpdateAvailable={false}
        onQueryChange={vi.fn()}
        onGoalChange={vi.fn()}
        onStatusChange={vi.fn()}
        onRelatedToMeChange={vi.fn()}
        onApplyRemoteUpdate={vi.fn().mockResolvedValue(undefined)}
        onRefresh={onRefresh}
        onLoadMore={vi.fn().mockResolvedValue(undefined)}
        onCreate={vi.fn()}
        onOpenIssue={vi.fn()}
      />,
    );

    expect(screen.getByText("Updated issue")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The list could not be updated. Try again.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("forgets a prior load-more failure after the store error clears", async () => {
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    const onLoadMore = vi
      .fn()
      .mockRejectedValueOnce(new Error("cursor failed"))
      .mockResolvedValue(undefined);
    const props = {
      admin: false,
      issues: [issue],
      issuesLoading: false,
      issueError: null as string | null,
      showingPreviousIssues: false,
      hasMore: true,
      issueQ: "",
      selectedGoalId: "",
      selectedStatus: "open,todo,doing",
      relatedToMe: false,
      goalOptions: [{ value: "", label: "All goals" }],
      activeIssueId: null,
      remoteUpdateAvailable: false,
      onQueryChange: vi.fn(),
      onGoalChange: vi.fn(),
      onStatusChange: vi.fn(),
      onRelatedToMeChange: vi.fn(),
      onApplyRemoteUpdate: vi.fn().mockResolvedValue(undefined),
      onRefresh,
      onLoadMore,
      onCreate: vi.fn(),
      onOpenIssue: vi.fn(),
    };
    const { rerender } = render(<IssuesWorkspace {...props} />);

    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(onLoadMore).toHaveBeenCalledTimes(1));

    rerender(
      <IssuesWorkspace
        {...props}
        issueError="cursor failed"
        showingPreviousIssues
      />,
    );
    rerender(<IssuesWorkspace {...props} issueError={null} />);
    rerender(
      <IssuesWorkspace
        {...props}
        issueError="ordinary refresh failed"
        showingPreviousIssues
        hasMore={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });
});
