import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DeviceRenameDialog } from "./DeviceRenameDialog";

describe("device rename input", () => {
  it("prefills, selects and trims a keyboard submission without submitting IME Enter", async () => {
    const confirm = vi.fn(async () => undefined);
    render(
      <DeviceRenameDialog
        currentName="Device B"
        onConfirm={confirm}
        onCancel={vi.fn()}
      />,
    );
    const input = screen.getByRole("textbox", {
      name: "设备名称",
    }) as HTMLInputElement;
    await waitFor(() => expect(input).toHaveFocus());
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe("Device B".length);
    fireEvent.change(input, { target: { value: "  家里 Windows  " } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    expect(confirm).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(confirm).toHaveBeenCalledWith("家里 Windows"));
  });
  it("rejects blank/control/overlong names and retains text after a save failure", async () => {
    const confirm = vi.fn(async () => {
      throw new Error("连接失败");
    });
    render(
      <DeviceRenameDialog
        currentName="Device B"
        onConfirm={confirm}
        onCancel={vi.fn()}
      />,
    );
    const input = screen.getByRole("textbox"),
      save = screen.getByRole("button", { name: "保存" });
    for (const value of [" ", "\0", "x".repeat(161), "😀".repeat(81)]) {
      fireEvent.change(input, { target: { value } });
      expect(save).toBeDisabled();
    }
    fireEvent.change(input, { target: { value: "办公室 Mac" } });
    fireEvent.click(save);
    expect(await screen.findByRole("alert")).toHaveTextContent("连接失败");
    expect(input).toHaveValue("办公室 Mac");
    expect(save).not.toBeDisabled();
  });
  it("allows Escape cancellation except during composition or a pending write", async () => {
    let finish!: () => void;
    const cancel = vi.fn(),
      confirm = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
    render(
      <DeviceRenameDialog
        currentName="Device B"
        onConfirm={confirm}
        onCancel={cancel}
      />,
    );
    const input = screen.getByRole("textbox");
    fireEvent.keyDown(input, { key: "Escape", isComposing: true });
    expect(cancel).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(cancel).toHaveBeenCalledOnce();
    cancel.mockClear();
    fireEvent.change(input, { target: { value: "新设备" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(confirm).toHaveBeenCalledOnce();
    expect(cancel).not.toHaveBeenCalled();
    finish();
  });
});
