"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import Button from "./Button";
import Input from "./Input";
import Modal from "./Modal";
import Toggle from "./Toggle";
import Tooltip from "./Tooltip";
import { USAGE_SUPPORTED_PROVIDERS } from "@/shared/constants/providers";
import { DEFAULT_QUOTA_GUARD, hasQuotaGuardPause, isQuotaGuardPaused } from "@/shared/services/quotaGuard.js";

const pausedModelsLabel = (state) => (state?.pausedModels?.length ? `Paused for ${state.pausedModels.join(", ")} models` : "");

export default function QuotaGuardButton({ connection, compact = false, onUpdated }) {
  const [openAccount, setOpenAccount] = useState(null);
  const [loading, setLoading] = useState(false);
  const enabled = connection.quotaGuard?.enabled === true;
  const paused = isQuotaGuardPaused(connection);
  const held = hasQuotaGuardPause(connection);
  const supported = USAGE_SUPPORTED_PROVIDERS.includes(connection.provider);
  const status = !supported ? "Quota monitoring unavailable for this provider"
    : paused ? `Auto-paused at ${connection.quotaGuardState.remainingPercent ?? "unknown"}% remaining`
    : held ? pausedModelsLabel(connection.quotaGuardState)
    : connection.quotaGuardState?.override ? "Manually resumed until recovery or next confirmed reset"
    : enabled ? `Pause at ${connection.quotaGuard.thresholdPercent}% remaining` : "Configure quota guard";

  async function openDialog() {
    setLoading(true);
    try {
      const response = await fetch(`/api/providers/${encodeURIComponent(connection.id)}`);
      if (!response.ok) throw new Error("Could not read account");
      const result = await response.json();
      setOpenAccount(result.connection);
    } catch { setOpenAccount(connection); }
    finally { setLoading(false); }
  }

  return (
    <>
      <Tooltip text={`${status}. Click to configure.`}>
        <button
          type="button"
          aria-label="Configure quota guard"
          aria-pressed={enabled}
          onClick={openDialog}
          disabled={loading}
          className={`${compact ? "flex h-8 w-8 items-center justify-center rounded-lg" : "flex flex-col items-center rounded px-2 py-1"} transition-colors hover:bg-black/5 dark:hover:bg-white/5 ${held ? "text-amber-500" : enabled ? "text-primary" : "text-text-muted hover:text-primary"}`}
        >
          <span className="material-symbols-outlined text-[18px]">shield</span>
          {!compact && <span className="text-[10px] leading-tight">Quota guard</span>}
        </button>
      </Tooltip>
      {openAccount && createPortal(
        <QuotaGuardDialog connection={openAccount} supported={supported} onClose={() => setOpenAccount(null)} onUpdated={onUpdated} />,
        document.body
      )}
    </>
  );
}

function QuotaGuardDialog({ connection, supported, onClose, onUpdated }) {
  const [account, setAccount] = useState(connection);
  const [enabled, setEnabled] = useState(connection.quotaGuard?.enabled ?? DEFAULT_QUOTA_GUARD.enabled);
  const [threshold, setThreshold] = useState(String(connection.quotaGuard?.thresholdPercent ?? DEFAULT_QUOTA_GUARD.thresholdPercent));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const valid = threshold.trim() !== "" && Number.isFinite(Number(threshold)) && Number(threshold) >= 0 && Number(threshold) < 100;
  const state = account.quotaGuardState;
  const paused = isQuotaGuardPaused(account);
  const held = hasQuotaGuardPause(account);
  const readings = Object.entries({ ...(state?.windows || {}), ...(state?.modelWindows || {}) });

  async function update(action, close = false) {
    setBusy(true);
    setError("");
    try {
      const checking = action === "check";
      const body = action === "save" ? { quotaGuard: { enabled, thresholdPercent: Number(threshold) } } : { isActive: true, quotaGuardResume: true };
      const response = await fetch(`/api/providers/${encodeURIComponent(connection.id)}${checking ? "/quota-guard" : ""}`, {
        method: checking ? "POST" : "PUT",
        headers: { "Content-Type": "application/json" },
        ...(!checking ? { body: JSON.stringify(body) } : {}),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not update quota guard");
      setAccount(result.connection);
      await onUpdated?.(result.connection);
      if (close) onClose();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  return (
    <Modal
      isOpen onClose={onClose} title="Quota guard" size="md"
      footer={<>
        <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button onClick={() => update("save", true)} disabled={busy || !valid || !supported} loading={busy}>Save</Button>
      </>}
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-text-muted">{account.name || account.email || "This account"}</p>
        {!supported ? <p className="text-sm text-text-muted">Quota monitoring unavailable: this provider does not expose usage data.</p> : <>
          <Toggle label="Automatically pause at threshold" checked={enabled} onChange={setEnabled} disabled={busy} />
          <Input
            label="Remaining allowance (%)" aria-label="Remaining allowance (%)" type="number" min="0" max="99.99" step="any"
            value={threshold} onChange={(e) => setThreshold(e.target.value)} disabled={busy || !enabled}
            error={valid ? "" : "Enter a percentage from 0 to less than 100"}
            hint="Pause at or below this percentage; resume when all monitored quotas rise above it."
          />
          <p className="text-xs text-text-muted">Checks run on the server every 60 seconds, even with the dashboard closed. Provider caching may delay updated readings. Manual disables remain disabled.</p>
          <div className="rounded-[10px] bg-surface-2 px-3 py-2.5 text-sm" role="status">
            {account.isActive === false ? "Manually disabled" : paused ? `Auto-paused · ${state.remainingPercent ?? "unknown"}% remaining`
              : state?.override ? "Manually resumed until recovery or next confirmed reset"
              : state?.remainingPercent != null ? `Last reading: ${state.remainingPercent}% remaining` : "No quota reading available"}
            {held && state?.pausedModels?.length > 0 && <p className="mt-1 text-amber-500">{pausedModelsLabel(state)}</p>}
            {readings.length > 0 && <ul className="mt-1 text-xs text-text-muted">
              {readings.map(([name, window]) => (
                <li key={name}>{name}: {Math.round(window.remainingPercent)}% remaining{window.resetAt ? ` · resets ${new Date(window.resetAt).toLocaleString()}` : ""}</li>
              ))}
            </ul>}
            {state?.checkedAt && <p className="mt-1 text-xs text-text-muted">Checked {new Date(state.checkedAt).toLocaleString()}</p>}
            {state?.error && <p className="mt-1 text-xs text-amber-500">{state.error}</p>}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" icon="refresh" disabled={busy} onClick={() => update("check")}>Check usage now</Button>
            {(held || account.isActive === false) && <Button variant="secondary" size="sm" icon="play_arrow" disabled={busy} onClick={() => update("resume")}>Resume now</Button>}
          </div>
          {held && <p className="text-xs text-text-muted">Resume now bypasses the quota threshold until allowance recovers or a reset is confirmed. Provider rate limits still apply.</p>}
        </>}
        {error && <p className="text-sm text-red-500" role="alert">{error}</p>}
      </div>
    </Modal>
  );
}
