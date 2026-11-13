// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Pagination } from "./pagination";
import { strings } from "../strings";

afterEach(cleanup);

describe("Admin page-number pagination", () => {
  it("shows the range and numbered page window and emits page navigation", () => {
    const onChange = vi.fn();
    render(<Pagination pagination={{ page: 6, pageSize: 25, totalRecords: 300 }} onChange={onChange} />);
    expect(screen.getByText(strings.paginationRange(126, 150, 300))).toBeTruthy();
    expect(screen.getByText(strings.paginationPage(6, 12))).toBeTruthy();
    expect(screen.getByRole("button", { name: strings.goToPage(4) })).toBeTruthy();
    expect(screen.getByRole("button", { name: strings.goToPage(8) })).toBeTruthy();
    expect(screen.queryByRole("button", { name: strings.goToPage(3) })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: strings.goToPage(8) }));
    fireEvent.click(screen.getByRole("button", { name: strings.previous }));
    fireEvent.click(screen.getByRole("button", { name: strings.next }));
    expect(onChange.mock.calls).toEqual([
      [{ page: 8, pageSize: 25 }],
      [{ page: 5, pageSize: 25 }],
      [{ page: 7, pageSize: 25 }],
    ]);
  });

  it("resets to page 1 when the page size changes", () => {
    const onChange = vi.fn();
    render(<Pagination pagination={{ page: 2, pageSize: 50, totalRecords: 76 }} onChange={onChange} />);
    fireEvent.change(screen.getByRole("combobox", { name: strings.rowsPerPage }), { target: { value: "25" } });
    expect(onChange).toHaveBeenCalledWith({ page: 1, pageSize: 25 });
  });

  it("handles first, last, loading, and empty states", () => {
    const { rerender } = render(<Pagination pagination={{ page: 1, pageSize: 50, totalRecords: 0 }} onChange={vi.fn()} />);
    expect(screen.getByText(strings.paginationRange(0, 0, 0))).toBeTruthy();
    expect(screen.getByRole("button", { name: strings.previous })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: strings.next })).toHaveProperty("disabled", true);

    rerender(<Pagination pagination={{ page: 1, pageSize: 50, totalRecords: 76 }} onChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: strings.previous })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: strings.next })).toHaveProperty("disabled", false);
    rerender(<Pagination pagination={{ page: 2, pageSize: 50, totalRecords: 76 }} onChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: strings.previous })).toHaveProperty("disabled", false);
    expect(screen.getByRole("button", { name: strings.next })).toHaveProperty("disabled", true);

    rerender(<Pagination pagination={{ page: 2, pageSize: 50, totalRecords: 76 }} disabled onChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: strings.previous })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: strings.goToPage(1) })).toHaveProperty("disabled", true);
    expect(screen.getByRole("combobox", { name: strings.rowsPerPage })).toHaveProperty("disabled", true);
  });
});
