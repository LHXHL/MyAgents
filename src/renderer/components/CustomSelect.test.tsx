import { useEffect } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import CustomSelect from "./CustomSelect";
import ConfirmDialog from "./ConfirmDialog";
import Popover from "./ui/Popover";

function DialogWithSelect({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [onClose]);
  return (
    <CustomSelect
      value="one"
      options={[
        { value: "one", label: "One" },
        { value: "two", label: "Two" },
      ]}
      onChange={vi.fn()}
      ariaLabel="Destination"
    />
  );
}

describe("CustomSelect keyboard ownership", () => {
  it("focuses an accessibility-activated trigger and closes only its menu on Escape", async () => {
    const closeDialog = vi.fn();
    const user = userEvent.setup();
    render(<DialogWithSelect onClose={closeDialog} />);
    const trigger = screen.getByRole("button", { name: "Destination" });
    // fireEvent models AX click, which does not focus like a pointer click.
    fireEvent.click(trigger);
    expect(trigger).toHaveFocus();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Two" })).toBeVisible(),
    );
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("button", { name: "Two" })).toBeNull();
    expect(trigger).toHaveFocus();
    expect(closeDialog).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(closeDialog).toHaveBeenCalledOnce();
  });

  it("does not let an older background popover swallow a confirmation Escape", () => {
    const anchor = document.createElement("button");
    document.body.append(anchor);
    const cancel = vi.fn();
    const view = render(
      <Popover
        open
        anchorRef={{ current: anchor }}
        onClose={vi.fn()}
        zIndex={50}
      >
        History
      </Popover>,
    );
    view.rerender(
      <>
        <Popover
          open
          anchorRef={{ current: anchor }}
          onClose={vi.fn()}
          zIndex={50}
        >
          History
        </Popover>
        <ConfirmDialog
          title="Confirm action"
          message="Review this action"
          onConfirm={vi.fn()}
          onCancel={cancel}
        />
      </>,
    );
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(cancel).toHaveBeenCalledOnce();
    view.unmount();
    anchor.remove();
  });
});
