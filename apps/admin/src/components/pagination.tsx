import type { PageInfo, PageQuery } from "@ygo/contracts";
import { strings } from "../strings";

const PAGE_SIZES = [25, 50, 100] as const;

function shownPages(page: number, totalPages: number): number[] {
  const first = Math.max(1, Math.min(page - 2, totalPages - 4));
  const last = Math.min(totalPages, first + 4);
  return Array.from({ length: last - first + 1 }, (_, index) => first + index);
}

/** Controlled page-number navigation for stable Admin lists. */
export function Pagination({ pagination, disabled = false, onChange }: {
  pagination: PageInfo;
  disabled?: boolean;
  onChange: (page: PageQuery) => void;
}) {
  const { page, pageSize, totalRecords } = pagination;
  const totalPages = Math.max(1, Math.ceil(totalRecords / pageSize));
  const firstRecord = totalRecords === 0 ? 0 : (page - 1) * pageSize + 1;
  const lastRecord = Math.min(page * pageSize, totalRecords);

  return <nav aria-label={strings.pagination} className="flex flex-wrap items-center justify-between gap-4 border-t border-border p-3">
    <div className="text-sm text-muted">
      <p>{strings.paginationRange(firstRecord, lastRecord, totalRecords)}</p>
      <p>{strings.paginationPage(page, totalPages)}</p>
    </div>
    <label className="flex items-center gap-2 text-sm text-muted">
      {strings.rowsPerPage}
      <select
        aria-label={strings.rowsPerPage}
        value={pageSize}
        disabled={disabled}
        onChange={(event) => onChange({ page: 1, pageSize: Number(event.target.value) })}
        className="h-10 rounded-lg border border-border bg-surface px-2 text-primary"
      >
        {PAGE_SIZES.map((size) => <option key={size} value={size}>{size}</option>)}
      </select>
    </label>
    <div className="flex items-center gap-1">
      <button
        type="button"
        disabled={disabled || page === 1}
        onClick={() => onChange({ page: page - 1, pageSize })}
        className="rounded-lg border border-border-strong px-3 py-2 text-primary disabled:opacity-50"
      >{strings.previous}</button>
      {shownPages(page, totalPages).map((number) => <button
        key={number}
        type="button"
        aria-current={number === page ? "page" : undefined}
        aria-label={strings.goToPage(number)}
        disabled={disabled || number === page}
        onClick={() => onChange({ page: number, pageSize })}
        className="min-w-10 rounded-lg border border-border-strong px-3 py-2 text-primary disabled:font-semibold disabled:opacity-70"
      >{number}</button>)}
      <button
        type="button"
        disabled={disabled || page === totalPages}
        onClick={() => onChange({ page: page + 1, pageSize })}
        className="rounded-lg border border-border-strong px-3 py-2 text-primary disabled:opacity-50"
      >{strings.next}</button>
    </div>
  </nav>;
}
