/**
 * [Input] Tauri app_update_check/download/install commands and the
 *         app-update-download-progress event; release metadata comes from the
 *         GitHub repo configured in src-tauri/src/app_update.rs.
 * [Output] Settings-tab update card: one auto check on mount (empty state when
 *          the release repo does not exist yet), release notes display,
 *          in-app download with percent progress, then installer launch.
 * [Pos] component node in pc/src, rendered at the bottom of ApiSettings.
 * [Sync] If this file changes, update `pc/src/.folder.md`.
 */

import React, { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Download, LoaderCircle, RefreshCw } from "lucide-react";
import Card from "./shell/Card.jsx";
import { useToast } from "./shell/ToastStack.jsx";
import { useExitProtection } from "./lib/exit-protection.js";

const toneClass = (tone) => (tone ? ` is-${tone}` : "");

export default function AppUpdateCard({ active = true }) {
  const { push } = useToast();
  const [status, setStatus] = useState(null);
  const [checking, setChecking] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [percent, setPercent] = useState(0);
  const [downloadedPath, setDownloadedPath] = useState("");
  useExitProtection(downloading ? "应用更新下载中，请等待完成或取消后再离开设置页" : "");

  const runCheck = useCallback(async ({ announce = false } = {}) => {
    setChecking(true);
    try {
      const next = await invoke("app_update_check");
      setStatus(next);
      if (announce) {
        push({
          tone: next.update_available ? "success" : "info",
          title: next.update_available ? `发现新版本 ${next.latest_version}` : "已是最新版本",
          message: next.update_available ? "可在下方下载并安装。" : `当前版本 ${next.current_version}。`,
        });
      }
    } catch (error) {
      if (announce) {
        push({ tone: "error", title: "检查更新失败", message: String(error) });
      }
    } finally {
      setChecking(false);
    }
  }, [push]);

  // 打开设置页时自动检查一次；web 预览（无 Tauri）保持占位文案。
  useEffect(() => {
    if (!active || !window.__TAURI_INTERNALS__) return;
    runCheck();
  }, [active, runCheck]);

  useEffect(() => {
    let cancelled = false;
    let unlisten = null;
    listen("app-update-download-progress", (event) => {
      if (cancelled || !downloading) return;
      const next = Math.max(0, Math.min(100, Number(event?.payload?.percent) || 0));
      setPercent(next);
    }).then((stop) => {
      if (cancelled) stop();
      else unlisten = stop;
    }).catch((error) => console.warn("[app-update] progress unavailable", error));
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [downloading]);

  const startDownload = useCallback(async () => {
    if (downloading) return;
    setDownloading(true);
    setPercent(0);
    try {
      const path = await invoke("app_update_download");
      setDownloadedPath(path);
      push({ tone: "success", title: "安装包下载完成", message: "点击「立即安装」并按安装器引导完成升级。" });
    } catch (error) {
      push({ tone: "error", title: "下载安装包失败", message: String(error) });
    } finally {
      setDownloading(false);
    }
  }, [downloading, push]);

  const startInstall = useCallback(async () => {
    if (!downloadedPath) return;
    try {
      await invoke("app_update_install", { path: downloadedPath });
      push({
        tone: "success",
        title: "安装程序已启动",
        message: "按安装器引导完成升级；安装期间建议先关闭本应用再继续。",
      });
    } catch (error) {
      push({ tone: "error", title: "无法启动安装", message: String(error) });
    }
  }, [downloadedPath, push]);

  const latest = status?.latest_version || "";
  const updateAvailable = status?.update_available === true;
  const tone = updateAvailable ? "success" : "info";
  const message = checking ? "正在检查更新…"
    : !status ? "尚未检查更新。"
    : !latest ? "暂无发布版本（仓库还没有 Release）。"
    : updateAvailable ? `发现新版本 ${latest}。`
    : `已是最新版本（${latest}）。`;

  return (
    <Card
      title="应用更新"
      subtitle={`当前版本 ${status?.current_version || "…"}；安装包来自 GitHub Releases。`}
      actions={
        <button
          type="button"
          className="btn-ghost btn-sm"
          onClick={() => runCheck({ announce: true })}
          disabled={checking || downloading}
        >
          {checking ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}
          检查更新
        </button>
      }
    >
      <div className={`api-settings__result${toneClass(tone)}`} role="status">
        {message}
      </div>
      {updateAvailable && status.release_notes && (
        <pre className="api-settings__release-notes muted small">{status.release_notes}</pre>
      )}
      {updateAvailable && (
        <div className="api-settings__save-row">
          {downloadedPath ? (
            <button type="button" className="btn-primary btn-sm" onClick={startInstall}>
              <Download size={14} />
              立即安装
            </button>
          ) : (
            <button type="button" className="btn-primary btn-sm" onClick={startDownload} disabled={downloading}>
              {downloading ? <LoaderCircle size={14} className="spin" /> : <Download size={14} />}
              {downloading ? (percent > 0 ? `下载中 ${percent}%` : "下载中…") : "下载并安装"}
            </button>
          )}
          {status.release_url && (
            <button
              type="button"
              className="btn-ghost btn-sm"
              onClick={() => window.open(status.release_url, "_blank", "noopener")}
            >
              前往发布页
            </button>
          )}
        </div>
      )}
    </Card>
  );
}
